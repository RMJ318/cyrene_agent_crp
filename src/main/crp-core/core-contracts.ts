import Ajv from "ajv";
import { hash } from "../memory-bridge/safety";

/** Draft authority contract. Defining/validating it never publishes or upgrades legacy records. */
export const CRP_CORE_VERSION = "3.0-draft.2";
export type CoreNamespace = "rp" | "ooc" | "unknown" | "writer";
export interface RecordRef { id: string; revision: number }
export interface LegacyRef { path: string; sha256: string; pointer: string }
export interface CoreTime { day: number; clock: string | null; precision: "day" | "minute" | "bound"; notAfter: string | null }
export interface CoreCoordinates { realityId: string | null; branchId: string | null }
export type SourceRange = { unit: "line"; start: number; end: number } | { unit: "codepoint"; start: number; end: number };
interface CoreBase {
  contract: typeof CRP_CORE_VERSION; id: string; revision: number; namespace: CoreNamespace;
  coordinates: CoreCoordinates; provenance: LegacyRef[];
}
export interface CorePayloads {
  source: { path: string; sha256: string; byteLength: number; encoding: "utf-8" | "opaque"; media: "transcript" | "work" | "audit" | "other" };
  evidence: { source: RecordRef; range: SourceRange; excerptSha256: string };
  entity: { name: string; aliases: string[]; identityLinks: RecordRef[] };
  event: { title: string; participants: RecordRef[]; occurredAt: CoreTime | null; evidence: RecordRef[] };
  claim: { subject: RecordRef; predicate: string; value: unknown; epistemicStatus: "asserted" | "inferred" | "disputed" | "unknown"; evidence: RecordRef[] };
  work: { title: string; authors: RecordRef[]; currentVersion: RecordRef | null };
  "work-version": { work: RecordRef; source: RecordRef; evidence: RecordRef[]; supersedes: RecordRef | null; state: "draft" | "published" | "withdrawn" | "unknown";
    components?: Array<{ source: RecordRef; range: SourceRange | null }>; joiner?: string | null; contentSha256?: string };
  acquisition: { character: RecordRef; object: RecordRef; acquiredAt: CoreTime | null; channels: string[];
    extent: "received" | "title" | "hearsay" | "excerpt" | "full"; evidence: RecordRef[]; assessment: RecordRef | null };
  revision: { before: RecordRef; after: RecordRef | null; operation: "amend" | "supersede" | "retract"; effectiveAt: CoreTime | null; evidence: RecordRef[] };
  thread: { title: string; state: "active" | "dormant" | "closed" | "unknown"; anchors: RecordRef[]; lastVerifiedAt: CoreTime | null };
  case: { question: string; state: "open" | "resolved" | "unknown"; related: RecordRef[]; evidence: RecordRef[] };
  assessment: { subject: RecordRef; dimension: "fidelity" | "occurrence" | "knowledge" | "full-audit" | "source-coverage";
    verdict: "PASS" | "FAIL" | "INSUFFICIENT_EVIDENCE" | "UNKNOWN" | "NOT_REVIEWED";
    authority: "legacy-reference" | "reviewed"; basisFingerprint: string; algorithm: string; evidence: RecordRef[]; legacy: LegacyRef | null };
  coverage: { source: RecordRef; range: SourceRange; direction: "registered-to-source" | "source-to-registered";
    state: "read" | "reviewed" | "gap" | "unknown"; checks: string[]; assessments: RecordRef[] };
}
export type CoreKind = keyof CorePayloads;
export type CoreRecord<K extends CoreKind = CoreKind> = { [P in K]: CoreBase & { kind: P; data: CorePayloads[P] } }[K];

const str = { type: "string", minLength: 1, maxLength: 12000 };
const sha = { type: "string", pattern: "^[a-f0-9]{64}$" };
const id = { type: "string", minLength: 1, maxLength: 300 };
const positive = { type: "integer", minimum: 1 };
const list = (items: object) => ({ type: "array", items, maxItems: 20000 });
const choice = (...values: string[]) => ({ type: "string", enum: values });
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const object = (properties: Record<string, object>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const ref = object({ id, revision: positive });
const refs = list(ref);
const legacy = object({ path: str, sha256: sha, pointer: { type: "string", maxLength: 2000 } });
const time = nullable(object({ day: { type: "integer", minimum: 0 }, clock: nullable({ type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }),
  precision: choice("day", "minute", "bound"), notAfter: nullable({ type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }) }));
const range = object({ unit: choice("line", "codepoint"), start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 } });
const evidence = { evidence: refs };
const payloads: Record<CoreKind, object> = {
  source: object({ path: str, sha256: sha, byteLength: { type: "integer", minimum: 0 }, encoding: choice("utf-8", "opaque"), media: choice("transcript", "work", "audit", "other") }),
  evidence: object({ source: ref, range, excerptSha256: sha }),
  entity: object({ name: str, aliases: list(str), identityLinks: refs }),
  event: object({ title: str, participants: refs, occurredAt: time, ...evidence }),
  claim: object({ subject: ref, predicate: str, value: {}, epistemicStatus: choice("asserted", "inferred", "disputed", "unknown"), ...evidence }),
  work: object({ title: str, authors: refs, currentVersion: nullable(ref) }),
  "work-version": { ...object({ work: ref, source: ref, ...evidence, supersedes: nullable(ref), state: choice("draft", "published", "withdrawn", "unknown") }),
    properties: { work: ref, source: ref, ...evidence, supersedes: nullable(ref), state: choice("draft", "published", "withdrawn", "unknown"),
      components: { ...list(object({ source: ref, range: nullable(range) })), minItems: 1 }, joiner: nullable({ type: "string", maxLength: 128 }), contentSha256: sha } },
  acquisition: object({ character: ref, object: ref, acquiredAt: time, channels: list(str), extent: choice("received", "title", "hearsay", "excerpt", "full"), ...evidence, assessment: nullable(ref) }),
  revision: object({ before: ref, after: nullable(ref), operation: choice("amend", "supersede", "retract"), effectiveAt: time, ...evidence }),
  thread: object({ title: str, state: choice("active", "dormant", "closed", "unknown"), anchors: refs, lastVerifiedAt: time }),
  case: object({ question: str, state: choice("open", "resolved", "unknown"), related: refs, ...evidence }),
  assessment: object({ subject: ref, dimension: choice("fidelity", "occurrence", "knowledge", "full-audit", "source-coverage"),
    verdict: choice("PASS", "FAIL", "INSUFFICIENT_EVIDENCE", "UNKNOWN", "NOT_REVIEWED"), authority: choice("legacy-reference", "reviewed"),
    basisFingerprint: sha, algorithm: str, ...evidence, legacy: nullable(legacy) }),
  coverage: object({ source: ref, range, direction: choice("registered-to-source", "source-to-registered"), state: choice("read", "reviewed", "gap", "unknown"), checks: list(str), assessments: refs }),
};
export const CORE_RECORD_SCHEMA = { $id: "urn:crp:core:3.0-draft.2", oneOf: Object.entries(payloads).map(([kind, data]) => object({
  contract: { const: CRP_CORE_VERSION }, id, revision: positive, namespace: choice("rp", "ooc", "unknown", "writer"),
  coordinates: object({ realityId: nullable({ type: "string", pattern: "^-?[0-9]+$" }), branchId: nullable(id) }),
  provenance: list(legacy), kind: { const: kind }, data,
})) };
const ajv = new Ajv({ strict: true, allErrors: false });
const validateRecord = ajv.compile(CORE_RECORD_SCHEMA);
const invalid = (reason: string): never => { throw new Error(`CRP_CORE_${reason}`); };

/** Unknown values must remain null/unknown. Paths are archive-relative, never executable instructions. */
function safeRelative(value: string): boolean {
  return !/^[\\/]|[:\\]/.test(value) && value.split("/").every(p => !!p && p !== "." && p !== "..");
}
function inspectTime(value: CoreTime | null): void {
  if (!value) return;
  if (value.precision === "minute" && (!value.clock || value.notAfter !== null)
    || value.precision === "day" && (value.clock !== null || value.notAfter !== null)
    || value.precision === "bound" && (!value.notAfter || value.clock !== null)) invalid("TIME_PRECISION");
}
export function parseCoreRecord(input: unknown): CoreRecord {
  // JSON roundtrip also rejects non-JSON values, cycles and non-finite numbers instead of silently coercing them.
  let encoded: string;
  try { encoded = JSON.stringify(input, (_key, value) => {
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint"
      || typeof value === "number" && !Number.isFinite(value)) invalid("NON_JSON");
    return value;
  }); } catch { return invalid("NON_JSON"); }
  if (!encoded! || encoded!.length > 8 * 1024 * 1024 || !validateRecord(input)) invalid("RECORD_SCHEMA");
  const record = JSON.parse(encoded!) as CoreRecord;
  const { namespace, coordinates: c } = record;
  if (namespace === "rp" && (!c.realityId || !/^[1-9][0-9]*$/.test(c.realityId))
    || namespace === "ooc" && c.realityId !== "0" || namespace === "writer" && c.realityId !== "-1"
    || namespace === "unknown" && c.realityId !== null || namespace !== "rp" && c.branchId !== null) invalid("NAMESPACE_COORDINATES");
  for (const p of [...record.provenance, ...(record.kind === "assessment" && record.data.legacy ? [record.data.legacy] : [])]) {
    if (!safeRelative(p.path) || p.pointer !== "" && !/^(?:\/(?:[^~]|~[01])*)+$/.test(p.pointer)) invalid("LEGACY_REFERENCE");
  }
  switch (record.kind) {
    case "source": if (!safeRelative(record.data.path)) invalid("SOURCE_PATH"); break;
    case "evidence": case "coverage": {
      const r = record.data.range;
      if (r.unit === "line" ? r.start < 1 || r.end < r.start : r.end <= r.start) invalid("SOURCE_RANGE");
      if (record.kind === "coverage" && record.data.state === "reviewed" && (!record.data.checks.length || !record.data.assessments.length)) invalid("COVERAGE_BASIS");
      break;
    }
    case "event": inspectTime(record.data.occurredAt); break;
    case "work-version": {
      if ((record.data.components !== undefined) !== (record.data.joiner !== undefined)) invalid("WORK_COMPONENT_JOIN");
      for (const component of record.data.components ?? []) if (component.range) { const r = component.range;
        if (r.unit === "line" ? r.start < 1 || r.end < r.start : r.end <= r.start) invalid("SOURCE_RANGE"); }
      break;
    }
    case "acquisition": inspectTime(record.data.acquiredAt); if (!record.data.channels.length || !record.data.evidence.length) invalid("ACQUISITION_BASIS"); break;
    case "thread": inspectTime(record.data.lastVerifiedAt); break;
    case "revision": inspectTime(record.data.effectiveAt); if ((record.data.operation === "retract") !== (record.data.after === null)) invalid("REVISION_TARGET"); break;
    case "assessment": if ((record.data.authority === "legacy-reference") !== (record.data.legacy !== null)) invalid("ASSESSMENT_AUTHORITY"); break;
  }
  return record;
}

export const recordKey = (ref: RecordRef) => JSON.stringify([ref.id, ref.revision]);
/** Explicit cross-scope identity/carry-over is a separate reviewed operation, never inferred from matching names. */
export function validateCoreGraph(input: readonly unknown[]): CoreRecord[] {
  if (input.length > 100_000) invalid("GRAPH_LIMIT");
  const records = input.map(parseCoreRecord), map = new Map<string, CoreRecord>();
  const identities = new Map<string, string>();
  for (const r of records) {
    const key = recordKey(r); if (map.has(key)) invalid("DUPLICATE_REVISION");
    const identity = JSON.stringify([r.kind, r.namespace, r.coordinates]);
    if (identities.has(r.id) && identities.get(r.id) !== identity) invalid("RECORD_IDENTITY");
    identities.set(r.id, identity); map.set(key, r);
  }
  const resolve = (owner: CoreRecord, ref: RecordRef, kinds?: CoreKind[]) => {
    const r = map.get(recordKey(ref));
    if (!r || kinds && !kinds.includes(r.kind)) return invalid("REFERENCE");
    if (r.namespace !== owner.namespace || r.coordinates.realityId !== owner.coordinates.realityId || r.coordinates.branchId !== owner.coordinates.branchId) invalid("CROSS_SCOPE_REFERENCE");
    return r;
  };
  for (const r of records) {
    if ("evidence" in r.data) r.data.evidence.forEach(e => resolve(r, e, ["evidence"]));
    switch (r.kind) {
      case "evidence": case "coverage": resolve(r, r.data.source, ["source"]); if (r.kind === "coverage") r.data.assessments.forEach(a => resolve(r, a, ["assessment"])); break;
      case "entity": r.data.identityLinks.forEach(e => resolve(r, e, ["entity"])); break;
      case "event": r.data.participants.forEach(p => resolve(r, p, ["entity"])); break;
      case "claim": resolve(r, r.data.subject); break;
      case "work": {
        r.data.authors.forEach(a => resolve(r, a, ["entity"]));
        if (r.data.currentVersion) { const v = resolve(r, r.data.currentVersion, ["work-version"]) as CoreRecord<"work-version">; if (v.data.work.id !== r.id) invalid("WORK_VERSION"); }
        break;
      }
      case "work-version": {
        resolve(r, r.data.work, ["work"]); resolve(r, r.data.source, ["source"]);
        for (const component of r.data.components ?? []) resolve(r, component.source, ["source"]);
        if (r.data.supersedes) { const prev = resolve(r, r.data.supersedes, ["work-version"]) as CoreRecord<"work-version">;
          if (prev.id === r.id && prev.revision >= r.revision || prev.data.work.id !== r.data.work.id) invalid("VERSION_CHAIN"); }
        break;
      }
      case "acquisition": {
        resolve(r, r.data.character, ["entity"]); const target = resolve(r, r.data.object);
        if (r.data.extent === "full" && target.kind !== "work-version") invalid("FULL_ACQUISITION_VERSION");
        if (r.data.assessment) { const a = resolve(r, r.data.assessment, ["assessment"]) as CoreRecord<"assessment">;
          if (a.data.dimension !== "knowledge" || recordKey(a.data.subject) !== recordKey(r)) invalid("ACQUISITION_ASSESSMENT"); }
        break;
      }
      case "revision": {
        const before = resolve(r, r.data.before);
        if (r.data.after) { const after = resolve(r, r.data.after); if (before.id !== after.id || after.revision <= before.revision || before.kind !== after.kind) invalid("REVISION_SEQUENCE"); }
        break;
      }
      case "thread": r.data.anchors.forEach(a => resolve(r, a)); break;
      case "case": r.data.related.forEach(a => resolve(r, a)); break;
      case "assessment": resolve(r, r.data.subject); break;
    }
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const visitVersion = (r: CoreRecord<"work-version">): void => {
    const key = recordKey(r); if (visiting.has(key)) invalid("VERSION_CYCLE"); if (visited.has(key)) return;
    visiting.add(key);
    if (r.data.supersedes) visitVersion(resolve(r, r.data.supersedes, ["work-version"]) as CoreRecord<"work-version">);
    visiting.delete(key); visited.add(key);
  };
  for (const r of records) if (r.kind === "work-version") visitVersion(r);
  return records;
}

export interface CoreChangeSet {
  contract: typeof CRP_CORE_VERSION; id: string; baseSnapshot: string; baseManifestSha256: string;
  state: "candidate" | "reviewed" | "published" | "verified";
  protectedFiles: Record<string, string>; readSet: RecordRef[];
  operations: Array<{ expectedRevision: number | null; record: CoreRecord }>;
  review: { reviewer: string; changeFingerprint: string } | null;
}
export const CORE_CHANGE_SCHEMA = object({
  contract: { const: CRP_CORE_VERSION }, id, baseSnapshot: id, baseManifestSha256: sha,
  state: choice("candidate", "reviewed", "published", "verified"),
  protectedFiles: { type: "object", additionalProperties: sha, maxProperties: 100000 },
  readSet: refs,
  operations: list(object({ expectedRevision: nullable(positive), record: CORE_RECORD_SCHEMA })),
  review: nullable(object({ reviewer: id, changeFingerprint: sha })),
});
const validateChange = ajv.compile(CORE_CHANGE_SCHEMA);
/** Stable JSON hashing is for NEW contracts only. Never recompute old Python audit fingerprints with it. */
export function coreFingerprint(value: unknown): string {
  const canonical = (x: any): any => Array.isArray(x) ? x.map(canonical) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
  return hash(JSON.stringify(canonical(value)));
}
export function changeFingerprint(change: CoreChangeSet): string {
  const { state: _state, review: _review, ...body } = change; return coreFingerprint(body);
}
/** Preflight only. Publication, byte protection, compare-and-swap and crash recovery belong to the single writer. */
export function validateChangeSet(change: CoreChangeSet, baseInput: readonly unknown[]): CoreRecord[] {
  if (!validateChange(change)) invalid("CHANGE_SCHEMA");
  const base = validateCoreGraph(baseInput), current = new Map<string, CoreRecord>();
  for (const r of base) if ((current.get(r.id)?.revision ?? 0) < r.revision) current.set(r.id, r);
  if (change.contract !== CRP_CORE_VERSION || !change.id || !change.baseSnapshot || !/^[a-f0-9]{64}$/.test(change.baseManifestSha256)
    || !["candidate", "reviewed", "published", "verified"].includes(change.state) || !Array.isArray(change.operations) || change.operations.length > 20000) invalid("CHANGE_SCHEMA");
  for (const [file, sha256] of Object.entries(change.protectedFiles)) if (!safeRelative(file) || !/^[a-f0-9]{64}$/.test(sha256)) invalid("PROTECTED_FILE");
  for (const r of base) {
    const originals = [...r.provenance, ...(r.kind === "source" ? [{ path: r.data.path, sha256: r.data.sha256 }] : []),
      ...(r.kind === "assessment" && r.data.legacy ? [r.data.legacy] : [])];
    for (const original of originals) if (change.protectedFiles[original.path] !== original.sha256) invalid("PROTECTION_INCOMPLETE");
  }
  for (const ref of change.readSet) if (current.get(ref.id)?.revision !== ref.revision) invalid("STALE_READ");
  const seen = new Set<string>(), added: CoreRecord[] = [];
  for (const op of change.operations) {
    const r = parseCoreRecord(op.record), old = current.get(r.id);
    if (r.kind === "source" && change.protectedFiles[r.data.path] && change.protectedFiles[r.data.path] !== r.data.sha256) invalid("PROTECTED_SOURCE_OVERWRITE");
    if (seen.has(r.id) || (old?.revision ?? null) !== op.expectedRevision || r.revision !== (old?.revision ?? 0) + 1) invalid("REVISION_CONFLICT");
    if (old && (old.kind !== r.kind || old.namespace !== r.namespace || coreFingerprint(old.coordinates) !== coreFingerprint(r.coordinates))) invalid("RECORD_IDENTITY");
    seen.add(r.id); added.push(r);
  }
  if (change.state !== "candidate" && (!change.review?.reviewer || change.review.changeFingerprint !== changeFingerprint(change))) invalid("REVIEW_FINGERPRINT");
  return validateCoreGraph([...base, ...added]);
}
