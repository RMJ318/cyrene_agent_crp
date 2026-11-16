import type { BridgeMemory, BridgeScope } from "../../shared/memory-bridge";

/** Runtime projections are disposable; source records and historical assessments remain authoritative. */
export const CRP_CONTRACT_VERSION = "3.0-preview.1";
export interface CrpQueryContext {
  snapshotId: string;
  policyFingerprint: string;
  scopes: readonly BridgeScope[];
}
export interface CrpDocument {
  id: string;
  memory: BridgeMemory;
  text: string;
}
export interface CrpAlias { text: string; entityId: string; realityId: string }
export type ModelCapability = "embedding" | "query-rewrite" | "rerank" | "archive-extract" | "audit-assist";
export type ModelProvider = "local" | "openai" | "openrouter" | "session";
export interface ModelRoute {
  provider: ModelProvider;
  model: string;
  /** Stable provider/deployment/weights/tokenizer/pooling/dimension identity, never a key. */
  identity: string;
}
export interface CrpModelPolicy {
  localAllowed: boolean;
  cloudAllowed: boolean;
  sessionAllowed: boolean;
  budgetUsd: number;
  routes: Partial<Record<ModelCapability, ModelRoute>>;
}
export const NO_MODEL_POLICY: CrpModelPolicy = {
  localAllowed: false, cloudAllowed: false, sessionAllowed: false, budgetUsd: 0, routes: {},
};
export interface CrpRetrievalTrace {
  contract: typeof CRP_CONTRACT_VERSION;
  documents: number;
  lexicalHits: number;
  semanticHits: number;
  mode: "lexical" | "hybrid";
  degraded: boolean;
  supplementalSearches?: 0 | 1;
  exactHits?: number;
  rerank?: "disabled" | "applied" | "degraded";
  referenceUsed?: boolean;
}
