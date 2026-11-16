import { createPublicKey, verify, type webcrypto } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { validateScope } from "../memory-bridge/safety";
import type { GatewayPrincipal } from "./query-gateway";
type JsonWebKey = webcrypto.JsonWebKey & { kid?: string };

export interface CrpOAuthConfig {
  issuer: string;
  resource: string;
  jwksUri: string;
  allowedClients: string[];
  bindings: Array<{ subject: string; principal: GatewayPrincipal }>;
}
export function validateOAuthConfig(value: CrpOAuthConfig): CrpOAuthConfig {
  const config = structuredClone(value), issuer = new URL(config.issuer), resource = new URL(config.resource), keys = new URL(config.jwksUri);
  if ([issuer, resource, keys].some(url => url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    || resource.pathname !== "/mcp" || issuer.origin !== keys.origin || !Array.isArray(config.allowedClients) || !config.allowedClients.length || config.allowedClients.length > 16
    || config.allowedClients.some(id => typeof id !== "string" || !id || id.length > 250) || !Array.isArray(config.bindings) || config.bindings.length > 32
    || new Set(config.bindings.map(row => row.subject)).size !== config.bindings.length) throw Error("CRP_OAUTH_CONFIG");
  for (const row of config.bindings) {
    if (typeof row.subject !== "string" || !row.subject || row.subject.length > 250 || !row.principal || !/^[\w.-]{1,160}$/.test(row.principal.id)
      || !row.principal.policyVersion || !Number.isFinite(row.principal.expiresAt) || !Array.isArray(row.principal.scopes) || !row.principal.scopes.length || row.principal.scopes.length > 32) throw Error("CRP_OAUTH_BINDING");
    row.principal.scopes = row.principal.scopes.map(validateScope);
    if (row.principal.scopes.some(scope => scope.domain === "writer")) throw Error("CRP_OAUTH_PRIVATE_DENIED");
  }
  return config;
}

/** Resource-server verification only. Login, consent, PKCE, codes and refresh belong to the established OAuth server. */
export function createCrpOAuthVerifier(load: () => CrpOAuthConfig, loadKeys: (config: CrpOAuthConfig, signal: AbortSignal) => Promise<JsonWebKey[]>) {
  return async (req: IncomingMessage, signal: AbortSignal): Promise<GatewayPrincipal | null> => {
    try {
      const headers = req.rawHeaders.filter((_, i) => i % 2 === 0).filter(name => name.toLowerCase() === "authorization");
      if (headers.length !== 1 || typeof req.headers.authorization !== "string" || !/^Bearer [A-Za-z0-9_.-]{40,12000}$/.test(req.headers.authorization)) return null;
      const token = req.headers.authorization.slice(7), parts = token.split(".");
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString()), claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 150 || header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined
        || !claims || typeof claims.sub !== "string") return null;
      const config = validateOAuthConfig(load()), now = Date.now() / 1000;
      if (claims.iss !== config.issuer || !(typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : []).includes(config.resource)
        || !Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) || claims.iat > now + 30 || claims.iat < now - 900
        || claims.exp - claims.iat > 900 || claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30)
        || claims.typ !== undefined && claims.typ !== "Bearer" || typeof claims.scope !== "string" || !claims.scope.split(/\s+/).includes("crp:read")
        || !config.allowedClients.includes(claims.azp ?? claims.client_id)) return null;
      const binding = config.bindings.find(row => row.subject === claims.sub);
      if (!binding || binding.principal.expiresAt <= Date.now()) return null;
      const keys = await loadKeys(config, signal);
      if (signal.aborted || keys.length > 64) return null;
      const matches = keys.filter(key => key.kid === header.kid && key.kty === "RSA" && (!key.use || key.use === "sig") && (!key.alg || key.alg === "RS256"));
      if (matches.length !== 1) return null;
      const key = createPublicKey({ key: matches[0], format: "jwk" });
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || !verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), key, Buffer.from(parts[2], "base64url"))) return null;
      // Do not derive a role, reality or story time from token claims. Only trusted host bindings authorize data.
      return { ...structuredClone(binding.principal), expiresAt: Math.min(binding.principal.expiresAt, claims.exp * 1000) };
    } catch { return null; }
  };
}

/** Fixed administrator-selected HTTPS JWKS endpoint. No token-controlled URL, redirect or unbounded response. */
export function createCrpJwksLoader(fetcher: typeof fetch = fetch) {
  let cached: { uri: string; at: number; keys: JsonWebKey[] } | undefined;
  let pending: { uri: string; promise: Promise<JsonWebKey[]> } | undefined;
  return async (config: CrpOAuthConfig, signal: AbortSignal) => {
    if (cached?.uri === config.jwksUri && Date.now() - cached.at < 60000) return structuredClone(cached.keys);
    if (!pending || pending.uri !== config.jwksUri) {
      const uri = config.jwksUri;
      const promise = (async () => {
        const response = await fetcher(uri, { redirect: "error", signal: AbortSignal.timeout(3000) });
        if (!response.ok || !response.body) throw Error("CRP_OAUTH_KEYS");
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 64 * 1024) throw Error("CRP_OAUTH_KEYS_LIMIT"); chunks.push(part.value); } }
        finally { await reader.cancel(); }
        const value = JSON.parse(Buffer.concat(chunks).toString());
        if (!Array.isArray(value.keys) || !value.keys.length || value.keys.length > 64) throw Error("CRP_OAUTH_KEYS");
        cached = { uri, at: Date.now(), keys: value.keys }; return value.keys as JsonWebKey[];
      })();
      pending = { uri, promise }; void promise.finally(() => { if (pending?.promise === promise) pending = undefined; }).catch(() => {});
    }
    const keys = await pending.promise;
    if (signal.aborted) throw Error("CRP_OAUTH_CANCELLED"); return structuredClone(keys);
  };
}
