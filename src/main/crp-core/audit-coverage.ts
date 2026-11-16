import { coreFingerprint, type RecordRef } from "./core-contracts";

export const AUDIT_CHECKS = ["reality-time", "speaker-participants", "knowledge-scope", "acquisition-channel", "revision-version", "causality-order", "source-coordinates", "rp-ooc-boundary"] as const;
export interface AuditPlan {
  snapshotId: string; manifestSha256: string; policyVersion: string;
  records: RecordRef[];
  sources: Array<{ id: RecordRef; sha256: string; codepoints: number }>;
}
export interface AuditBatch {
  planFingerprint: string; batchId: string;
  findings: Array<{ record: RecordRef; check: typeof AUDIT_CHECKS[number]; verdict: "PASS" | "CONFLICT" | "INSUFFICIENT_EVIDENCE"; evidence: RecordRef[] }>;
  /** Only actual semantic reading reviewed by the host counts, never search results or task dispatch. */
  readings: Array<{ source: RecordRef; sha256: string; start: number; end: number; semantic: true }>;
  unresolvedDependencies: string[];
  resolvedDependencies?: Array<{ id: string; evidence: RecordRef[] }>;
}
const key = (ref: RecordRef) => JSON.stringify([ref.id, ref.revision]);
/** Deterministic closure report. Input approval is host-owned, not an audit_complete field from a model. */
export function auditCoverage(plan: AuditPlan, batches: readonly AuditBatch[], accepted: (batch: AuditBatch) => boolean) {
  const fingerprint = coreFingerprint(plan), ids = new Set(plan.records.map(key)), sources = new Map(plan.sources.map(s => [key(s.id), s]));
  if (!plan.snapshotId || !/^[a-f0-9]{64}$/.test(plan.manifestSha256) || !plan.policyVersion || ids.size !== plan.records.length || sources.size !== plan.sources.length
    || plan.sources.some(s => !/^[a-f0-9]{64}$/.test(s.sha256) || !Number.isSafeInteger(s.codepoints) || s.codepoints < 0)) throw Error("CRP_AUDIT_PLAN");
  const checks = new Map<string, AuditBatch["findings"][number]>(), intervals = new Map<string, Array<[number, number]>>(), seen = new Map<string, string>(), dependencies = new Set<string>(), resolved = new Set<string>();
  for (const input of batches) {
    const batch = structuredClone(input);
    if (batch.planFingerprint !== fingerprint || !accepted(structuredClone(batch))) throw Error("CRP_AUDIT_BATCH_DENIED");
    const digest = coreFingerprint(batch), previous = seen.get(batch.batchId);
    if (!batch.batchId || previous && previous !== digest) throw Error("CRP_AUDIT_BATCH_CONFLICT"); if (previous) continue; seen.set(batch.batchId, digest);
    for (const f of batch.findings) {
      if (!ids.has(key(f.record)) || !AUDIT_CHECKS.includes(f.check) || !["PASS", "CONFLICT", "INSUFFICIENT_EVIDENCE"].includes(f.verdict) || !f.evidence.length) throw Error("CRP_AUDIT_FINDING");
      const identity = JSON.stringify([key(f.record), f.check]), old = checks.get(identity);
      if (old && coreFingerprint(old) !== coreFingerprint(f)) throw Error("CRP_AUDIT_FINDING_CONFLICT"); checks.set(identity, f);
    }
    for (const r of batch.readings) {
      const source = sources.get(key(r.source));
      if (!source || r.sha256 !== source.sha256 || r.semantic !== true || !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end <= r.start || r.end > source.codepoints) throw Error("CRP_AUDIT_READING");
      const spans = intervals.get(key(r.source)) ?? []; spans.push([r.start, r.end]); intervals.set(key(r.source), spans);
    }
    batch.unresolvedDependencies.forEach(d => dependencies.add(d));
    for (const resolution of batch.resolvedDependencies ?? []) {
      if (!resolution.id || !resolution.evidence.length) throw Error("CRP_AUDIT_RESOLUTION"); resolved.add(resolution.id);
    }
  }
  for (const id of resolved) dependencies.delete(id);
  const sourceCoverage = plan.sources.map(source => {
    const merged: Array<[number, number]> = [];
    for (const [start, end] of (intervals.get(key(source.id)) ?? []).sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1); if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]);
    }
    const read = merged.reduce((n, [start, end]) => n + end - start, 0);
    return { source: source.id, codepoints: source.codepoints, semanticallyRead: read, complete: read === source.codepoints };
  });
  const required = ids.size * AUDIT_CHECKS.length, completed = checks.size;
  return { planFingerprint: fingerprint, acceptedBatches: seen.size, requiredChecks: required, completedChecks: completed,
    sourceCoverage, unresolvedDependencies: [...dependencies].sort(),
    verdicts: { PASS: [...checks.values()].filter(f => f.verdict === "PASS").length, CONFLICT: [...checks.values()].filter(f => f.verdict === "CONFLICT").length,
      INSUFFICIENT_EVIDENCE: [...checks.values()].filter(f => f.verdict === "INSUFFICIENT_EVIDENCE").length, NOT_REVIEWED: required - completed },
    auditComplete: completed === required && sourceCoverage.every(s => s.complete) && dependencies.size === 0,
    allFindingsPass: completed === required && [...checks.values()].every(f => f.verdict === "PASS"),
  };
}
