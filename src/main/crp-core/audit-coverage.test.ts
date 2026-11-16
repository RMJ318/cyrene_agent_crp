import { expect, it } from "vitest";
import { AUDIT_CHECKS, auditCoverage, type AuditBatch, type AuditPlan } from "./audit-coverage";
import { coreFingerprint } from "./core-contracts";
const plan: AuditPlan = { snapshotId: "fictional", manifestSha256: "a".repeat(64), policyVersion: "p1", records: [{ id: "event", revision: 1 }], sources: [{ id: { id: "source", revision: 1 }, sha256: "b".repeat(64), codepoints: 100 }] };
function batch(): AuditBatch { return { planFingerprint: coreFingerprint(plan), batchId: "batch1", unresolvedDependencies: [],
  findings: AUDIT_CHECKS.map(check => ({ record: plan.records[0], check, verdict: "PASS", evidence: [{ id: "evidence", revision: 1 }] })),
  readings: [{ source: plan.sources[0].id, sha256: plan.sources[0].sha256, start: 0, end: 100, semantic: true }] }; }
it("requires both eight-way checks and actual reverse semantic coverage, counting overlaps only once", () => {
  const b = batch(); b.readings = [{ ...b.readings[0], end: 60 }, { ...b.readings[0], start: 40, end: 80 }];
  const partial = auditCoverage(plan, [b, b], () => true); expect(partial.acceptedBatches).toBe(1); expect(partial.sourceCoverage[0].semanticallyRead).toBe(80); expect(partial.auditComplete).toBe(false);
  const completed = batch(); expect(auditCoverage(plan, [completed], () => true).auditComplete).toBe(true);
});
it("reports completion separately from pass and keeps unread checks NOT_REVIEWED", () => {
  const b = batch(); b.findings[0].verdict = "CONFLICT";
  const report = auditCoverage(plan, [b], () => true); expect(report.auditComplete).toBe(true); expect(report.allFindingsPass).toBe(false);
  expect(auditCoverage(plan, [], () => true).verdicts.NOT_REVIEWED).toBe(8);
  b.unresolvedDependencies = ["cross-batch follow-up"]; expect(auditCoverage(plan, [b], () => true).auditComplete).toBe(false);
  const resumed = { ...batch(), batchId: "follow-up", findings: [], readings: [], resolvedDependencies: [{ id: "cross-batch follow-up", evidence: [{ id: "follow-up-evidence", revision: 1 }] }] };
  expect(auditCoverage(plan, [b, resumed], () => true).auditComplete).toBe(true);
});
it("rejects unaccepted, mixed-baseline, changed-source and conflicting retry batches", () => {
  expect(() => auditCoverage(plan, [batch()], () => false)).toThrow("DENIED");
  let b = batch(); b.planFingerprint = "changed"; expect(() => auditCoverage(plan, [b], () => true)).toThrow("DENIED");
  b = batch(); b.readings[0].sha256 = "c".repeat(64); expect(() => auditCoverage(plan, [b], () => true)).toThrow("READING");
  b = batch(); b.findings[0].verdict = "CONFLICT"; expect(() => auditCoverage(plan, [batch(), b], () => true)).toThrow("BATCH_CONFLICT");
});
