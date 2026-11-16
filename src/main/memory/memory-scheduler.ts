import { allowsLegacyMemory } from "../memory-bridge/policy";
import { enqueueLLMTask } from "../llm-queue"
import type { MemoryMaintenanceResult } from "../../shared/memory-maintenance-types"
import { runMemoryCompression, runReflectionAndCompression } from "./memory-compressor"
import { entityGraph } from "./entity-graph"
import type { ExtractedEntity } from "./entity-graph"
import { memoryJudge } from "./memory-judge"
import { memoryManager } from "./memory-manager"
import { runResolverQueueOnce } from "./memory-resolver"
import { memoryStore } from "./memory-store"
import type { MemoryJudgeResult } from "./memory-schemas"
import type { L1Profile, MemoryCandidate, MemoryJudgeTurn } from "./memory-types"
import { isMemoryEnabled } from "./memory-mode"
import { memoryPendingTurns } from "./memory-pending-turns"
import type { MemoryPendingStore, MemoryTurnSource, PendingMemoryBatch } from "./memory-pending-types"

export interface MemorySchedulerDeps {
  enqueueTask: <T>(label: string, task: () => Promise<T>) => Promise<T>
  judgeMemory: (turns: MemoryJudgeTurn[], conversationId: string) => Promise<MemoryJudgeResult>
  writeMemory: (candidates: MemoryCandidate[], assertSourceCurrent: () => Promise<void>) => Promise<void>
  pending: MemoryPendingStore
  /** 把 judge 顺手抽取的命名实体入库（零额外 LLM 调用） */
  ingestEntities: (entities: ExtractedEntity[]) => void
  getL1: () => Promise<L1Profile>
  replaceL1Field: (field: "roundCount", value: number) => Promise<void>
  runReflectionAndCompression: () => Promise<void>
  organizeMemory: () => Promise<void>
  runResolverQueueOnce: () => Promise<unknown>
  runDecay: () => Promise<void>
}

export class MemoryScheduler {
  private persistence = Promise.resolve()
  private manualRun?: Promise<MemoryMaintenanceResult>

  constructor(private readonly deps: MemorySchedulerDeps) {}

  async scheduleMemoryWrite(userInput: string, assistantReply: string, conversationId?: string, source?: MemoryTurnSource): Promise<void> {
    if (!isMemoryEnabled() || !allowsLegacyMemory(conversationId)) return;
    if (!conversationId || !source?.userTurnId || !source.assistantEntryId) {
      console.warn("[PMRS/Scheduler] 缺少消息来源，跳过无法校验的记忆轮次")
      return
    }
    // Persist outside the LLM queue: a busy judge must not delay durability of new replies.
    this.persistence = this.persistence.then(async () => {
      if (!isMemoryEnabled() || !allowsLegacyMemory(conversationId)) return
      const l1 = await this.deps.getL1()
      const recorded = await this.deps.pending.record({ userInput, assistantReply, conversationId, ...source }, l1.roundCount || 0)
      void this.deps.enqueueTask("MemoryMaintenance", () => this.runQueuedMemoryWrite(conversationId, recorded))
        .catch(e => console.error("[PMRS/Scheduler] 记忆维护失败", e))
    }).catch((e) => {
      console.error("[PMRS/Scheduler] 记忆写入失败，不影响主流程", e)
    })
    await this.persistence
  }

  /** Coalesce clicks across windows and serialize with automatic maintenance. */
  organizeNow(): Promise<MemoryMaintenanceResult> {
    if (this.manualRun) return this.manualRun
    const run = this.persistence.then(() => this.deps.enqueueTask("MemoryMaintenanceManual", async () => {
      const result: MemoryMaintenanceResult = { ok: false, processedTurns: 0, failedConversations: 0 }
      if (!isMemoryEnabled()) return { ...result, reason: "memory_disabled" as const }
      // A fixed upper boundary prevents new chat replies from extending this run forever.
      const targets = await this.deps.pending.listPending()
      for (const target of targets) {
        if (!allowsLegacyMemory(target.conversationId)) continue;
        try {
          while (true) {
            if (!isMemoryEnabled()) return { ...result, reason: "memory_disabled" as const }
            const batch = await this.deps.pending.batch(target.conversationId, target.throughSeq, true)
            if (!batch) break
            await this.processBatch(batch)
            result.processedTurns += batch.pending.length
          }
        } catch {
          // Do not expose raw errors or conversation contents to the renderer.
          result.failedConversations++
        }
      }
      if (!isMemoryEnabled()) return { ...result, reason: "memory_disabled" as const }
      if (result.failedConversations) return { ...result, reason: "judge_failed" as const }
      try {
        await this.deps.organizeMemory()
        if (!isMemoryEnabled()) return { ...result, reason: "memory_disabled" as const }
        return { ...result, ok: true }
      } catch {
        return { ...result, reason: "organization_failed" as const }
      }
    }))
    this.manualRun = run
    void run.finally(() => { if (this.manualRun === run) this.manualRun = undefined }).catch(() => {})
    return run
  }

  private async processBatch(batch: PendingMemoryBatch): Promise<void> {
    const assertSourceCurrent = async () => {
      if (!isMemoryEnabled() || batch.turns.some(turn => !allowsLegacyMemory(turn.conversationId)) || !await this.deps.pending.current(batch.turns)) throw new Error("MEMORY_SOURCE_CHANGED")
    }
    await assertSourceCurrent()
    const turns = batch.turns.map(({ userInput, assistantReply }) => ({ userInput, assistantReply }))
    const { candidates, entities } = await this.deps.judgeMemory(turns, batch.pending[0].conversationId)
    await assertSourceCurrent()
    if (candidates.length > 0) await this.deps.writeMemory(candidates, assertSourceCurrent)
    await assertSourceCurrent()
    if (entities.length > 0) this.deps.ingestEntities(entities)
    if (!await this.deps.pending.consume(batch)) throw new Error("MEMORY_SOURCE_CHANGED")
  }

  private async runQueuedMemoryWrite(conversationId: string, recorded: { roundCount: number; added: boolean; seq?: number }): Promise<void> {
    if (!isMemoryEnabled() || !allowsLegacyMemory(conversationId)) return;
    let judgeFailure: unknown;
    // Six pending live user turns per conversation, plus two processed context turns.
    while (recorded.seq !== undefined && isMemoryEnabled()) {
      const batch = await this.deps.pending.batch(conversationId, recorded.seq)
      if (!batch) break
      try {
        await this.processBatch(batch)
      } catch (err) {
        console.error("[PMRS/Scheduler] Judge/Manager 失败或来源失效，保留有效待处理轮次", err)
        judgeFailure = err
        break
      }
    }
    // Regeneration/replayed completions must not repeat periodic maintenance.
    const newCount = await this.deps.pending.count()
    await this.deps.replaceL1Field("roundCount", newCount)
    if (judgeFailure !== undefined) throw judgeFailure
    if (!recorded.added || newCount < recorded.roundCount) return
    const maintenanceCount = recorded.roundCount
    if (maintenanceCount % 5 === 0) {
      if (!isMemoryEnabled()) return;
      try {
        await this.deps.runResolverQueueOnce()
      } catch (err) {
        console.warn("[PMRS/Scheduler] Resolver 队列处理失败，不影响主流程", err)
      }
    }

    if (maintenanceCount % 20 === 0) {
      if (!isMemoryEnabled()) return;
      console.log("[PMRS/Scheduler] 达到 20 轮，触发回顾 + 片段压缩")
      await this.deps.runReflectionAndCompression()
    }

    if (maintenanceCount % 50 === 0) {
      if (!isMemoryEnabled()) return;
      try {
        await this.deps.runDecay()
      } catch (err) {
        console.warn("[PMRS/Scheduler] L2 权重衰减失败，不影响主流程", err)
      }
    }
  }
}

export const memoryScheduler = new MemoryScheduler({
  enqueueTask: enqueueLLMTask,
  judgeMemory: (turns, conversationId) => memoryJudge.judgeRecentTurns(turns, conversationId),
  writeMemory: (candidates, assertSourceCurrent) => memoryManager.writeMemory(candidates, assertSourceCurrent),
  pending: memoryPendingTurns,
  ingestEntities: (entities) => entityGraph.ingestEntities(entities),
  getL1: () => memoryStore.getL1(),
  replaceL1Field: (field, value) => memoryStore.replaceL1Field(field, value),
  runReflectionAndCompression,
  organizeMemory: () => runMemoryCompression({ strict: true, assertCurrent: () => {
    if (!isMemoryEnabled()) throw new Error("MEMORY_DISABLED")
  } }),
  runResolverQueueOnce,
  runDecay: () => memoryManager.runDecay(),
})
