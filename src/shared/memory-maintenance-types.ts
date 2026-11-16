export interface MemoryMaintenanceResult {
  ok: boolean;
  processedTurns: number;
  failedConversations: number;
  reason?: "memory_disabled" | "judge_failed" | "organization_failed";
}
