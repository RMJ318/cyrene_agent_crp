import type { BridgeResult } from "../../shared/memory-bridge";
import { estimateTokens } from "../orchestrator/token-estimate";

/** Bound the complete wire envelope, including provenance; never silently remove source references. */
export function boundBridgeResult(input: BridgeResult, budget = 2000): BridgeResult {
  const result = structuredClone(input);
  let changed = false;
  while (estimateTokens(JSON.stringify(result)) > budget && result.memories.length > 1) { result.memories.pop(); changed = true; }
  while (estimateTokens(JSON.stringify(result)) > budget && result.memories[0]?.content.length > 80) {
    const first = result.memories[0]; const chars = Array.from(first.content);
    first.content = chars.slice(0, Math.floor(chars.length / 2)).join(""); first.truncated = true;
    if (first.contentKind === "verbatim") first.nextOffset = (first.contentOffset ?? 0) + Array.from(first.content).length;
    changed = true;
  }
  if (changed) result.gaps.push("Result truncated to the local 2000-token estimate; request a specific memory for details.");
  if (estimateTokens(JSON.stringify(result)) > budget) return { status: "insufficient_evidence", memories: [], gaps: ["Evidence metadata exceeds the result budget; narrow the query."], snapshotId: result.snapshotId };
  return result;
}
