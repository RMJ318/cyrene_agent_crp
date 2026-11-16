import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import type { BridgeMemory, BridgeResult } from "../../shared/memory-bridge";
import { CrpSnapshot } from "../memory-bridge/snapshot";
import { assertNotAborted, hash, validTime } from "../memory-bridge/safety";
import { boundBridgeResult } from "../memory-bridge/result-budget";
import { retrieveCrp, toBridgeResult } from "./retrieval";
import type { GatewayExecutor, GatewayPrincipal } from "./query-gateway";

/** Read-only compatibility backend. All navigation starts from the same authorized legacy projection. */
export function createSnapshotQueryExecutor(snapshot: CrpSnapshot, cursorKey: Buffer, provenance?: { repository: string; commit: string }): GatewayExecutor {
  if (cursorKey.length < 32) throw Error("CRP_CURSOR_KEY_REQUIRED");
  const receipts = new Map<string, { context: string; result: unknown }>();
  const fingerprint = (p: GatewayPrincipal) => hash(JSON.stringify([snapshot.manifest, p, provenance]));
  const sign = (text: string) => createHmac("sha256", cursorKey).update(text).digest("base64url");
  const page = (input: Record<string, unknown>, context: string, query: string, memories: BridgeMemory[]) => {
    const limit = input.limit === undefined ? 20 : input.limit;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw Error("CRP_PAGE_LIMIT");
    let offset = 0;
    if (input.cursor !== undefined && input.cursor !== null) {
      if (typeof input.cursor !== "string" || input.cursor.length > 4096) throw Error("CRP_CURSOR");
      const [body, signature, extra] = input.cursor.split(".");
      if (!body || !signature || extra || Buffer.byteLength(signature) !== Buffer.byteLength(sign(body)) || !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(body)))) throw Error("CRP_CURSOR");
      const parsed = JSON.parse(Buffer.from(body, "base64url").toString());
      if (parsed.context !== context || parsed.query !== query || parsed.expires < Date.now() || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw Error("CRP_CURSOR"); offset = parsed.offset;
    }
    const selected = memories.slice(offset, offset + Number(limit));
    const next = offset + selected.length;
    const body = Buffer.from(JSON.stringify({ context, query, offset: next, expires: Date.now() + 600000 })).toString("base64url");
    return { memories: selected, nextCursor: next < memories.length ? `${body}.${sign(body)}` : null };
  };
  return async (principal, request, signal) => {
    assertNotAborted(signal); snapshot.verifyProjection([], signal);
    const context = fingerprint(principal), input = request.input;
    if (request.operation === "context") return { context, snapshotId: snapshot.manifest.snapshotId,
      ...(provenance ? { sourceRepository: provenance.repository, sourceCommit: provenance.commit } : {}),
      scopes: principal.scopes, capabilities: ["context", "search", "read", "timeline", "related", "explain"],
      limitations: ["Legacy compatibility projection; canonical continuity/coverage services are not ready. No personal stores or model calls."] };
    if (input.context !== context) throw Error("CRP_CONTEXT_CHANGED");
    if (request.operation === "explain") {
      if (typeof input.receiptId !== "string") throw Error("CRP_RECEIPT");
      const receipt = receipts.get(input.receiptId); return receipt?.context === context ? receipt.result : { status: "unknown", gaps: ["Receipt is unavailable in this context."] };
    }
    let result: BridgeResult, nextCursor: string | null = null;
    if (request.operation === "search") {
      if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 2000) throw Error("CRP_QUERY_LIMIT");
      const docs = principal.scopes.flatMap(s => snapshot.documents(s, signal)), aliases = principal.scopes.flatMap(s => snapshot.identityAliases(s));
      const found = await retrieveCrp(input.query, docs, { signal, localAllowed: false, aliases, selectedRealities: principal.scopes.map(s => s.realityId) });
      result = boundBridgeResult(toBridgeResult(snapshot.manifest.snapshotId, found));
    } else if (request.operation === "read") {
      if (typeof input.memoryId !== "string" || input.memoryId.length > 300 || input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0)) throw Error("CRP_READ_LIMIT");
      const responses = principal.scopes.map(s => snapshot.get(s, input.memoryId as string, Number(input.offset ?? 0), signal));
      result = { status: "unknown", memories: [], gaps: [], snapshotId: snapshot.manifest.snapshotId };
      for (const response of responses) { result.memories.push(...response.memories); result.gaps.push(...response.gaps); }
      result.status = result.memories.length ? "ok" : "unknown";
    } else if (request.operation === "timeline" || request.operation === "related") {
      let candidates = principal.scopes.flatMap(s => snapshot.candidates(s, signal));
      if (request.operation === "timeline") {
        if (!Number.isSafeInteger(input.fromDay) || !Number.isSafeInteger(input.toDay) || Number(input.fromDay) < 0 || Number(input.toDay) < Number(input.fromDay)) throw Error("CRP_TIMELINE_RANGE");
        candidates = candidates.filter(m => validTime(m.eventTime) && m.eventTime.day >= Number(input.fromDay) && m.eventTime.day <= Number(input.toDay))
          .sort((a, b) => (validTime(a.eventTime) ? a.eventTime.day : 0) - (validTime(b.eventTime) ? b.eventTime.day : 0) || a.memoryId.localeCompare(b.memoryId));
      } else {
        if (typeof input.memoryId !== "string") throw Error("CRP_RELATED_ID");
        const seeds = candidates.filter(m => m.memoryId === input.memoryId);
        candidates = candidates.filter(m => m.memoryId !== input.memoryId && seeds.some(seed => seed.domain === m.domain && seed.realityId === m.realityId && seed.branchId === m.branchId
          && (seed.participants.some(id => m.participants.includes(id)) || seed.source.some(a => m.source.some(b => a.evidenceId && a.evidenceId === b.evidenceId)))));
      }
      const query = hash(JSON.stringify([request.operation, { ...input, cursor: undefined }]));
      const paged = page(input, context, query, candidates); nextCursor = paged.nextCursor;
      result = { status: paged.memories.length ? "ok" : "unknown", memories: paged.memories, gaps: ["Navigation matches are not proof of relationship or character knowledge."], snapshotId: snapshot.manifest.snapshotId };
    } else return { status: "not_ready", context, gaps: ["Canonical continuity and coverage require reviewed migration; legacy audit evidence is preserved, not promoted."] };
    snapshot.verifyProjection(result.memories.flatMap(m => m.source), signal); assertNotAborted(signal);
    const receiptId = randomUUID(), receipt = { receiptId, context, snapshotId: snapshot.manifest.snapshotId, operation: request.operation,
      evidence: result.memories.flatMap(m => m.source), modelCalls: 0, gaps: result.gaps };
    if (receipts.size >= 512) receipts.delete(receipts.keys().next().value!); receipts.set(receiptId, { context, result: receipt });
    return { ...result, context, receiptId, nextCursor };
  };
}
