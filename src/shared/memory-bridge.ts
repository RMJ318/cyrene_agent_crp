/** Shared wire contracts. Scope is issued by the host, never by model arguments. */
export type BridgeDomain = "rp" | "writer" | "reality0";
export interface StoryTime { day: number; clock?: string; not_after?: string; precision?: string; label?: string }
export interface BridgeScope {
  domain: BridgeDomain;
  realityId: string;
  branchId: string | null;
  audience: "archive-reference" | "character-knowledge";
  characterId?: string;
  asOf?: StoryTime;
}
export interface BridgeSource {
  path: string; sha256: string; evidenceId?: string; lineStart?: number; lineEnd?: number;
  excerptSha256?: string;
}
export interface BridgeMemory {
  memoryId: string; domain: BridgeDomain; realityId: string; branchId: string | null;
  participants: string[]; eventTime: StoryTime | string | null; acquiredAt: StoryTime | null;
  acquisitionChannel: string | null; source: BridgeSource[]; evidenceType: string;
  sourceVerification: string; occurrenceVerdict: string; fullAuditStatus: string;
  epistemicStatus: string; content: string; contentKind: "summary" | "verbatim" | "user_statement";
  truncated: boolean; access: { audience: BridgeScope["audience"]; characterId?: string };
  contentOffset?: number; nextOffset?: number;
}
export interface BridgeResult { status: "ok" | "unknown" | "insufficient_evidence"; memories: BridgeMemory[]; gaps: string[]; snapshotId?: string }
export interface LocalMemoryInput {
  content: string; participants: string[]; sensitive: boolean; eventTime?: string;
}
export interface LocalMemoryRecord extends LocalMemoryInput {
  id: string; domain: "writer" | "reality0"; revision: number; deleted: boolean; createdAt: string;
}
export interface BridgeStatus { retrievalV3Enabled?: boolean; localModelsDisabled?: boolean; githubSource?: { repository: string; commit: string }; enabled: boolean; configuredEnabled?: boolean; pluginActive?: boolean; localSemanticEnabled?: boolean; snapshotId?: string; sessions: Array<{ id: string; scope: BridgeScope; active: boolean }>; paidBudgetUsd: 0 }
export interface ContinuityMapping {
  id: string; snapshotId: string; path: string; sha256: string; scope: BridgeScope;
  content: string; participants: string[];
}
export interface MemoryBridgeApi {
  request(command: string, input?: Record<string, unknown>): Promise<unknown>;
}
export interface RealityRecallState {
  realities: string[];
  available: string[];
  enabled: boolean;
  dedicated: boolean;
}
export const MEMORY_BRIDGE_IPC = "memory-bridge:manage";
