import fs from "node:fs";
import { CrpSyncServer, type SyncServerConfig } from "./server";

async function main() {
  const file = process.env.CRP_SYNC_CONFIG; if (!file || fs.lstatSync(file).isSymbolicLink()) throw Error("SYNC_CONFIG_REQUIRED");
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as SyncServerConfig;
  const host = process.env.CRP_SYNC_BIND ?? "127.0.0.1", port = Number(process.env.CRP_SYNC_PORT ?? "8790");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || !["127.0.0.1", "0.0.0.0"].includes(host) || host === "0.0.0.0" && process.env.CRP_BEHIND_TLS_PROXY !== "1") throw Error("SYNC_BIND_DENIED");
  const service = new CrpSyncServer(config); await service.listen(port, host);
  console.log(JSON.stringify({ event: "CRP_SYNC_READY", modelCalls: 0 }));
  const stop = () => { void service.close().then(() => { process.exitCode = 0; }); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
main().catch(() => { console.error("CRP_SYNC_START_FAILED"); process.exitCode = 1; });
