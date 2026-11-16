import fs from "node:fs";
import { CrpSnapshot } from "../memory-bridge/snapshot";
import { fail, hash, readBounded, safePath } from "../memory-bridge/safety";
import { CRP_CONTRACT_VERSION } from "./contracts";

interface LegacyObjectRef {
  id: string; legacyId: string; namespace: string; kind: string;
  path: string; sourceSha256: string; pointer: string;
}
export interface CrpMigrationPreview {
  contract: typeof CRP_CONTRACT_VERSION;
  mode: "read-only-preview";
  snapshotId: string;
  sourceManifestSha256: string;
  /** Original files remain in the immutable snapshot; never re-encode them for audit hashes. */
  protectedFiles: Record<string, string>;
  objects: LegacyObjectRef[];
  assessments: Array<{ legacyId: string; path: string; sourceSha256: string; pointer: string }>;
  gaps: string[];
  auditComplete: false;
}
const pointer = (value: string) => value.replace(/~/g, "~0").replace(/\//g, "~1");

/** No writes, model calls, scripts, audit promotion or mutation of the caller's source. */
export function previewLegacyMigration(snapshotRoot: string): CrpMigrationPreview {
  const manifestBytes = fs.readFileSync(safePath(snapshotRoot, "snapshot.json"));
  const snapshot = new CrpSnapshot(snapshotRoot); snapshot.validate();
  const files = snapshot.manifest.files;
  const read = (relative: string) => {
    const bytes = readBounded(safePath(snapshotRoot, relative));
    if (hash(bytes) !== files[relative]) fail("SOURCE_CHANGED");
    return JSON.parse(bytes.toString("utf8"));
  };
  const registryPath = "archive/rp/library/registry.json", registry = read(registryPath);
  const refs = registry.namespace_refs ?? { rp: registryPath };
  const objects: LegacyObjectRef[] = [];
  for (const [namespace, relative] of Object.entries(refs)) {
    if (!["rp", "ooc", "unknown"].includes(namespace) || typeof relative !== "string") fail("CRP_NAMESPACE");
    const data = read(relative);
    for (const [kind, rows] of Object.entries(data)) {
      if (!rows || typeof rows !== "object" || Array.isArray(rows)) continue;
      for (const [legacyId, record] of Object.entries(rows)) {
        if (!record || typeof record !== "object" || (record as { id?: unknown }).id !== legacyId) continue;
        objects.push({ id: JSON.stringify([namespace, kind, legacyId]), legacyId, namespace, kind,
          path: relative, sourceSha256: files[relative], pointer: `/${pointer(kind)}/${pointer(legacyId)}` });
      }
    }
  }
  const auditPath = "archive/rp/library/audit/knowledge-results.json";
  const audits = read(auditPath).entries ?? {};
  const assessments = Object.keys(audits).sort().map(legacyId => ({ legacyId, path: auditPath, sourceSha256: files[auditPath], pointer: `/entries/${pointer(legacyId)}` }));
  const protectedFiles = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  // Detect concurrent changes rather than advertising a mixed-version preview.
  for (const [relative, sha] of Object.entries(protectedFiles)) if (hash(readBounded(safePath(snapshotRoot, relative))) !== sha) fail("SOURCE_CHANGED");
  if (hash(fs.readFileSync(safePath(snapshotRoot, "snapshot.json"))) !== hash(manifestBytes)) fail("SOURCE_CHANGED");
  return { contract: CRP_CONTRACT_VERSION, mode: "read-only-preview", snapshotId: snapshot.manifest.snapshotId,
    sourceManifestSha256: hash(manifestBytes), protectedFiles, objects: objects.sort((a, b) => a.id.localeCompare(b.id)), assessments,
    gaps: ["Structural mapping only; no semantic re-audit or source coverage claim.", "Legacy source and assessment bytes remain authoritative; new IDs are projection keys, not replacements.", "Works, revision semantics, thread state and knowledge-scope normalization require subsequent migration stages."], auditComplete: false };
}
