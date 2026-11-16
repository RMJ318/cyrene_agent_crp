import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createGzip } from "node:zlib";
import { once } from "node:events";
import { atomicJson, safePath } from "../memory-bridge/safety";
import { CrpSnapshot } from "../memory-bridge/snapshot";
import { createCrpQueryGateway, type GatewayCredential } from "../crp-core/query-gateway";
import { createSnapshotQueryExecutor } from "../crp-core/snapshot-query-adapter";
import { GitSnapshotSource, gitRunner, snapshotState, type PublishedSnapshot, type SyncGit } from "./git-source";
import { digest, SYNC_LIMITS, tokenMatches, validCommit, validDevice, validateBundle, type MemoryBundle } from "./protocol";

export interface SyncServerConfig {
  root: string; repository: string; channels: Record<string, string>; pollMs?: number;
  sshKey?: string; knownHosts?: string; webhookSecretFile?: string; queryAuthFile?: string; cursorKeyFile?: string;
  devices: Array<{ deviceId: string; tokenSha256: string; channels: string[] }>;
}
export class MemoryInbox {
  private db: DatabaseSync;
  private closed = false;
  constructor(file: string) {
    this.db = new DatabaseSync(file); this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS revisions(device TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,accepted_at TEXT NOT NULL,PRIMARY KEY(device,revision));");
  }
  current(device: string): MemoryBundle | null {
    const row = this.db.prepare("SELECT payload FROM revisions WHERE device=? ORDER BY revision DESC LIMIT 1").get(device);
    return row ? JSON.parse(String(row.payload)) : null;
  }
  accept(raw: unknown, device: string) {
    const b = validateBundle(raw); if (b.deviceId !== device) throw Error("SYNC_DEVICE_SCOPE");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.current(device);
      if (prior?.revision === b.revision && prior.digest === b.digest) { this.db.exec("COMMIT"); return { revision: b.revision, digest: b.digest, duplicate: true }; }
      if (b.revision !== (prior?.revision ?? 0) + 1 || b.previousDigest !== (prior?.digest ?? null)) throw Error("SYNC_REVISION_CONFLICT");
      this.db.prepare("INSERT INTO revisions VALUES(?,?,?,?,?)").run(device, b.revision, b.digest, JSON.stringify(b), new Date().toISOString());
      this.db.exec("COMMIT"); return { revision: b.revision, digest: b.digest, duplicate: false };
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
const response = (res: http.ServerResponse, status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(value)); };
async function body(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const pieces: Buffer[] = []; let total = 0;
  for await (const chunk of req) { const p = Buffer.from(chunk); if ((total += p.length) > max) throw Error("SYNC_BODY_LIMIT"); pieces.push(p); }
  return Buffer.concat(pieces);
}
export class CrpSyncServer {
  readonly server: http.Server;
  readonly source: GitSnapshotSource;
  readonly inbox: MemoryInbox;
  private active = new Map<string, PublishedSnapshot>();
  private errors = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private controller = new AbortController();
  private refreshing?: Promise<void>;
  private pendingChannels = new Set<string>();
  private buckets = new Map<string, { minute: number; count: number }>();
  private executor?: ReturnType<typeof createSnapshotQueryExecutor>;
  private cursorKey: Buffer;
  private queryGateway: http.Server;
  constructor(readonly config: SyncServerConfig, git?: SyncGit) {
    if (!path.isAbsolute(config.root) || !config.devices.length || config.devices.length > 64 || !Object.keys(config.channels).length
      || config.devices.some(d => !validDevice(d.deviceId) || !/^[a-f0-9]{64}$/.test(d.tokenSha256) || !Array.isArray(d.channels) || d.channels.some(c => !Object.hasOwn(config.channels, c)))) throw Error("SYNC_CONFIG");
    fs.mkdirSync(config.root, { recursive: true }); if (fs.lstatSync(config.root).isSymbolicLink()) throw Error("SYNC_ROOT");
    this.source = new GitSnapshotSource(config.root, config.repository, git ?? gitRunner(config.sshKey, config.knownHosts));
    this.inbox = new MemoryInbox(path.join(config.root, "inbox.sqlite"));
    this.cursorKey = config.cursorKeyFile ? Buffer.from(fs.readFileSync(config.cursorKeyFile, "utf8").trim(), "base64") : randomBytes(32);
    const credentials = (): GatewayCredential[] => config.queryAuthFile ? JSON.parse(fs.readFileSync(config.queryAuthFile, "utf8")) : [];
    this.queryGateway = createCrpQueryGateway(credentials, async (principal, request, signal) => {
      if (!this.executor) throw Error("CRP_SERVICE_UNAVAILABLE"); return this.executor(principal, request, signal);
    }, event => console.log(JSON.stringify({ event: "CRP_QUERY_RECEIPT", ...event })));
    this.server = http.createServer((req, res) => { void this.handle(req, res).catch(e => {
      const code = e instanceof Error && /^SYNC_[A-Z_]+$/.test(e.message) ? e.message : "SYNC_OPERATION_FAILED";
      if (!res.headersSent) response(res, code === "SYNC_REVISION_CONFLICT" ? 409 : code === "SYNC_BODY_LIMIT" ? 413 : 422, { error: code }); else res.destroy();
    }); });
    this.server.requestTimeout = 60000; this.server.headersTimeout = 15000;
    for (const channel of Object.keys(config.channels)) {
      const file = path.join(config.root, `active-${channel}.json`);
      if (!fs.existsSync(file)) continue;
      const p = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!validCommit(p.commit) || !validDevice(p.snapshotId)) throw Error("SYNC_RECOVERY_POINTER");
      const snapshot = new CrpSnapshot(safePath(path.join(config.root, "snapshots"), p.snapshotId)); snapshot.validate();
      this.publish({ repository: config.repository, channel, commit: p.commit, snapshot, checkout: safePath(path.join(config.root, "checkouts"), p.commit), publishedAt: p.publishedAt });
    }
  }
  private publish(p: PublishedSnapshot) {
    const pointer = { commit: p.commit, snapshotId: p.snapshot.manifest.snapshotId, publishedAt: p.publishedAt };
    atomicJson(path.join(this.config.root, `active-${p.channel}.json`), pointer);
    // The legacy MCP container receives only this pointer directory and the
    // read-only snapshots, never the personal-memory inbox or Git credentials.
    if (p.channel === "main") atomicJson(path.join(this.config.root, "published/active-main.json"), pointer);
    if (p.channel === "main") this.executor = createSnapshotQueryExecutor(p.snapshot, this.cursorKey, { repository: p.repository, commit: p.commit });
    this.active.set(p.channel, p);
  }
  requestRefresh(channels = Object.keys(this.config.channels)): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    for (const channel of channels) if (Object.hasOwn(this.config.channels, channel)) this.pendingChannels.add(channel);
    if (this.refreshing) return this.refreshing;
    if (this.timer) clearTimeout(this.timer);
    this.refreshing = (async () => {
      do {
        const pending = [...this.pendingChannels]; this.pendingChannels.clear();
        for (const channel of pending) {
          const ref = this.config.channels[channel];
          try {
            const previous = this.active.get(channel), next = await this.source.refresh(channel, ref, previous, this.controller.signal);
            if (previous !== next) this.publish(next); this.errors.delete(channel);
          } catch (e) { this.errors.set(channel, e instanceof Error && /^(?:SYNC|BRIDGE)_[A-Z_]+$/.test(e.message) ? e.message : "SYNC_FETCH_OR_VALIDATION_FAILED"); }
        }
      } while (this.pendingChannels.size && !this.controller.signal.aborted);
    })().finally(() => { this.refreshing = undefined; if (!this.controller.signal.aborted) { this.timer = setTimeout(() => { void this.requestRefresh(); }, Math.max(1000, this.config.pollMs ?? 15000)); this.timer.unref(); } });
    return this.refreshing;
  }
  state(channel = "main") { const p = this.active.get(channel); return p ? { ...snapshotState(p), lastError: this.errors.get(channel) ?? null } : null; }
  private async bundle(p: PublishedSnapshot): Promise<string> {
    const root = path.join(this.config.root, "bundles"); fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, `${p.snapshot.manifest.snapshotId}.json.gz`); if (fs.existsSync(file)) return file;
    const temp = `${file}.${randomUUID()}.tmp`, zip = createGzip(), output = fs.createWriteStream(temp, { flags: "wx", mode: 0o600 }); zip.pipe(output);
    const done = once(output, "close"); zip.on("error", e => output.destroy(e));
    const put = async (s: string) => { if (!zip.write(s)) await once(zip, "drain"); };
    let total = 0;
    try {
      await put(JSON.stringify({ repository: p.repository, commit: p.commit, channel: p.channel, manifest: p.snapshot.manifest }).slice(0, -1) + ',"files":[');
      let first = true;
      for (const [relative, expected] of Object.entries(p.snapshot.manifest.files)) {
        const b = fs.readFileSync(safePath(p.snapshot.root, relative)); total += b.length;
        if (digest(b) !== expected || total > 64 * 1024 * 1024) throw Error("SYNC_SNAPSHOT_HASH_OR_LIMIT");
        await put((first ? "" : ",") + JSON.stringify({ path: relative, sha256: expected, contentBase64: b.toString("base64") })); first = false;
      }
      await put("]}"); zip.end(); await done; fs.renameSync(temp, file); return file;
    } catch (e) { zip.destroy(); output.destroy(); await done.catch(() => undefined); if (fs.existsSync(temp)) fs.unlinkSync(temp); throw e; }
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://sync.invalid");
    if (url.pathname === "/healthz") return response(res, 200, { ready: this.active.has("main"), modelCalls: 0 });
    if (url.pathname.startsWith("/v1/")) { this.queryGateway.emit("request", req, res); return; }
    if (url.pathname === "/sync/v1/github-hook" && req.method === "POST") {
      const bytes = await body(req, 1024 * 1024), signature = String(req.headers["x-hub-signature-256"] ?? "");
      const secret = this.config.webhookSecretFile ? fs.readFileSync(this.config.webhookSecretFile, "utf8").trim() : "";
      const expected = "sha256=" + createHmac("sha256", secret).update(bytes).digest("hex");
      if (!secret || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return response(res, 401, { error: "SYNC_AUTH_REQUIRED" });
      const event = JSON.parse(bytes.toString("utf8"));
      if (req.headers["x-github-event"] === "push" && event.repository?.full_name === this.config.repository) {
        const channels = Object.entries(this.config.channels).filter(([, ref]) => event.ref === `refs/heads/${ref}`).map(([channel]) => channel);
        if (channels.length) void this.requestRefresh(channels);
      }
      return response(res, 202, { accepted: true });
    }
    const authHeaders = req.rawHeaders.filter((_, i) => i % 2 === 0).filter(x => x.toLowerCase() === "authorization");
    const token = authHeaders.length === 1 ? /^Bearer ([\w-]{32,200})$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "" : "";
    const device = token ? this.config.devices.find(d => tokenMatches(token, d.tokenSha256)) : undefined;
    if (!device) return response(res, 401, { error: "SYNC_AUTH_REQUIRED" });
    const minute = Math.floor(Date.now() / 60000), prior = this.buckets.get(device.deviceId), bucket = prior?.minute === minute ? prior : { minute, count: 0 };
    this.buckets.set(device.deviceId, bucket); if (++bucket.count > 120) return response(res, 429, { error: "SYNC_RATE_LIMIT" });
    const channel = url.searchParams.get("channel") ?? "main";
    if (url.pathname === "/sync/v1/state" || url.pathname === "/sync/v1/snapshot") {
      if (req.method !== "GET" || !device.channels.includes(channel)) return response(res, 403, { error: "SYNC_CHANNEL_DENIED" });
      const p = this.active.get(channel); if (!p) return response(res, 503, { error: "SYNC_NOT_READY" });
      if (url.pathname.endsWith("/state")) return response(res, 200, this.state(channel));
      if (url.searchParams.get("commit") !== p.commit) return response(res, 409, { error: "SYNC_SOURCE_ADVANCED" });
      const file = await this.bundle(p); res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Cache-Control": "no-store", ETag: '"' + p.commit + '"' }); fs.createReadStream(file).pipe(res); return;
    }
    if (url.pathname === "/sync/v1/memories") {
      if (req.method === "GET") return response(res, 200, { bundle: this.inbox.current(device.deviceId) });
      if (req.method === "PUT") return response(res, 200, { accepted: true, ...this.inbox.accept(JSON.parse((await body(req, SYNC_LIMITS.bodyBytes)).toString("utf8")), device.deviceId), storedAt: new Date().toISOString() });
    }
    response(res, 404, { error: "SYNC_NOT_FOUND" });
  }
  async listen(port = 8790, host = "127.0.0.1") { await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(port, host, resolve); }); void this.requestRefresh(); return this.server.address(); }
  async close() {
    this.controller.abort(); if (this.timer) clearTimeout(this.timer);
    this.server.closeAllConnections(); await new Promise<void>(resolve => { if (this.server.listening) this.server.close(() => resolve()); else resolve(); });
    await this.refreshing; this.inbox.close();
  }
}
