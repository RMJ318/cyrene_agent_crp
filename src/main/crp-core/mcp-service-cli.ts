import fs from "node:fs";
import { CrpSnapshot } from "../memory-bridge/snapshot";
import { readBounded } from "../memory-bridge/safety";
import { createActiveSnapshotExecutor } from "./active-snapshot";
import { createCrpMcpGateway } from "./mcp-gateway";
import { createCrpOAuthVerifier, createCrpJwksLoader, validateOAuthConfig } from "./oauth-verifier";

export async function startCrpMcpService(env: NodeJS.ProcessEnv = process.env) {
  if (!env.CRP_SNAPSHOT_DIR || !env.CRP_OAUTH_FILE || !env.CRP_CURSOR_KEY_FILE || !env.CRP_SOURCE_COMMIT || !env.CRP_SOURCE_REPOSITORY) throw Error("CRP_MCP_CONFIG_REQUIRED");
  const host = env.CRP_BIND_HOST ?? "127.0.0.1", port = Number(env.CRP_PORT ?? "8788");
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(host) || host === "0.0.0.0" && env.CRP_BEHIND_TLS_PROXY !== "1" || !Number.isSafeInteger(port) || port < 1024 || port > 65535
    || !/^[a-f0-9]{40}$/.test(env.CRP_SOURCE_COMMIT) || !/^[\w.-]+\/[\w.-]+$/.test(env.CRP_SOURCE_REPOSITORY)) throw Error("CRP_MCP_CONFIG");
  const load = () => {
    if (fs.lstatSync(env.CRP_OAUTH_FILE!).isSymbolicLink()) throw Error("CRP_MCP_CONFIG");
    return validateOAuthConfig(JSON.parse(readBounded(env.CRP_OAUTH_FILE!, 128 * 1024).toString("utf8")));
  };
  const initial = load(), keys = createCrpJwksLoader();
  const authenticate = createCrpOAuthVerifier(() => {
    const current = load();
    if (current.issuer !== initial.issuer || current.resource !== initial.resource || current.jwksUri !== initial.jwksUri) throw Error("CRP_MCP_RESTART_REQUIRED");
    return current;
  }, keys);
  const snapshot = new CrpSnapshot(env.CRP_SNAPSHOT_DIR); snapshot.validate();
  const cursorKey = Buffer.from(readBounded(env.CRP_CURSOR_KEY_FILE, 1024).toString().trim(), "base64");
  const server = createCrpMcpGateway({ resource: initial.resource, authorizationServers: [initial.issuer], cursorKey, authenticate, publicDiscovery: true,
    execute: createActiveSnapshotExecutor({ directory: env.CRP_SYNC_DATA_DIR, fallback: snapshot, cursorKey, repository: env.CRP_SOURCE_REPOSITORY, commit: env.CRP_SOURCE_COMMIT }),
    audit: event => console.log(JSON.stringify({ event: "CRP_MCP_RECEIPT", ...event, at: new Date().toISOString() })) });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); }); return server;
}
if (require.main === module) startCrpMcpService().then(server => {
  console.log("CRP MCP ready (OAuth required, read-only, models disabled).");
  const stop = () => { server.close(); server.closeIdleConnections(); const timer = setTimeout(() => server.closeAllConnections(), 10000); timer.unref(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}).catch(() => { console.error("CRP_MCP_START_FAILED"); process.exitCode = 1; });
