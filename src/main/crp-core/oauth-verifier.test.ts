import { generateKeyPairSync, sign } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { createCrpJwksLoader, createCrpOAuthVerifier, type CrpOAuthConfig } from "./oauth-verifier";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "one", alg: "RS256", use: "sig" };
function fixture() {
  const now = Math.floor(Date.now() / 1000);
  const config: CrpOAuthConfig = { issuer: "https://login.example/realm", resource: "https://memory.example/mcp", jwksUri: "https://login.example/realm/keys", allowedClients: ["chatgpt"],
    bindings: [{ subject: "owner", principal: { id: "cyrene-after", policyVersion: "v1", expiresAt: Date.now() + 3600000,
      scopes: [{ domain: "rp", realityId: "42", branchId: null, audience: "character-knowledge", characterId: "cyrene", asOf: { day: 9 } }] } }] };
  const claims = { iss: config.issuer, aud: config.resource, sub: "owner", azp: "chatgpt", scope: "openid crp:read", iat: now, exp: now + 300, typ: "Bearer" };
  const token = (extra = {}, headerExtra = {}) => {
    const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "one", ...headerExtra })).toString("base64url"), body = Buffer.from(JSON.stringify({ ...claims, ...extra })).toString("base64url");
    return head + "." + body + "." + sign("RSA-SHA256", Buffer.from(head + "." + body), pair.privateKey).toString("base64url");
  };
  const req = (value: string) => ({ rawHeaders: ["Authorization", "Bearer " + value], headers: { authorization: "Bearer " + value } }) as IncomingMessage;
  const signal = new AbortController().signal;
  return { config, claims, token, req, signal, verify: createCrpOAuthVerifier(() => config, async () => [jwk]) };
}
describe("CRP OAuth resource verification", () => {
  it("accepts a real RS256 signature with exact audience and only host-issued character scope", async () => {
    const f = fixture();
    const principal = await f.verify(f.req(f.token({ realityId: "evil", characterId: "author", roles: ["admin"] })), f.signal);
    expect(principal?.scopes).toEqual(f.config.bindings[0].principal.scopes);
    expect(principal?.expiresAt).toBe(f.claims.exp * 1000);
    f.config.bindings = []; expect(await f.verify(f.req(f.token()), f.signal)).toBeNull();
  });
  it("rejects wrong issuer/audience/client/subject/scope/time, id tokens and algorithm confusion", async () => {
    const f = fixture();
    for (const extra of [{ iss: "https://evil.example" }, { aud: "other" }, { azp: "other" }, { sub: "other" }, { scope: "openid" }, { exp: 1 }, { exp: f.claims.iat + 901 }, { iat: f.claims.iat + 100 }, { typ: "ID" }]) {
      expect(await f.verify(f.req(f.token(extra)), f.signal)).toBeNull();
    }
    for (const head of [{ alg: "none" }, { alg: "HS256" }, { jku: "https://evil.example/keys" }, { kid: "unknown" }, { crit: ["custom"] }]) expect(await f.verify(f.req(f.token({}, head)), f.signal)).toBeNull();
    const parts = f.token().split("."); parts[1] = Buffer.from(JSON.stringify({ ...f.claims, sub: "attacker" })).toString("base64url");
    expect(await f.verify(f.req(parts.join(".")), f.signal)).toBeNull();
    const duplicate = f.req(f.token()); duplicate.rawHeaders.push("authorization", duplicate.headers.authorization!);
    expect(await f.verify(duplicate, f.signal)).toBeNull();
  });
  it("bounds and coalesces JWKS fetches and rejects redirects, oversized or invalid responses", async () => {
    const f = fixture(); let count = 0;
    const loader = createCrpJwksLoader(async (_, init) => { count++; expect(init?.redirect).toBe("error"); return new Response(JSON.stringify({ keys: [jwk] })); });
    const results = await Promise.all([loader(f.config, f.signal), loader(f.config, f.signal)]);
    expect(count).toBe(1); expect(results[0]).toEqual(results[1]);
    await loader(f.config, f.signal); expect(count).toBe(1);
    await expect(createCrpJwksLoader(async () => new Response("x".repeat(70000)))(f.config, f.signal)).rejects.toThrow();
    await expect(createCrpJwksLoader(async () => new Response(JSON.stringify({ keys: [] })))(f.config, f.signal)).rejects.toThrow();
  });
});
