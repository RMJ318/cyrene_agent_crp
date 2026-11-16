import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
try {
  const args = process.argv.slice(2), values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--snapshot", "--case", "--realities"].includes(args[i]) || !args[i + 1] || values.has(args[i])) throw Error("CRP_VERIFY_USAGE");
    values.set(args[i], args[i + 1]);
  }
  if (values.size !== 3) throw Error("CRP_VERIFY_USAGE");
  const privateCases = path.join(root, "integrations/crp-v3/evaluation/cases.json");
  const cases = JSON.parse(fs.readFileSync(fs.existsSync(privateCases) ? privateCases : path.join(root, "integrations/crp-v3/evaluation/cases.example.json"), "utf8")).cases;
  const selected = cases.find(item => item.id === values.get("--case"));
  const realities = values.get("--realities").split(",");
  if (!selected || selected.requiresSelectedRealities.some(id => !realities.includes(id))) throw Error("CRP_VERIFY_CASE_SCOPE_MISMATCH");
  const require = createRequire(import.meta.url);
  const { verifySnapshotRecall } = require(path.join(root, "dist/main/main/crp-core/recall-verification.js"));
  const report = await verifySnapshotRecall(path.resolve(values.get("--snapshot")), { query: selected.query, realities, expectedIds: selected.primaryAnchors, detailIds: selected.relatedAnchors ?? [] });
  console.log(JSON.stringify(report, null, 2));
  if (report.expected.some(item => !item.budgeted)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error && /^(?:BRIDGE|CRP_VERIFY)_[A-Z_]+$/.test(error.message) ? error.message : "CRP_VERIFY_FAILED");
  if (error instanceof Error && error.message === "CRP_VERIFY_USAGE") console.error("Usage: node scripts/crp/verify-recall.mjs --snapshot <directory> --case <id> --realities <comma-separated-current-selection>");
  process.exitCode = 2;
}
