import { expect, it } from "vitest";
import { validateMigrationMap, type ReviewedMigrationMap } from "./migration-workbench";
import type { CrpMigrationPreview } from "./migration-preview";
import { CRP_CONTRACT_VERSION } from "./contracts";
import { CRP_CORE_VERSION, type CoreRecord } from "./core-contracts";
const sha = "a".repeat(64), legacy = { path: "registry.json", sha256: sha, pointer: "/events/old" };
const preview: CrpMigrationPreview = { contract: CRP_CONTRACT_VERSION, mode: "read-only-preview", snapshotId: "snapshot", sourceManifestSha256: sha,
  protectedFiles: { "registry.json": sha }, objects: [{ id: "old-key", legacyId: "old", namespace: "rp", kind: "events", path: legacy.path, sourceSha256: sha, pointer: legacy.pointer }], assessments: [], gaps: [], auditComplete: false };
const record: CoreRecord<"event"> = { contract: CRP_CORE_VERSION, kind: "event", id: "event", revision: 1, namespace: "rp", coordinates: { realityId: "42", branchId: null }, provenance: [legacy], data: { title: "fiction", participants: [], occurredAt: null, evidence: [] } };
const mapping: ReviewedMigrationMap = { baseManifestSha256: sha, records: [record], mappings: [{ legacyId: "old-key", targets: [{ id: "event", revision: 1 }], semanticReview: "reviewed" }], assessments: [] };
it("does not treat model-written reviewed fields as host acceptance", () => {
  const report = validateMigrationMap(preview, mapping); expect(report.structuralMappingComplete).toBe(true); expect(report.semanticReviewComplete).toBe(false); expect(report.auditComplete).toBe(false);
  expect(validateMigrationMap(preview, mapping, () => true).semanticReviewComplete).toBe(true);
});
it("rejects changed baselines and loss of exact original pointers", () => {
  expect(() => validateMigrationMap(preview, { ...mapping, baseManifestSha256: "b".repeat(64) })).toThrow("BASE_CHANGED");
  const changed = structuredClone(mapping); changed.records[0].provenance[0].pointer = "/events/another";
  expect(() => validateMigrationMap(preview, changed)).toThrow("PROVENANCE");
  expect(validateMigrationMap(preview, { ...mapping, mappings: [] }).unmappedObjects).toBe(1);
});
