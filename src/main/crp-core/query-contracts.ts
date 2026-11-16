import Ajv from "ajv";
import type { BridgeScope } from "../../shared/memory-bridge";
import { validateScope } from "../memory-bridge/safety";
import { CRP_CORE_VERSION, coreFingerprint, type CoreRecord, type RecordRef } from "./core-contracts";

/** Methods are contracts, not advertised runtime capabilities until an adapter implements them. */
export interface CoreQueries {
  open_context: Record<string, never>;
  search: { query: string; limit: number; cursor: string | null };
  read: { ref: RecordRef; offset: number; pageSize: number };
  timeline: { fromDay: number; toDay: number; participants: string[]; limit: number; cursor: string | null };
  related: { ref: RecordRef; relation: "evidence" | "participants" | "versions" | "acquisitions" | "revisions" | "threads"; limit: number; cursor: string | null };
  continuity: { thread: RecordRef | null; limit: number; cursor: string | null };
  coverage: { source: RecordRef; direction: "registered-to-source" | "source-to-registered"; limit: number; cursor: string | null };
  explain: { receiptId: string };
}
export type CoreMethod = keyof CoreQueries;
export type CoreQuery = { [M in CoreMethod]: { method: M; input: CoreQueries[M] } }[CoreMethod];
export type CoreQueryStatus = "ok" | "unknown" | "insufficient_evidence" | "missing_source" | "unregistered" | "not_ready" | "denied" | "cancelled" | "error";
export interface CoreReadContext {
  contract: typeof CRP_CORE_VERSION; snapshotId: string; sourceManifestSha256: string;
  indexIdentity: string; policyFingerprint: string; scopes: readonly BridgeScope[];
}
export interface CoreQueryReceipt {
  id: string; contextFingerprint: string; method: CoreMethod; queryFingerprint: string;
  sourceChecks: Array<{ path: string; sha256: string; verified: boolean }>;
  gaps: string[]; modelCalls: number;
}
export interface CoreQueryResponse {
  status: CoreQueryStatus; contextFingerprint: string; receipt: CoreQueryReceipt;
  records: CoreRecord[]; nextCursor: string | null;
  contentPage?: { text: string; offset: number; nextOffset: number | null; kind: "verbatim" | "record-json" };
  /** Returned by open_context; never infer support from the contract's method list. */
  capabilities?: CoreMethod[];
}
export interface CoreQueryAdapter {
  execute(context: CoreReadContext, query: CoreQuery, signal?: AbortSignal): Promise<CoreQueryResponse>;
}
const object = (properties: Record<string, object>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const id = { type: "string", minLength: 1, maxLength: 300 };
const ref = object({ id, revision: { type: "integer", minimum: 1 } });
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const paging = { limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: nullable({ type: "string", minLength: 1, maxLength: 4096 }) };
const inputs: Record<CoreMethod, object> = {
  open_context: object({}),
  search: object({ query: { type: "string", minLength: 1, maxLength: 2000 }, ...paging }),
  read: object({ ref, offset: { type: "integer", minimum: 0 }, pageSize: { type: "integer", minimum: 1, maximum: 2400 } }),
  timeline: object({ fromDay: { type: "integer", minimum: 0 }, toDay: { type: "integer", minimum: 0 }, participants: { type: "array", maxItems: 32, items: id }, ...paging }),
  related: object({ ref, relation: { enum: ["evidence", "participants", "versions", "acquisitions", "revisions", "threads"] }, ...paging }),
  continuity: object({ thread: nullable(ref), ...paging }),
  coverage: object({ source: ref, direction: { enum: ["registered-to-source", "source-to-registered"] }, ...paging }),
  explain: object({ receiptId: id }),
};
export const CORE_QUERY_SCHEMA = { oneOf: Object.entries(inputs).map(([method, input]) => object({ method: { const: method }, input })) };
const validate = new Ajv({ strict: true }).compile(CORE_QUERY_SCHEMA);
export function parseCoreQuery(input: unknown): CoreQuery {
  if (!validate(input)) throw new Error("CRP_QUERY_SCHEMA");
  const query = structuredClone(input) as CoreQuery;
  if (query.method === "timeline" && query.input.toDay < query.input.fromDay || query.method === "search" && !query.input.query.trim()) throw new Error("CRP_QUERY_RANGE");
  return query;
}
/** Host-only construction: queries cannot supply a reality, character, permission or source version. */
export function bindCoreContext(input: Omit<CoreReadContext, "contract">): Readonly<CoreReadContext> {
  if (!input.snapshotId || !input.indexIdentity || !input.policyFingerprint || !/^[a-f0-9]{64}$/.test(input.sourceManifestSha256)
    || !input.scopes.length || input.scopes.length > 32) throw new Error("CRP_CONTEXT_SCHEMA");
  const scopes = input.scopes.map(scope => {
    const s = validateScope(scope); if (s.asOf) Object.freeze(s.asOf); return Object.freeze(s);
  });
  return Object.freeze({ ...input, contract: CRP_CORE_VERSION, scopes: Object.freeze(scopes) });
}
export function assertCoreContext(context: CoreReadContext, expectedFingerprint: string): void {
  if (coreFingerprint(context) !== expectedFingerprint) throw new Error("CRP_CONTEXT_CHANGED");
}
