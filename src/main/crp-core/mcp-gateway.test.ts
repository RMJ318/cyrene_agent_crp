import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { createCrpMcpGateway } from "./mcp-gateway";
import type { GatewayExecutor, GatewayPrincipal } from "./query-gateway";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }))); servers.length = 0; });
const principal = (id = "after"): GatewayPrincipal => ({ id, scopes: [{ domain: "rp", realityId: "42", branchId: null, audience: "character-knowledge", characterId: id, asOf: { day: 9 } }], expiresAt: Date.now() + 60000, policyVersion: "v1" });
async function setup(execute?: GatewayExecutor, authenticate?: Parameters<typeof createCrpMcpGateway>[0]["authenticate"], publicDiscovery = false) {
  const identities = new Map([["after", principal()], ["before", principal("before")]]);
  let generation = "one";
  const events: unknown[] = [];
  const server = createCrpMcpGateway({ resource: "https://memory.example/mcp", authorizationServers: ["https://login.example"], cursorKey: randomBytes(32),
    publicDiscovery,
    authenticate: authenticate ?? (async req => identities.get(String(req.headers.authorization ?? "").replace("Bearer ", "")) ?? null),
    execute: execute ?? (async (p, request) => {
      const context = generation + p.id;
      if (request.operation === "context") return { context, snapshotId: generation };
      if (request.input.context !== context) throw Error("CHANGED");
      return { context, snapshotId: generation, receiptId: "receipt", gaps: [], memories: request.operation === "search"
        ? [{ memoryId: "event:hello" }]
        : [{ memoryId: "event:hello", content: request.input.offset === 0 ? "first" : "second", truncated: request.input.offset === 0, nextOffset: request.input.offset === 0 ? 5 : undefined,
          contentKind: "verbatim", sourceVerification: "SOURCE_AND_EXCERPT_SHA256_VERIFIED", source: [{ sha256: "fixture" }] }] };
    }), audit: event => events.push(event) });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port, url = `http://127.0.0.1:${port}`;
  let id = 0;
  const rpc = async (method: string, params: unknown = {}, token = "after") => {
    const response = await fetch(url + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + token },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    return { status: response.status, body: await response.json() as { result?: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }>; isError?: boolean; structuredContent: Record<string, unknown> }; error?: unknown } };
  };
  return { url, rpc, identities, events, switchSnapshot: () => { generation = "two"; } };
}
describe("CRP read-only MCP transport", () => {
  it("can expose generic discovery without releasing data or accepting anonymous tools/call", async () => {
    let executions = 0;
    const fixture = await setup(async () => { executions++; throw Error("MUST_NOT_RUN"); }, undefined, true);
    const send = async (method: string, params: unknown) => fetch(fixture.url + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const listed = await send("tools/list", {});
    expect(listed.status).toBe(200);
    const body = await listed.json() as { result: { tools: Array<{ securitySchemes: unknown[] }> } };
    expect(body.result.tools.every(tool => tool.securitySchemes.length === 1)).toBe(true);
    const denied = await send("tools/call", { name: "search", arguments: { query: "hello" } });
    expect(denied.status).toBe(200);
    const challenge = await denied.json() as { result: { isError: boolean; _meta: Record<string, string[]> } };
    expect(challenge.result.isError).toBe(true);
    expect(challenge.result._meta["mcp/www_authenticate"][0]).toContain('error="invalid_token"');
    expect(challenge.result._meta["mcp/www_authenticate"][0]).toContain('error_description="Sign in to CRP Memory to continue"');
    expect(challenge.result._meta["mcp/www_authenticate"][0]).toContain('resource_metadata="https://memory.example/.well-known/oauth-protected-resource"');
    expect(executions).toBe(0);
  });
  it("uses official initialize, advertises only read-only search/fetch and challenges unauthenticated access", async () => {
    const fixture = await setup();
    const meta = await fetch(fixture.url + "/.well-known/oauth-protected-resource");
    expect(await meta.json()).toMatchObject({ resource: "https://memory.example/mcp", scopes_supported: ["crp:read"] });
    const denied = await fetch(fixture.url + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(denied.status).toBe(401); expect(denied.headers.get("www-authenticate")).toContain("resource_metadata=");
    const init = await fixture.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.status).toBe(200); expect(init.body.error).toBeUndefined();
    const list = await fixture.rpc("tools/list");
    expect(list.body.result?.tools.map(tool => tool.name)).toEqual(["search", "fetch"]);
    expect(list.body.result?.tools.every(tool => tool.annotations.readOnlyHint)).toBe(true);
  });
  it("keeps proof and paginates; refuses forged, cross-identity and old-snapshot fetch ids", async () => {
    const fixture = await setup();
    const search = await fixture.rpc("tools/call", { name: "search", arguments: { query: "hello" } });
    const results = search.body.result?.structuredContent.results as Array<{ id: string }>;
    const first = await fixture.rpc("tools/call", { name: "fetch", arguments: { id: results[0].id } });
    expect(first.body.result?.structuredContent).toMatchObject({ text: "first", metadata: { contentKind: "verbatim", sourceVerification: "SOURCE_AND_EXCERPT_SHA256_VERIFIED" } });
    const next = first.body.result?.structuredContent.nextId;
    const second = await fixture.rpc("tools/call", { name: "fetch", arguments: { id: next } });
    expect(second.body.result?.structuredContent).toMatchObject({ text: "second", nextId: null });
    const foreign = await fixture.rpc("tools/call", { name: "fetch", arguments: { id: results[0].id } }, "before");
    expect(foreign.body.result?.isError).toBe(true);
    expect((await fixture.rpc("tools/call", { name: "fetch", arguments: { id: results[0].id + "x" } })).body.result?.isError).toBe(true);
    fixture.switchSnapshot();
    expect((await fixture.rpc("tools/call", { name: "fetch", arguments: { id: results[0].id } })).body.result?.isError).toBe(true);
    expect(JSON.stringify(fixture.events)).not.toContain("hello");
  });
  it("rejects model-selected scope, write tools, browser origins and oversized requests", async () => {
    const fixture = await setup();
    expect((await fixture.rpc("tools/call", { name: "search", arguments: { query: "hello", realityId: "elsewhere" } })).body.result?.isError).toBe(true);
    expect((await fixture.rpc("tools/call", { name: "write", arguments: { query: "hello" } })).body.result?.isError).toBe(true);
    const origin = await fetch(fixture.url + "/mcp", { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" });
    expect(origin.status).toBe(403);
    const large = await fetch(fixture.url + "/mcp", { method: "POST", headers: { Authorization: "Bearer after", "Content-Type": "application/json" }, body: "x".repeat(17000) });
    expect(large.status).toBe(413);
  });
  it("rechecks revocation while retrieval is in flight and releases no body", async () => {
    let reached!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
    const fixture = await setup(async (_, request) => {
      if (request.operation === "context") return { context: "one" };
      reached(); await waiting; return { memories: [{ memoryId: "private-result" }] };
    });
    const pending = fixture.rpc("tools/call", { name: "search", arguments: { query: "hello" } });
    await started; fixture.identities.delete("after"); release();
    const response = await pending;
    expect(response.body.result?.isError).toBe(true); expect(JSON.stringify(response.body)).not.toContain("private-result"); expect(fixture.events).toHaveLength(0);
  });
  it("bounds concurrent requests before expensive authentication", async () => {
    let release!: () => void, reached!: () => void, count = 0;
    const barrier = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { reached = resolve; });
    const fixture = await setup(undefined, async () => { if (++count === 16) reached(); await barrier; return null; });
    const pending = Array.from({ length: 16 }, () => fixture.rpc("tools/list"));
    try { await started; expect((await fixture.rpc("tools/list")).status).toBe(429); expect(count).toBe(16); }
    finally { release(); await Promise.all(pending); }
  });
});
