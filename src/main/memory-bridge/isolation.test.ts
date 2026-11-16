import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bridgePolicy } from "./policy";
import { setMemoryMode } from "../memory/memory-mode";
import { MemoryScheduler } from "../memory/memory-scheduler";
import { SummaryMemoryScheduler } from "../memory/summary-memory-scheduler";
import { WikiMemoryScheduler } from "../memory/wiki-memory-scheduler";
import { createWikiChatSourceReader } from "../memory/wiki-source";
import { createSocialContextScheduler } from "../social-context/scheduler";
import { parsePythonJson, pythonJson } from "./safety";
import { boundBridgeResult } from "./result-budget";
import { estimateTokens } from "../orchestrator/token-estimate";

vi.mock("../llm-queue", () => ({ enqueueLLMTask: vi.fn() }));
vi.mock("../memory/memory-compressor", () => ({ runMemoryCompression: vi.fn(), runReflectionAndCompression: vi.fn() }));
vi.mock("../memory/entity-graph", () => ({ entityGraph: {} }));
vi.mock("../memory/memory-judge", () => ({ memoryJudge: {} }));
vi.mock("../memory/memory-manager", () => ({ memoryManager: {} }));
vi.mock("../memory/memory-resolver", () => ({ runResolverQueueOnce: vi.fn() }));
vi.mock("../memory/memory-store", () => ({ memoryStore: {} }));
vi.mock("../memory/memory-pending-turns", () => ({ memoryPendingTurns: {} }));
vi.mock("../memory/summary-memory-llm", () => ({ summarizeMemory: vi.fn(() => { throw new Error("must not call models"); }) }));
vi.mock("../memory/wiki-memory-llm", () => ({ extractWikiClaims: vi.fn(() => { throw new Error("must not call models"); }) }));
vi.mock("../memory/wiki-store", () => ({ WikiStore: class { async close() {} } }));

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-isolation-")); bridgePolicy.initialize(root); });
afterEach(() => { setMemoryMode("vector"); bridgePolicy.initialize(path.join(root, "cleared")); fs.rmSync(root, { recursive: true, force: true }); });
function protect() { bridgePolicy.bindNew("protected", { domain: "writer", realityId: "-1", branchId: null, audience: "archive-reference" }); }

it("pending PMRS work and manual maintenance cannot extract protected turns even after plugin disable", async () => {
  const queued: Array<() => Promise<unknown>> = [];
  const deps: any = {
    enqueueTask: vi.fn((_label, work) => { queued.push(work); return Promise.resolve(); }),
    getL1: async () => ({ roundCount: 0 }), replaceL1Field: vi.fn(),
    pending: { record: vi.fn(async () => ({ added: true, roundCount: 1, seq: 1 })), batch: vi.fn(), listPending: async () => [{ conversationId: "protected", throughSeq: 1 }], current: vi.fn(), count: async () => 1 },
    judgeMemory: vi.fn(), writeMemory: vi.fn(), ingestEntities: vi.fn(), organizeMemory: vi.fn(),
  };
  const scheduler = new MemoryScheduler(deps); setMemoryMode("vector");
  await scheduler.scheduleMemoryWrite("fictional input", "fictional output", "protected", { userTurnId: "u", assistantEntryId: "a" });
  protect(); await queued.shift()!();
  expect(deps.pending.batch).not.toHaveBeenCalled(); expect(deps.judgeMemory).not.toHaveBeenCalled();
  await scheduler.scheduleMemoryWrite("new", "new", "protected", { userTurnId: "u2", assistantEntryId: "a2" });
  expect(deps.pending.record).toHaveBeenCalledTimes(1);
  const maintenance = scheduler.organizeNow(); await Promise.resolve(); await Promise.resolve();
  await queued.shift()!(); await maintenance;
  expect(deps.pending.batch).not.toHaveBeenCalled(); expect(deps.judgeMemory).not.toHaveBeenCalled();
});

it("Summary, Wiki backfill and the source reader stop before reading protected text", async () => {
  protect();
  const reader = { getSessionRecord: vi.fn(), appendSummaryMemoryTurn: vi.fn(), listSessions: async () => [{ id: "protected" }], getSummaryMemoryProgress: vi.fn(), markSummaryMemoryProcessed: vi.fn() };
  const summary = new SummaryMemoryScheduler({ userDataRoot: root, sessions: reader });
  setMemoryMode("summary"); summary.setEnabled(true);
  await summary.scheduleSummaryTurn({ conversationId: "protected", assistantEntryId: "a", userText: "secret", assistantText: "secret" });
  await summary.flushAll(); expect(reader.getSessionRecord).not.toHaveBeenCalled(); expect(reader.appendSummaryMemoryTurn).not.toHaveBeenCalled(); summary.dispose();
  const sourceReader = { listConversationIds: vi.fn(async () => ["protected"]), readConversation: vi.fn() };
  const wiki = new WikiMemoryScheduler({ userDataRoot: root, sourceReader: sourceReader as any });
  setMemoryMode("wiki"); await wiki.setEnabled(true); await wiki.flushAll(); await wiki.flushConversation("protected", true);
  expect(sourceReader.readConversation).not.toHaveBeenCalled(); await wiki.setEnabled(false);
  const transcripts = { readAuditEntries: vi.fn() };
  const source = createWikiChatSourceReader({ transcriptStore: transcripts as any, listSessions: async () => [{ id: "protected", mode: "chat" }], ensureConversationMigrated: vi.fn() });
  expect(await source.listConversationIds()).toEqual([]); expect(await source.readConversation("protected")).toBeNull(); expect(transcripts.readAuditEntries).not.toHaveBeenCalled();
});

it("social extraction rechecks authorization when queued work starts", async () => {
  const pending: Array<() => Promise<void>> = [];
  const generate = vi.fn(), store = { applyOperations: vi.fn() };
  const scheduler = createSocialContextScheduler({ generate, store: store as any, enqueue: async (_label, work) => { pending.push(work); } });
  scheduler.schedule({ conversationId: "protected", userTurn: { id: "u", role: "user", text: "fiction" }, assistantTurn: { id: "a", role: "assistant", text: "fiction" }, retrievedAtoms: [], now: 1 });
  protect(); await pending.shift()!(); expect(generate).not.toHaveBeenCalled(); expect(store.applyOperations).not.toHaveBeenCalled();
});

it("matches Python audit encoding including float type, exponents, unicode and nesting", () => {
  const input = parsePythonJson('{"unicode":"河😀","nested":[1,1.0,-0.0,1e-7,1e16],"a":true}');
  expect(pythonJson(input)).toBe('{\n  "a": true,\n  "nested": [\n    1,\n    1.0,\n    -0.0,\n    1e-07,\n    1e+16\n  ],\n  "unicode": "河😀"\n}\n');
});

it("bounds provenance plus content and keeps Unicode pagination usable", () => {
  const memory: any = { memoryId: "work_version:test", source: [{ path: "a", sha256: "f".repeat(64) }], content: "😀河".repeat(10000), contentKind: "verbatim", contentOffset: 100, truncated: false };
  const output = boundBridgeResult({ status: "ok", memories: [memory], gaps: [] });
  expect(estimateTokens(JSON.stringify(output))).toBeLessThanOrEqual(2000);
  expect(output.memories[0].nextOffset).toBe(100 + Array.from(output.memories[0].content).length);
  expect(output.memories[0].source).toEqual(memory.source);
  expect(output.memories[0].content).not.toMatch(/[\uD800-\uDBFF]$/);
});
