import { allowsLegacyMemory } from "../memory-bridge/policy";
import { app } from "electron"
import { getConversationDatabase } from "../storage/conversation-database-client"
import type { MemoryPendingStore } from "./memory-pending-types"

// Lazy: importing the scheduler must not open a production database (including tests).
export const memoryPendingTurns: MemoryPendingStore = {
  record: (turn, legacyCount) => !allowsLegacyMemory(turn.conversationId) ? Promise.resolve({ roundCount: legacyCount, added: false }) : getConversationDatabase(app.getPath("userData")).call("memory.record", turn, legacyCount),
  batch: (conversationId, throughSeq, allowPartial) => !allowsLegacyMemory(conversationId) ? Promise.resolve(null) : getConversationDatabase(app.getPath("userData")).call("memory.batch", conversationId, throughSeq, allowPartial),
  listPending: () => getConversationDatabase(app.getPath("userData")).call("memory.listPending"),
  current: turns => turns.some(turn => !allowsLegacyMemory(turn.conversationId)) ? Promise.resolve(false) : getConversationDatabase(app.getPath("userData")).call("memory.current", turns),
  consume: batch => getConversationDatabase(app.getPath("userData")).call("memory.consume", batch),
  count: () => getConversationDatabase(app.getPath("userData")).call("memory.count"),
}
