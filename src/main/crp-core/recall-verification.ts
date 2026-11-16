import fs from "node:fs";
import type { BridgeMemory, BridgeScope } from "../../shared/memory-bridge";
import { CrpSnapshot } from "../memory-bridge/snapshot";
import { boundBridgeResult } from "../memory-bridge/result-budget";
import { fail, hash, readBounded, safePath } from "../memory-bridge/safety";
import { rankTextCandidates } from "../rag/text-ranking";
import { retrieveCrp, toBridgeResult } from "./retrieval";

/** Compares real bytes and the final packet without opening personal stores or invoking models. */
export async function verifySnapshotRecall(root: string, input: { query: string; realities: string[]; expectedIds: string[]; detailIds?: string[] }) {
  if (!input.realities.length || input.realities.length > 32 || input.realities.some(id => !/^(0|[1-9]\d*)$/.test(id))
    || !input.query.trim() || input.query.length > 2000 || !input.expectedIds.length) fail("INVALID_VERIFICATION_REQUEST");
  const started = performance.now();
  const manifest = safePath(root, "snapshot.json"), manifestHash = hash(readBounded(manifest));
  const snapshot = new CrpSnapshot(root); snapshot.validate();
  const validatedMs = Math.round(performance.now() - started);
  const scopes: BridgeScope[] = [...new Set(input.realities)].map(realityId => ({ domain: realityId === "0" ? "reality0" : "rp", realityId, branchId: null, audience: "archive-reference" }));
  const allLegacy = scopes.flatMap(scope => snapshot.search(scope, input.query).memories);
  const legacy = rankTextCandidates(input.query, allLegacy.map(item => ({ item, text: item.content })), 5).filter(row => row.score > 0).map(row => row.item);
  const indexingStarted = performance.now();
  const documents = scopes.flatMap(scope => snapshot.documents(scope));
  const aliases = scopes.flatMap(scope => snapshot.identityAliases(scope));
  const projectionMs = Math.round(performance.now() - indexingStarted);
  let modelAttempts = 0;
  const searchingStarted = performance.now();
  const result = await retrieveCrp(input.query, documents, { localAllowed: false,
    localProvider: () => { modelAttempts++; fail("MODELS_FORBIDDEN_IN_VERIFICATION"); }, aliases, selectedRealities: input.realities });
  const searchMs = Math.round(performance.now() - searchingStarted);
  const packet = boundBridgeResult(toBridgeResult(snapshot.manifest.snapshotId, result));
  const describe = (memory: BridgeMemory) => ({ id: memory.memoryId, realityId: memory.realityId, contentKind: memory.contentKind });
  const details = [...new Set([...input.expectedIds, ...(input.detailIds ?? [])])].map(id => {
    let memory: BridgeMemory | undefined;
    for (const scope of scopes) { memory = snapshot.get(scope, id).memories[0]; if (memory) break; }
    return { id, found: !!memory, contentKind: memory?.contentKind, sourceVerification: memory?.sourceVerification,
      characters: memory ? Array.from(memory.content).length : 0, eventTime: memory?.eventTime,
      evidence: memory?.source.map(source => ({ evidenceId: source.evidenceId, sha256: source.sha256, excerptSha256: source.excerptSha256, lineStart: source.lineStart, lineEnd: source.lineEnd })) ?? [] };
  });
  // Every source and assessment remains checked after retrieval. No source is rewritten.
  for (const [relative, digest] of Object.entries(snapshot.manifest.files)) {
    if (hash(readBounded(safePath(root, relative))) !== digest) fail("SOURCE_CHANGED");
  }
  if (hash(fs.readFileSync(manifest)) !== manifestHash) fail("SOURCE_CHANGED");
  return {
    mode: "read-only-snapshot-comparison" as const, snapshotId: snapshot.manifest.snapshotId, manifestSha256: manifestHash,
    protectedFiles: Object.keys(snapshot.manifest.files).length, sourceBytesRevalidated: true,
    selectedRealities: input.realities, legacy: legacy.map(describe), v3: result.documents.map(d => describe(d.memory)), budgeted: packet.memories.map(describe),
    trace: result.trace, details,
    expected: input.expectedIds.map(id => ({ id, legacy: legacy.some(m => m.memoryId === id), v3: result.documents.some(d => d.memory.memoryId === id), budgeted: packet.memories.some(m => m.memoryId === id) })),
    modelAttempts, paidModelCalls: 0, runtimeAnswerVerified: false,
    timing: { validatedMs, projectionMs, searchMs, totalMs: Math.round(performance.now() - started) },
  };
}
