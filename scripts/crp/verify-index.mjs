import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Source is read-only. Only the explicitly named, separate disposable index directory is written.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
try {
  const args = process.argv.slice(2), values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--snapshot", "--index-dir", "--case", "--realities"].includes(args[i]) || !args[i + 1] || values.has(args[i])) throw Error("CRP_INDEX_VERIFY_USAGE");
    values.set(args[i], args[i + 1]);
  }
  if (values.size !== 4) throw Error("CRP_INDEX_VERIFY_USAGE");
  const cases = JSON.parse(fs.readFileSync(path.join(root, "integrations/crp-v3/evaluation/cases.json"), "utf8")).cases;
  const selected = cases.find(c => c.id === values.get("--case")), realities = values.get("--realities").split(",");
  if (!selected || realities.length > 32 || realities.some(id => !/^(0|[1-9]\d*)$/.test(id)) || selected.requiresSelectedRealities.some(id => !realities.includes(id))) throw Error("CRP_INDEX_VERIFY_SCOPE");
  const require = createRequire(import.meta.url);
  const { CrpSnapshot } = require(path.join(root, "dist/main/main/memory-bridge/snapshot.js"));
  const { safePath, hash, readBounded, within } = require(path.join(root, "dist/main/main/memory-bridge/safety.js"));
  const { PersistentCrpIndex } = require(path.join(root, "dist/main/main/crp-core/persistent-index.js"));
  const { retrieveCrp, toBridgeResult } = require(path.join(root, "dist/main/main/crp-core/retrieval.js"));
  const { boundBridgeResult } = require(path.join(root, "dist/main/main/memory-bridge/result-budget.js"));
  const { CRP_CONTRACT_VERSION } = require(path.join(root, "dist/main/main/crp-core/contracts.js"));
  const sourceRoot = fs.realpathSync(values.get("--snapshot"));
  const indexPath = path.resolve(values.get("--index-dir"));
  if (within(sourceRoot, indexPath) || within(indexPath, sourceRoot)) throw Error("CRP_INDEX_VERIFY_OVERLAP");
  fs.mkdirSync(indexPath, { recursive: true });
  if (fs.realpathSync(indexPath).toLowerCase() !== indexPath.toLowerCase()) throw Error("CRP_INDEX_VERIFY_PATH");
  const snapshot = new CrpSnapshot(sourceRoot); snapshot.validate();
  const manifestSha = hash(readBounded(safePath(sourceRoot, "snapshot.json")));
  const scopes = [...new Set(realities)].map(realityId => ({ domain: realityId === "0" ? "reality0" : "rp", realityId, branchId: null, audience: "archive-reference" }));
  const namespace = hash(JSON.stringify([CRP_CONTRACT_VERSION, snapshot.manifest, scopes, []]));
  const rounds = [];
  for (let round = 0; round < 2; round++) {
    const started = performance.now(); snapshot.verifyProjection();
    const documents = scopes.flatMap(scope => snapshot.documents(scope)), aliases = scopes.flatMap(scope => snapshot.identityAliases(scope));
    const projected = performance.now();
    // Reopen the database between rounds, discarding all process-level vector/token caches.
    const index = new PersistentCrpIndex(indexPath, namespace);
    try {
      const result = await retrieveCrp(selected.query, documents, { localAllowed: false, aliases, selectedRealities: realities, index,
        localProvider: () => { throw Error("CRP_INDEX_VERIFY_MODEL_FORBIDDEN"); } });
      snapshot.verifyProjection(result.documents.flatMap(d => d.memory.source)); index.commit();
      const packet = boundBridgeResult(toBridgeResult(snapshot.manifest.snapshotId, result));
      rounds.push({ round: round + 1, documents: documents.length, cacheHits: index.hits, cacheMisses: index.misses,
        ids: result.documents.map(d => d.memory.memoryId), budgetedIds: packet.memories.map(m => m.memoryId),
        expected: selected.primaryAnchors.map(id => ({ id, budgeted: packet.memories.some(m => m.memoryId === id) })),
        projectionMs: Math.round(projected - started), searchAndRecheckMs: Math.round(performance.now() - projected) });
    } finally { index.close(); }
  }
  for (const [relative, sha] of Object.entries(snapshot.manifest.files)) if (hash(readBounded(safePath(sourceRoot, relative))) !== sha) throw Error("CRP_INDEX_VERIFY_SOURCE_CHANGED");
  if (hash(readBounded(safePath(sourceRoot, "snapshot.json"))) !== manifestSha) throw Error("CRP_INDEX_VERIFY_SOURCE_CHANGED");
  console.log(JSON.stringify({ mode: "explicit-disposable-index-verification", snapshotId: snapshot.manifest.snapshotId,
    protectedFiles: Object.keys(snapshot.manifest.files).length, sourceBytesRevalidated: true, modelCalls: 0, paidApiCalls: 0, rounds }, null, 2));
  if (rounds.some(r => r.expected.some(e => !e.budgeted)) || !rounds[1].cacheHits) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error && /^(?:CRP_INDEX_VERIFY|BRIDGE)_[A-Z_]+$/.test(error.message) ? error.message : "CRP_INDEX_VERIFY_FAILED");
  process.exitCode = 2;
}
