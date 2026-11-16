import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--snapshot" || args[2] !== "--output") throw Error("CRP_MIGRATION_USAGE");
  const require = createRequire(import.meta.url), sourceRoot = fs.realpathSync(args[1]), output = path.resolve(args[3]);
  const { within } = require(path.join(root, "dist/main/main/memory-bridge/safety.js"));
  if (within(sourceRoot, output) || fs.existsSync(output)) throw Error("CRP_MIGRATION_OUTPUT");
  const { createMigrationQueue } = require(path.join(root, "dist/main/main/crp-core/migration-workbench.js"));
  const queue = createMigrationQueue(sourceRoot);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.realpathSync(path.dirname(output)).toLowerCase() !== path.dirname(output).toLowerCase()) throw Error("CRP_MIGRATION_OUTPUT");
  fs.writeFileSync(output, JSON.stringify(queue, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ objects: queue.objects.length, assessments: queue.assessments.length, allSemanticReviewsPending: true, sourceUnchanged: true, applied: false }));
} catch { console.error("CRP_MIGRATION_PREPARATION_FAILED"); process.exitCode = 1; }
