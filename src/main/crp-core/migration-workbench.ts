import { previewLegacyMigration, type CrpMigrationPreview } from "./migration-preview";
import { coreFingerprint, recordKey, validateCoreGraph, type CoreRecord, type RecordRef } from "./core-contracts";

export interface ReviewedMigrationMap {
  baseManifestSha256: string;
  records: CoreRecord[];
  mappings: Array<{ legacyId: string; targets: RecordRef[]; semanticReview: "reviewed" | "pending" }>;
  assessments: Array<{ legacyId: string; target: RecordRef; semanticReview: "reviewed" | "pending" }>;
}
/** Every legacy item must be explicitly handled. This creates a review queue, never speculative facts. */
export function createMigrationQueue(snapshotRoot: string) {
  const preview = previewLegacyMigration(snapshotRoot);
  return { version: 1, snapshotId: preview.snapshotId, baseManifestSha256: preview.sourceManifestSha256,
    protectedFiles: preview.protectedFiles,
    objects: preview.objects.map(o => ({ legacyId: o.id, kind: o.kind, namespace: o.namespace, originalId: o.legacyId,
      provenance: { path: o.path, sha256: o.sourceSha256, pointer: o.pointer }, semanticReview: "pending" as const, targets: [] as RecordRef[] })),
    assessments: preview.assessments.map(a => ({ legacyId: a.legacyId, provenance: { path: a.path, sha256: a.sourceSha256, pointer: a.pointer }, semanticReview: "pending" as const })),
    auditComplete: false, productionReady: false };
}
export function validateMigrationMap(preview: CrpMigrationPreview, mapping: ReviewedMigrationMap, accepted: (entry: ReviewedMigrationMap["mappings"][number] | ReviewedMigrationMap["assessments"][number]) => boolean = () => false) {
  if (mapping.baseManifestSha256 !== preview.sourceManifestSha256) throw Error("CRP_MIGRATION_BASE_CHANGED");
  const records = validateCoreGraph(mapping.records), refs = new Map(records.map(r => [recordKey(r), r]));
  const objects = new Map(preview.objects.map(o => [o.id, o])), assessments = new Map(preview.assessments.map(a => [a.legacyId, a]));
  const seen = new Set<string>(), seenAudits = new Set<string>(); let pending = 0;
  for (const row of mapping.mappings) {
    const old = objects.get(row.legacyId);
    if (!old || seen.has(row.legacyId) || !row.targets.length || !["reviewed", "pending"].includes(row.semanticReview)) throw Error("CRP_MIGRATION_MAPPING");
    seen.add(row.legacyId); if (row.semanticReview !== "reviewed" || !accepted(structuredClone(row))) pending++;
    for (const ref of row.targets) {
      const target = refs.get(recordKey(ref));
      if (!target || !target.provenance.some(p => p.path === old.path && p.sha256 === old.sourceSha256 && p.pointer === old.pointer)) throw Error("CRP_MIGRATION_PROVENANCE");
    }
  }
  for (const row of mapping.assessments) {
    const old = assessments.get(row.legacyId), target = refs.get(recordKey(row.target));
    if (!old || seenAudits.has(row.legacyId) || !["reviewed", "pending"].includes(row.semanticReview) || target?.kind !== "assessment") throw Error("CRP_MIGRATION_ASSESSMENT");
    const original = target.data.legacy;
    if (target.data.authority !== "legacy-reference" || !original || original.path !== old.path || original.sha256 !== old.sourceSha256 || original.pointer !== old.pointer) throw Error("CRP_MIGRATION_AUDIT_PROMOTION");
    seenAudits.add(row.legacyId); if (row.semanticReview !== "reviewed" || !accepted(structuredClone(row))) pending++;
  }
  return { fingerprint: coreFingerprint(mapping), mappedObjects: seen.size, totalObjects: objects.size, mappedAssessments: seenAudits.size, totalAssessments: assessments.size,
    pendingReviews: pending, unmappedObjects: objects.size - seen.size, unmappedAssessments: assessments.size - seenAudits.size,
    structuralMappingComplete: seen.size === objects.size && seenAudits.size === assessments.size,
    semanticReviewComplete: pending === 0 && seen.size === objects.size && seenAudits.size === assessments.size,
    auditComplete: false, protectedFiles: preview.protectedFiles };
}
