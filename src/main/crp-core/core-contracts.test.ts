import { expect, it } from "vitest";
import { CRP_CORE_VERSION, changeFingerprint, coreFingerprint, parseCoreRecord, validateChangeSet, validateCoreGraph, type CoreChangeSet, type CoreKind, type CorePayloads, type CoreRecord } from "./core-contracts";
import { assertCoreContext, bindCoreContext, parseCoreQuery } from "./query-contracts";

const sha = "a".repeat(64);
const ref = (id: string, revision = 1) => ({ id, revision });
const when = { day: 8, clock: "19:18", precision: "minute" as const, notAfter: null };
function r<K extends CoreKind>(kind: K, id: string, data: CorePayloads[K], revision = 1): CoreRecord<K> {
  return { contract: CRP_CORE_VERSION, id, kind, revision, namespace: "rp", coordinates: { realityId: "42", branchId: null }, provenance: [], data } as CoreRecord<K>;
}
function graph(): CoreRecord[] {
  return [
    r("source", "src", { path: "raw/fiction.md", sha256: sha, byteLength: 100, encoding: "utf-8", media: "transcript" }),
    r("evidence", "ev", { source: ref("src"), range: { unit: "line", start: 1, end: 2 }, excerptSha256: sha }),
    r("entity", "one", { name: "虚构甲", aliases: ["甲"], identityLinks: [] }),
    r("entity", "two", { name: "虚构乙", aliases: [], identityLinks: [] }),
    r("event", "event", { title: "表达喜欢", participants: [ref("one"), ref("two")], occurredAt: when, evidence: [ref("ev")] }),
    r("claim", "claim", { subject: ref("event"), predicate: "relationship_name", value: null, epistemicStatus: "unknown", evidence: [ref("ev")] }),
    r("work", "work", { title: "虚构诗稿", authors: [ref("one")], currentVersion: ref("v1") }),
    r("work-version", "v1", { work: ref("work"), source: ref("src"), supersedes: null, state: "draft", evidence: [ref("ev")] }),
    r("acquisition", "acq", { character: ref("two"), object: ref("v1"), acquiredAt: null, channels: ["received"], extent: "title", evidence: [ref("ev")], assessment: ref("audit") }),
    r("assessment", "audit", { subject: ref("acq"), dimension: "knowledge", verdict: "INSUFFICIENT_EVIDENCE", authority: "legacy-reference",
      basisFingerprint: sha, algorithm: "legacy-python-v1", evidence: [ref("ev")], legacy: { path: "audit/original.json", sha256: sha, pointer: "/entries/acq" } }),
    r("thread", "thread", { title: "相处线", state: "active", anchors: [ref("event")], lastVerifiedAt: when }),
    r("case", "case", { question: "是否通读", state: "open", related: [ref("acq")], evidence: [ref("ev")] }),
    r("coverage", "coverage", { source: ref("src"), range: { unit: "codepoint", start: 0, end: 9 }, direction: "source-to-registered", state: "read", checks: [], assessments: [] }),
    r("revision", "revision", { before: ref("claim"), after: null, operation: "retract", effectiveAt: null, evidence: [ref("ev")] }),
  ];
}
it("represents all core objects without upgrading relationship, acquisition or legacy audit conclusions", () => {
  const input = graph(), before = JSON.stringify(input), out = validateCoreGraph(input);
  expect(new Set(out.map(x => x.kind)).size).toBe(13);
  expect(JSON.stringify(input)).toBe(before); expect(out).toEqual(input);
  expect(out.find(x => x.kind === "claim")?.data).toMatchObject({ value: null, epistemicStatus: "unknown" });
  expect(out.find(x => x.kind === "acquisition")?.data).toMatchObject({ extent: "title", acquiredAt: null });
});
it("rejects guessed precision, namespace confusion, traversal and invalid source coordinates", () => {
  const event = graph().find(x => x.kind === "event")!;
  expect(() => parseCoreRecord({ ...event, data: { ...event.data, occurredAt: { ...when, clock: null } } })).toThrow("TIME_PRECISION");
  expect(() => parseCoreRecord({ ...event, coordinates: { realityId: "0", branchId: null } })).toThrow("NAMESPACE");
  const source = graph()[0] as CoreRecord<"source">;
  expect(() => parseCoreRecord({ ...source, data: { ...source.data, path: "../escape" } })).toThrow("SOURCE_PATH");
  const evidence = graph()[1] as CoreRecord<"evidence">;
  expect(() => parseCoreRecord({ ...evidence, data: { ...evidence.data, range: { unit: "line", start: 0, end: 2 } } })).toThrow("SOURCE_RANGE");
});
it("rejects cross-reality grants, unversioned full acquisitions and missing/stale references", () => {
  let input = graph(); input.find(x => x.id === "two")!.coordinates.realityId = "43";
  expect(() => validateCoreGraph(input)).toThrow("CROSS_SCOPE");
  input = graph(); (input.find(x => x.kind === "acquisition") as CoreRecord<"acquisition">).data.object = ref("work");
  (input.find(x => x.kind === "acquisition") as CoreRecord<"acquisition">).data.extent = "full";
  expect(() => validateCoreGraph(input)).toThrow("FULL_ACQUISITION_VERSION");
  input = graph(); (input.find(x => x.kind === "event") as CoreRecord<"event">).data.participants = [ref("one", 9)];
  expect(() => validateCoreGraph(input)).toThrow("REFERENCE");
});
it("rejects cyclic work histories and ungrounded coverage, keeping audit dimensions independent", () => {
  const input = graph(), version = input.find(x => x.id === "v1") as CoreRecord<"work-version">;
  const next = structuredClone(version); next.id = "v2"; next.data.supersedes = ref("v1"); version.data.supersedes = ref("v2"); input.push(next);
  expect(() => validateCoreGraph(input)).toThrow("VERSION_CYCLE");
  const coverage = graph().find(x => x.kind === "coverage") as CoreRecord<"coverage">;
  coverage.data.state = "reviewed"; expect(() => parseCoreRecord(coverage)).toThrow("COVERAGE_BASIS");
  const audit = graph().find(x => x.kind === "assessment") as CoreRecord<"assessment">;
  audit.data.authority = "reviewed"; expect(() => parseCoreRecord(audit)).toThrow("ASSESSMENT_AUTHORITY");
});
function change(): CoreChangeSet {
  const old = graph().find(x => x.kind === "claim") as CoreRecord<"claim">;
  const next = structuredClone(old); next.revision = 2; next.data.epistemicStatus = "disputed";
  return { contract: CRP_CORE_VERSION, id: "change-1", baseSnapshot: "snapshot", baseManifestSha256: sha, state: "candidate",
    protectedFiles: { "raw/fiction.md": sha, "audit/original.json": sha }, readSet: [ref("claim")], operations: [{ expectedRevision: 1, record: next }], review: null };
}
it("preflights append-only changes with CAS and review binding while preserving source and audit protections", () => {
  const base = graph(), c = change(), before = JSON.stringify(base);
  expect(validateChangeSet(c, base)).toHaveLength(base.length + 1); expect(JSON.stringify(base)).toBe(before);
  c.state = "reviewed"; c.review = { reviewer: "human", changeFingerprint: changeFingerprint(c) };
  expect(validateChangeSet(c, base)).toHaveLength(base.length + 1);
  (c.operations[0].record as CoreRecord<"claim">).data.value = "changed after review";
  expect(() => validateChangeSet(c, base)).toThrow("REVIEW_FINGERPRINT");
});
it("refuses stale changes, missing original-byte protection and replacement of a protected source", () => {
  const base = graph(); let c = change(); c.readSet = [ref("claim", 2)]; expect(() => validateChangeSet(c, base)).toThrow("STALE_READ");
  c = change(); c.operations[0].expectedRevision = 2; expect(() => validateChangeSet(c, base)).toThrow("REVISION_CONFLICT");
  c = change(); delete c.protectedFiles["audit/original.json"]; expect(() => validateChangeSet(c, base)).toThrow("PROTECTION_INCOMPLETE");
  c = change(); const src = structuredClone(base[0]) as CoreRecord<"source">; src.revision = 2; src.data.sha256 = "b".repeat(64);
  c.operations = [{ expectedRevision: 1, record: src }]; expect(() => validateChangeSet(c, base)).toThrow("PROTECTED_SOURCE_OVERWRITE");
});
it("has bounded contracts for all eight methods without accepting model-issued permissions", () => {
  const queries = [
    { method: "open_context", input: {} }, { method: "search", input: { query: "keyword", limit: 5, cursor: null } },
    { method: "read", input: { ref: ref("event"), offset: 0, pageSize: 2400 } },
    { method: "timeline", input: { fromDay: 1, toDay: 8, participants: [], limit: 10, cursor: null } },
    { method: "related", input: { ref: ref("event"), relation: "evidence", limit: 10, cursor: null } },
    { method: "continuity", input: { thread: null, limit: 10, cursor: null } },
    { method: "coverage", input: { source: ref("src"), direction: "source-to-registered", limit: 10, cursor: null } },
    { method: "explain", input: { receiptId: "receipt" } },
  ];
  queries.forEach(q => expect(parseCoreQuery(q)).toEqual(q));
  expect(() => parseCoreQuery({ ...queries[1], input: { ...queries[1].input, realityId: "43" } })).toThrow("SCHEMA");
  expect(() => parseCoreQuery({ method: "read", input: { ref: ref("event"), offset: 0, pageSize: 2401 } })).toThrow("SCHEMA");
  expect(() => parseCoreQuery({ method: "timeline", input: { fromDay: 8, toDay: 1, participants: [], limit: 5, cursor: null } })).toThrow("RANGE");
});
it("binds immutable host context and invalidates stale receipts on policy/index changes", () => {
  const context = bindCoreContext({ snapshotId: "snapshot", sourceManifestSha256: sha, indexIdentity: "index-v1", policyFingerprint: "policy-1",
    scopes: [{ domain: "rp", realityId: "42", branchId: null, audience: "character-knowledge", characterId: "one", asOf: { day: 8 } }] });
  expect(Object.isFrozen(context.scopes[0].asOf)).toBe(true);
  const fp = coreFingerprint(context); expect(() => assertCoreContext(context, fp)).not.toThrow();
  expect(() => assertCoreContext({ ...context, policyFingerprint: "policy-2" }, fp)).toThrow("CONTEXT_CHANGED");
});
