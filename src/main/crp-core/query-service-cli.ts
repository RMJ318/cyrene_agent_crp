import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { CrpSnapshot } from "../memory-bridge/snapshot";
import { readBounded } from "../memory-bridge/safety";
import { createCrpQueryGateway, type GatewayCredential } from "./query-gateway";
import { createSnapshotQueryExecutor } from "./snapshot-query-adapter";

/** Standalone read-only server. No Electron profile discovery, model routing or write endpoint. */
export async function startCrpQueryService(env: NodeJS.ProcessEnv = process.env) {
  if (!env.CRP_SNAPSHOT_DIR || !env.CRP_AUTH_FILE) throw Error("CRP_SERVICE_CONFIG_REQUIRED");
  const host = env.CRP_BIND_HOST ?? "127.0.0.1", port = Number(env.CRP_PORT ?? "8787");
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(host) || host === "0.0.0.0" && env.CRP_BEHIND_TLS_PROXY !== "1"
    || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error("CRP_SERVICE_BIND_DENIED");
  const snapshot = new CrpSnapshot(env.CRP_SNAPSHOT_DIR); snapshot.validate();
  const provenance = env.CRP_SOURCE_COMMIT || env.CRP_SOURCE_REPOSITORY ? { repository: env.CRP_SOURCE_REPOSITORY ?? "", commit: env.CRP_SOURCE_COMMIT ?? "" } : undefined;
  if (provenance && (!/^[\w.-]+\/[\w.-]+$/.test(provenance.repository) || !/^[a-f0-9]{40}$/.test(provenance.commit))) throw Error("CRP_SERVICE_PROVENANCE");
  const load = (): GatewayCredential[] => {
    if (fs.lstatSync(env.CRP_AUTH_FILE!).isSymbolicLink()) throw Error("CRP_SERVICE_AUTH_FILE");
    const data = JSON.parse(readBounded(env.CRP_AUTH_FILE!, 128 * 1024).toString("utf8"));
    if (!Array.isArray(data) || !data.length || data.length > 128 || data.some(c => !c || typeof c !== "object" || !/^[a-f0-9]{64}$/.test(c.tokenSha256) || !c.principal
      || !Number.isFinite(c.principal.expiresAt) || !Array.isArray(c.principal.scopes))) throw Error("CRP_SERVICE_AUTH_FILE");
    return data;
  };
  load();
  const cursorKey = env.CRP_CURSOR_KEY_FILE ? Buffer.from(readBounded(env.CRP_CURSOR_KEY_FILE, 1024).toString().trim(), "base64") : randomBytes(32);
  const server = createCrpQueryGateway(load, createSnapshotQueryExecutor(snapshot, cursorKey, provenance), event => {
    // No query text, response body, source excerpt, token, IP address or model credential is logged.
    console.log(JSON.stringify({ event: "CRP_QUERY_RECEIPT", ...event }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  return server;
}

if (require.main === module) {
  startCrpQueryService().then(server => {
    console.log("CRP query service ready (authenticated, read-only, models disabled).");
    const stop = () => { server.close(); server.closeIdleConnections(); const timeout = setTimeout(() => { server.closeAllConnections(); }, 10000); timeout.unref(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  }).catch(() => { console.error("CRP_SERVICE_START_FAILED"); process.exitCode = 1; });
}
