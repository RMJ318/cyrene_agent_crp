import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { hash } from "../memory-bridge/safety";
import type { BridgeScope } from "../../shared/memory-bridge";
import { validateScope } from "../memory-bridge/safety";

export interface GatewayPrincipal { id: string; scopes: BridgeScope[]; expiresAt: number; policyVersion: string }
export interface GatewayCredential { tokenSha256: string; principal: GatewayPrincipal }
export type GatewayOperation = "context" | "search" | "read" | "timeline" | "related" | "continuity" | "coverage" | "explain";
export interface GatewayRequest { operation: GatewayOperation; input: Record<string, unknown> }
export type GatewayExecutor = (principal: GatewayPrincipal, request: GatewayRequest, signal: AbortSignal) => Promise<unknown>;
export interface GatewayAuditEvent { requestId: string; principalId: string; operation: GatewayOperation; at: string; status: 200; snapshotId?: string; receiptId?: string }
/** Transport only. Authenticated identities and scope are host-issued, never accepted in the request body. */
export function createCrpQueryGateway(credentials: () => readonly GatewayCredential[], execute: GatewayExecutor, audit?: (event: GatewayAuditEvent) => void) {
  const buckets = new Map<string, { minute: number; count: number }>();
  const send = (res: ServerResponse, status: number, body: unknown, requestId?: string) => {
    if (res.destroyed) return;
    const data = JSON.stringify(requestId && body && typeof body === "object" && !Array.isArray(body) ? { ...body, requestId } : body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(requestId ? { "X-CRP-Request-ID": requestId } : {}) }); res.end(data);
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const controller = new AbortController(); req.once("aborted", () => controller.abort());
    res.once("close", () => { if (!res.writableEnded) controller.abort(); });
    const timeout = setTimeout(() => { controller.abort(); send(res, 504, { error: "QUERY_TIMEOUT" }); }, 30000); timeout.unref();
    try {
      const auth = req.headers.authorization;
      const headers = req.rawHeaders.filter((_, i) => i % 2 === 0).filter(x => x.toLowerCase() === "authorization");
      if (typeof auth !== "string" || headers.length !== 1 || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(auth)) { send(res, 401, { error: "UNAUTHORIZED" }); return; }
      const digest = Buffer.from(hash(auth.slice(7)), "hex");
      const available = credentials(); if (available.length > 128) throw Error("CREDENTIAL_LIMIT");
      const matched = available.filter(c => /^[a-f0-9]{64}$/.test(c.tokenSha256) && timingSafeEqual(Buffer.from(c.tokenSha256, "hex"), digest));
      if (matched.length !== 1 || matched[0].principal.expiresAt <= Date.now()) { send(res, 401, { error: "UNAUTHORIZED" }); return; }
      const principal = structuredClone(matched[0].principal);
      if (!/^[\w.-]{1,160}$/.test(principal.id) || !principal.policyVersion || !Number.isFinite(principal.expiresAt) || !principal.scopes.length || principal.scopes.length > 32) throw Error("INVALID_PRINCIPAL");
      principal.scopes = principal.scopes.map(validateScope);
      if (principal.scopes.some(s => s.domain === "writer")) { send(res, 403, { error: "PRIVATE_STORE_UNAVAILABLE" }); return; }
      const minute = Math.floor(Date.now() / 60000), previous = buckets.get(principal.id);
      const bucket = previous?.minute === minute ? previous : { minute, count: 0 };
      if (++bucket.count > 60) { send(res, 429, { error: "RATE_LIMIT" }); return; }
      buckets.set(principal.id, bucket); for (const [id, b] of buckets) if (b.minute < minute) buckets.delete(id);
      const match = /^\/v1\/(context|search|read|timeline|related|continuity|coverage|explain)$/.exec(req.url ?? "");
      if (!match || req.method !== "POST") { send(res, 404, { error: "NOT_FOUND" }); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) { send(res, 415, { error: "JSON_REQUIRED" }); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const part of req) {
        size += part.length; if (size > 16 * 1024) { send(res, 413, { error: "BODY_LIMIT" }); req.resume(); return; } chunks.push(Buffer.from(part));
      }
      let input: Record<string, unknown>;
      try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { send(res, 400, { error: "INVALID_JSON" }); return; }
      if (!input || typeof input !== "object" || Array.isArray(input) || ["scope", "scopes", "realities", "realityId", "audience", "characterId", "policyVersion", "principal"].some(key => key in input)) { send(res, 400, { error: "HOST_SCOPE_REQUIRED" }); return; }
      const request = { operation: match[1] as GatewayOperation, input };
      const result = await execute(principal, request, controller.signal);
      // Credential rotation, expiry or scope revocation during the query must prevent release.
      const current = credentials().find(c => c.tokenSha256 === matched[0].tokenSha256);
      if (controller.signal.aborted) return;
      if (!current || current.principal.expiresAt <= Date.now() || hash(JSON.stringify(current.principal)) !== hash(JSON.stringify(principal))) { send(res, 403, { error: "AUTHORIZATION_CHANGED" }); return; }
      if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw Error("RESULT_LIMIT");
      const requestId = randomUUID(), metadata = result && typeof result === "object" ? result as Record<string, unknown> : {};
      audit?.({ requestId, principalId: principal.id, operation: request.operation, at: new Date().toISOString(), status: 200,
        ...(typeof metadata.snapshotId === "string" ? { snapshotId: metadata.snapshotId } : {}), ...(typeof metadata.receiptId === "string" ? { receiptId: metadata.receiptId } : {}) });
      send(res, 200, result, requestId);
    } catch { send(res, controller.signal.aborted ? 504 : 400, { error: controller.signal.aborted ? "QUERY_TIMEOUT" : "QUERY_FAILED" }); }
    finally { clearTimeout(timeout); }
  });
  server.headersTimeout = 5000; server.requestTimeout = 10000; server.maxHeadersCount = 32;
  return server;
}
