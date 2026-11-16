import fs from "node:fs";
import path from "node:path";
import { atomicJson, within } from "../memory-bridge/safety";
import { CrpSnapshot } from "../memory-bridge/snapshot";
import { collectMemoryFiles } from "./collector";
import { MemoryPrPublisher } from "./github-pr";
import { contentDigest, digest, relativePath, SYNC_LIMITS, validCommit, validDevice, validateBundle, type MemoryBundle, type SyncClientConfig, type SyncFile } from "./protocol";

interface ClientState { version: 1; commit?: string; snapshotId?: string; uploadedRevision?: number; uploadedDigest?: string; publishedRevision?: number; prUrl?: string; lastPublishedAt?: number; lastIncomingAt?: string; lastOutgoingAt?: string; lastError?: string }
interface ClientOptions {
  collect?: () => Promise<SyncFile[]> | SyncFile[];
  adopt(source: string, provenance: { repository: string; commit: string }, signal: AbortSignal): Promise<string>;
  publish?: (bundle: MemoryBundle, signal: AbortSignal) => Promise<{ url: string; commit: string; revision: number }>;
  fetch?: typeof fetch; allowHttpLoopback?: boolean;
}
export class CrpSyncClient {
  readonly root: string;
  private state: ClientState = { version: 1 };
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private endpoint: URL;
  private fetcher: typeof fetch;
  private publisher: MemoryPrPublisher;
  constructor(readonly userData: string, readonly config: SyncClientConfig, readonly options: ClientOptions) {
    if (config.version !== 1 || !validDevice(config.deviceId) || !/^[\w.-]+\/[\w.-]+$/.test(config.repository) || !path.isAbsolute(config.tokenFile)
      || !/^[\w-]{1,40}$/.test(config.channel ?? "main")) throw Error("SYNC_CONFIG");
    this.endpoint = new URL(config.endpoint);
    if (this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash || this.endpoint.pathname !== "/"
      || this.endpoint.protocol !== "https:" && !(options.allowHttpLoopback && this.endpoint.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(this.endpoint.hostname))) throw Error("SYNC_HTTPS_REQUIRED");
    this.root = path.join(userData, "crp-sync"); fs.mkdirSync(this.root, { recursive: true });
    if (fs.lstatSync(this.root).isSymbolicLink()) throw Error("SYNC_ROOT");
    this.fetcher = options.fetch ?? fetch; this.publisher = new MemoryPrPublisher(path.join(this.root, "publisher"), config.repository);
    const file = path.join(this.root, "state.json");
    if (fs.existsSync(file)) { this.state = JSON.parse(fs.readFileSync(file, "utf8")); if (this.state.version !== 1) throw Error("SYNC_STATE_VERSION"); }
  }
  status(): Readonly<ClientState> { return { ...this.state }; }
  private save(patch: Partial<ClientState>) { if (this.controller.signal.aborted) return; this.state = { ...this.state, ...patch }; atomicJson(path.join(this.root, "state.json"), this.state); }
  private token(): string {
    if (fs.lstatSync(this.config.tokenFile).isSymbolicLink() || fs.statSync(this.config.tokenFile).size > 256) throw Error("SYNC_TOKEN_FILE");
    const token = fs.readFileSync(this.config.tokenFile, "utf8").trim(); if (!/^[\w-]{32,200}$/.test(token)) throw Error("SYNC_TOKEN_FILE"); return token;
  }
  private async request(relative: string, init: RequestInit = {}, max = 2 * 1024 * 1024): Promise<any> {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(90000)]);
    const res = await this.fetcher(new URL(relative, this.endpoint), { ...init, redirect: "error", signal, headers: { ...init.headers, Authorization: `Bearer ${this.token()}` } });
    if (!res.ok) throw Error(res.status === 401 || res.status === 403 ? "SYNC_AUTH_REQUIRED" : res.status === 409 ? "SYNC_SOURCE_OR_REVISION_ADVANCED" : "SYNC_SERVER_REQUEST_FAILED");
    const pieces: Buffer[] = []; let total = 0;
    if (!res.body) throw Error("SYNC_EMPTY_RESPONSE");
    for await (const chunk of res.body as any) { if ((total += chunk.length) > max) throw Error("SYNC_RESPONSE_LIMIT"); pieces.push(Buffer.from(chunk)); }
    return JSON.parse(Buffer.concat(pieces).toString("utf8"));
  }
  private async incoming() {
    const channel = this.config.channel ?? "main", remote = await this.request(`/sync/v1/state?channel=${encodeURIComponent(channel)}`);
    if (!validCommit(remote.commit) || remote.repository !== this.config.repository || remote.channel !== channel || !validDevice(remote.snapshotId) || !/^[a-f0-9]{64}$/.test(remote.manifestSha256)) throw Error("SYNC_REMOTE_STATE");
    if (remote.commit === this.state.commit) return;
    const bundle = await this.request(`/sync/v1/snapshot?channel=${encodeURIComponent(channel)}&commit=${remote.commit}`, {}, 96 * 1024 * 1024);
    if (bundle.commit !== remote.commit || bundle.repository !== remote.repository || bundle.channel !== channel || !bundle.manifest || bundle.manifest.version !== 1
      || bundle.manifest.snapshotId !== remote.snapshotId || digest(JSON.stringify(bundle.manifest, null, 2)) !== remote.manifestSha256 || !Array.isArray(bundle.files)
      || bundle.files.length > 10000 || bundle.files.length !== Object.keys(bundle.manifest.files).length) throw Error("SYNC_REMOTE_MANIFEST");
    const parent = path.join(this.root, "incoming"); fs.mkdirSync(parent, { recursive: true }); if (fs.lstatSync(parent).isSymbolicLink()) throw Error("SYNC_ROOT");
    const stage = fs.mkdtempSync(path.join(parent, "snapshot-")); let total = 0; const seen = new Set<string>();
    try {
      for (const f of bundle.files) {
        if (this.controller.signal.aborted) throw Error("SYNC_CANCELLED");
        if (!relativePath(f.path) || !/^(?:archive\/rp\/(?:library|raw|inbox|continuity)\/|manuscripts\/|canon\/).+\.(?:md|json)$/i.test(f.path)
          || seen.has(f.path) || typeof f.contentBase64 !== "string" || f.contentBase64.length > 44 * 1024 * 1024) throw Error("SYNC_REMOTE_PATH");
        const bytes = Buffer.from(f.contentBase64, "base64"); total += bytes.length;
        if (total > 64 * 1024 * 1024 || digest(bytes) !== f.sha256 || f.sha256 !== bundle.manifest.files[f.path]) throw Error("SYNC_REMOTE_FILE_HASH");
        const file = path.join(stage, f.path); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 }); seen.add(f.path);
      }
      atomicJson(path.join(stage, "snapshot.json"), bundle.manifest); const snapshot = new CrpSnapshot(stage); snapshot.validate();
      if (this.controller.signal.aborted) throw Error("SYNC_CANCELLED");
      const snapshotId = await this.options.adopt(stage, { repository: this.config.repository, commit: remote.commit }, this.controller.signal);
      this.save({ commit: remote.commit, snapshotId, lastIncomingAt: new Date().toISOString() });
    } finally {
      // Only this invocation's generated staging directory can be removed.
      if (!within(parent, stage) || path.dirname(path.resolve(stage)) !== path.resolve(parent) || !path.basename(stage).startsWith("snapshot-")) throw Error("SYNC_STAGE_PATH");
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  private async outgoing() {
    const files = await (this.options.collect?.() ?? collectMemoryFiles(this.userData)), localDigest = contentDigest(files);
    const current = await this.request("/sync/v1/memories", {}, SYNC_LIMITS.bodyBytes); let bundle: MemoryBundle | null = current.bundle;
    if (bundle) { bundle = validateBundle(bundle); if (bundle.deviceId !== this.config.deviceId) throw Error("SYNC_DEVICE_SCOPE"); }
    if (!bundle || bundle.digest !== localDigest) {
      bundle = validateBundle({ version: 1, deviceId: this.config.deviceId, revision: (bundle?.revision ?? 0) + 1, previousDigest: bundle?.digest ?? null,
        digest: localDigest, createdAt: new Date().toISOString(), files });
      const receipt = await this.request("/sync/v1/memories", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bundle) });
      if (!receipt.accepted || receipt.digest !== bundle.digest || receipt.revision !== bundle.revision) throw Error("SYNC_UPLOAD_RECEIPT");
    }
    this.save({ uploadedRevision: bundle.revision, uploadedDigest: bundle.digest, lastOutgoingAt: new Date().toISOString() });
    if ((this.state.publishedRevision ?? 0) < bundle.revision && (!this.state.lastPublishedAt || Date.now() - this.state.lastPublishedAt >= Math.max(1000, this.config.publishMs ?? 300000))) {
      const publication = this.options.publish ? await this.options.publish(bundle, this.controller.signal) : await this.publisher.publish(bundle, this.controller.signal);
      if (publication.revision !== bundle.revision) throw Error("SYNC_PUBLICATION_RECEIPT");
      this.save({ publishedRevision: bundle.revision, prUrl: publication.url, lastPublishedAt: Date.now() });
    }
  }
  tick(): Promise<void> {
    if (this.running) return this.running; if (this.controller.signal.aborted) return Promise.resolve();
    this.running = (async () => {
      let error: string | undefined;
      for (const operation of [() => this.incoming(), () => this.outgoing()]) {
        if (this.controller.signal.aborted) break;
        try { await operation(); } catch (e) { error = e instanceof Error && /^SYNC_[A-Z_]+$/.test(e.message) ? e.message : "SYNC_OPERATION_FAILED"; }
      }
      this.save({ lastError: error });
    })().finally(() => { this.running = undefined; }); return this.running;
  }
  start() {
    if (!this.config.enabled) return;
    const run = () => { void this.tick().finally(() => { if (!this.controller.signal.aborted) { this.timer = setTimeout(run, Math.max(1000, this.config.pollMs ?? 5000)); this.timer.unref(); } }); }; run();
  }
  close() { this.controller.abort(); if (this.timer) clearTimeout(this.timer); return this.running ?? Promise.resolve(); }
}

export function loadSyncClientConfig(userData: string): SyncClientConfig | null {
  const file = path.join(userData, "crp-sync.json"); if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 8192) throw Error("SYNC_CONFIG");
  const config = JSON.parse(fs.readFileSync(file, "utf8")); return config.enabled === true ? config : null;
}
