import type { MemoryJudgeTurn } from "./memory-types"

export interface MemoryTurnSource {
  userTurnId: string
  assistantEntryId: string
}

export interface PendingMemoryTurn extends MemoryJudgeTurn, MemoryTurnSource {
  conversationId: string
  userEntryId: string
  seq: number
}

export interface PendingMemoryBatch {
  turns: PendingMemoryTurn[]
  pending: PendingMemoryTurn[]
}

export interface MemoryPendingStore {
  record(turn: MemoryJudgeTurn & MemoryTurnSource & { conversationId: string }, legacyCount: number): Promise<{ roundCount: number; added: boolean; seq?: number }>
  batch(conversationId: string, throughSeq?: number, allowPartial?: boolean): Promise<PendingMemoryBatch | null>
  listPending(): Promise<Array<{ conversationId: string; throughSeq: number }>>
  current(turns: PendingMemoryTurn[]): Promise<boolean>
  consume(batch: PendingMemoryBatch): Promise<boolean>
  count(): Promise<number>
}
