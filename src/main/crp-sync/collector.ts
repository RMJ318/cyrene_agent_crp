import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { safePath } from "../memory-bridge/safety";
import { credentialMaterial, digest, memoryPath, SYNC_LIMITS, type SyncFile } from "./protocol";

/** Export only memory sources. No model settings, credentials, chats or vector/model caches. */
export function collectMemoryFiles(userData: string, workspaces: readonly string[] = []): SyncFile[] {
  const files: SyncFile[] = []; let total = 0;
  function add(relative: string, body: Buffer, domain: SyncFile["domain"] = "writer") {
    if (!memoryPath(relative) || body.length > SYNC_LIMITS.fileBytes || (total += body.length) > SYNC_LIMITS.memoryBytes || files.length >= SYNC_LIMITS.files) throw Error("SYNC_MEMORY_LIMIT");
    if (credentialMaterial(body)) throw Error("SYNC_CREDENTIAL_MATERIAL_BLOCKED");
    files.push({ path: relative, domain, sha256: digest(body), contentBase64: body.toString("base64") });
  }
  function read(root: string, relative: string): Buffer {
    const file = safePath(root, relative); const before = fs.statSync(file);
    if (!before.isFile() || before.size > SYNC_LIMITS.fileBytes) throw Error("SYNC_MEMORY_LIMIT");
    const body = fs.readFileSync(file); const after = fs.statSync(file);
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || before.ino !== after.ino) throw Error("SYNC_SOURCE_BUSY");
    if (relative.endsWith(".json")) JSON.parse(body.toString("utf8"));
    return body;
  }
  function walk(root: string, prefix: string, extensions: RegExp, relative = "") {
    if (!fs.existsSync(root)) return;
    if (fs.lstatSync(root).isSymbolicLink()) throw Error("SYNC_UNSAFE_SOURCE");
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const rel = relative ? `${relative}/${name}` : name; const full = safePath(root, rel); const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(root, prefix, extensions, rel);
      else if (extensions.test(name)) add(`${prefix}/${rel}`, read(root, rel));
    }
  }
  if (fs.existsSync(path.join(userData, "memory.json"))) add("native/memory.json", read(userData, "memory.json"));
  walk(path.join(userData, "memory/wiki"), "native/wiki", /\.(md|json)$/i);
  walk(path.join(userData, "summary-memory"), "native/summary", /\.md$/i);
  for (const workspace of [...new Set(workspaces.map(p => path.resolve(p)))]) {
    if (!path.isAbsolute(workspace) || !fs.existsSync(workspace)) continue;
    const memoryRoot = path.join(workspace, ".cyrene/memory");
    if (fs.existsSync(memoryRoot)) { safePath(workspace, ".cyrene/memory"); walk(memoryRoot, `native/workspaces/${digest(workspace)}`, /\.md$/i); }
  }
  const bridgeRoot = path.join(userData, "crp-memory-bridge"), configFile = path.join(bridgeRoot, "config.json");
  if (fs.existsSync(configFile)) {
    const config = JSON.parse(read(bridgeRoot, "config.json").toString("utf8"));
    for (const domain of ["writer", "reality0"] as const) {
      const name = config.stores?.[domain] ?? `${domain}.sqlite`;
      if (!/^[\w-]+\.sqlite$/.test(name)) throw Error("SYNC_STORE_PATH");
      if (!fs.existsSync(path.join(bridgeRoot, "stores", name))) continue;
      const db = new DatabaseSync(safePath(bridgeRoot, `stores/${name}`), { readOnly: true });
      try {
        db.exec("BEGIN");
        const payload = { version: 1, domain, modelRelease: "not-granted-by-sync", records: db.prepare("SELECT id,revision,deleted,created_at FROM records ORDER BY id").all(),
          versions: db.prepare("SELECT record_id,revision,sensitive,payload FROM record_versions ORDER BY record_id,revision").all() };
        if (db.prepare("SELECT domain FROM metadata").get()?.domain !== domain) throw Error("SYNC_STORE_DOMAIN");
        add(`bridge/${domain}.json`, Buffer.from(JSON.stringify(payload, null, 2) + "\n"), domain); db.exec("ROLLBACK");
      } finally { db.close(); }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
