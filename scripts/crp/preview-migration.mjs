import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--snapshot") {
  console.error("Usage: pnpm run build:main; node scripts/crp/preview-migration.mjs --snapshot <validated-snapshot-directory>");
  process.exitCode = 2;
} else {
  try {
    const require = createRequire(import.meta.url);
    const { previewLegacyMigration } = require(path.join(root, "dist/main/main/crp-core/migration-preview.js"));
    const preview = previewLegacyMigration(path.resolve(args[1]));
    // Intentionally omit private object names, raw content and paths from normal output.
    console.log(JSON.stringify({ contract: preview.contract, mode: preview.mode, snapshotId: preview.snapshotId,
      protectedFiles: Object.keys(preview.protectedFiles).length, objects: preview.objects.length,
      assessments: preview.assessments.length, auditComplete: preview.auditComplete, gaps: preview.gaps }, null, 2));
  } catch (error) {
    console.error(error instanceof Error && /^BRIDGE_[A-Z_]+$/.test(error.message) ? error.message : "CRP_MIGRATION_PREVIEW_FAILED");
    process.exitCode = 1;
  }
}
