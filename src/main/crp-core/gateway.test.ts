import { afterEach, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createCrpQueryGateway, type GatewayCredential } from "./query-gateway";
import { hash } from "../memory-bridge/safety";
import { createCrpCloudAdapter } from "./cloud-adapter";
import { CrpModelRuntime } from "./model-runtime";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
async function fixture(executor: Parameters<typeof createCrpQueryGateway>[1], audit?: Parameters<typeof createCrpQueryGateway>[2]) {
  const token = randomBytes(32).toString("base64url");
  let credentials: GatewayCredential[] = [{ tokenSha256: hash(token), principal: { id: "role-profile", policyVersion: "p1", expiresAt: Date.now() + 60000,
    scopes: [{ domain: "rp", realityId: "42", branchId: null, audience: "character-knowledge", characterId: "river", asOf: { day: 9 } }] } }];
  const server = createCrpQueryGateway(() => credentials, executor, audit);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  closers.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw Error("test bind");
  const call = (input: unknown, authorized = true) => fetch(`http://127.0.0.1:${address.port}/v1/search`, { method: "POST", headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input) });
  return { call, revoke: () => { credentials = []; }, credentials };
}
it("rejects missing auth and model-supplied scope, binding successful requests to the host identity", async () => {
  const executor = vi.fn(async (p: GatewayCredential["principal"]) => ({ reality: p.scopes[0].realityId })), f = await fixture(executor);
  expect((await f.call({}, false)).status).toBe(401); expect(executor).not.toHaveBeenCalled();
  expect((await f.call({ realityId: "43" })).status).toBe(400); expect(executor).not.toHaveBeenCalled();
  const response = await f.call({ query: "fiction" }); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ reality: "42", requestId: expect.any(String) });
});
it("blocks revocation during an in-flight query and sanitizes private errors", async () => {
  let finish!: () => void;
  const f = await fixture(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { secret: "not released" }; });
  const reply = f.call({});
  await vi.waitFor(() => expect(finish).toBeTypeOf("function")); f.revoke(); finish();
  const response = await reply; expect(response.status).toBe(403); expect(await response.text()).not.toContain("not released");
  const failed = await fixture(async () => { throw Error("private path and key"); });
  expect(await (await failed.call({})).json()).toEqual({ error: "QUERY_FAILED" });
});
it("bounds requests before invoking the backend", async () => {
  const executor = vi.fn(async () => ({})), f = await fixture(executor);
  expect((await f.call({ query: "x".repeat(20000) })).status).toBe(413); expect(executor).not.toHaveBeenCalled();
});
it("returns matchable request receipts while keeping prompt, payload and credentials out of audit metadata", async () => {
  const audit = vi.fn(); const f = await fixture(async () => ({ snapshotId: "snapshot", receiptId: "receipt", memory: "private source body" }), audit);
  const response = await f.call({ query: "private prompt" }), body = await response.json() as { requestId: string };
  expect(response.headers.get("x-crp-request-id")).toBe(body.requestId);
  expect(audit).toHaveBeenCalledWith({ requestId: body.requestId, principalId: "role-profile", operation: "search", at: expect.any(String), status: 200, snapshotId: "snapshot", receiptId: "receipt" });
  const serialized = JSON.stringify(audit.mock.calls); expect(serialized).not.toContain("private prompt"); expect(serialized).not.toContain("private source body"); expect(serialized).not.toContain("Bearer");
});
it("keeps cloud transports dormant until separately authorized and does not leak adapter errors", async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 }, choices: [{ finish_reason: "stop", message: { content: "[1,2]" } }] }), { status: 200 }));
  const route = { provider: "openai" as const, model: "mock", identity: "approved-profile" };
  const adapter = createCrpCloudAdapter({ ...route, credential: () => "mock-secret", inputUsdPerMillion: 1, outputUsdPerMillion: 1, maxOutputTokens: 10 }, transport);
  const runtime = new CrpModelRuntime({ openai: adapter });
  const job = { capability: "rerank" as const, input: ["fiction"], routeIdentity: route.identity, allowCloudDisclosure: true, maxCostUsd: 0.01 };
  await expect(runtime.execute(job)).rejects.toThrow("ROUTE_UNAVAILABLE"); expect(transport).not.toHaveBeenCalled();
  runtime.configure({ localAllowed: false, cloudAllowed: true, sessionAllowed: false, budgetUsd: 0.1, routes: { rerank: route } });
  expect(await runtime.execute(job)).toEqual([1, 2]); expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0][1]?.redirect).toBe("error");
  await expect(runtime.execute({ ...job, maxCostUsd: 0.000001 })).rejects.toThrow("BUDGET_EXCEEDED"); expect(transport).toHaveBeenCalledTimes(1);
});
