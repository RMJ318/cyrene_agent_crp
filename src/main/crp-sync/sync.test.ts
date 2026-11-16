import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryInbox, CrpSyncServer } from "./server";
import { CrpSyncClient } from "./client";
import { collectMemoryFiles } from "./collector";
import { contentDigest, digest, validateBundle, type SyncFile } from "./protocol";
import { importSnapshot } from "../memory-bridge/snapshot";
import { BridgePolicy } from "../memory-bridge/policy";
import { MemoryBridgeService } from "../memory-bridge/service";
import { LocalMemoryStore } from "../memory-bridge/local-store";

const roots: string[] = [], closers: Array<() => unknown> = [];
const temp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), "crp-sync-test-")); roots.push(p); return p; };
function json(root: string, rel: string, value: unknown) { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
function file(content = '{"memory":"fictional test"}'): SyncFile { const bytes = Buffer.from(content); return { path: "native/memory.json", sha256: digest(bytes), domain: "writer", contentBase64: bytes.toString("base64") }; }
const bundle = (deviceId: string, files = [file()], revision = 1, previousDigest: string | null = null) => validateBundle({ version: 1, deviceId, files, revision, previousDigest, digest: contentDigest(files), createdAt: new Date().toISOString() });
function fixture(root: string) {
  const lib = "archive/rp/library/", text = "A fictional source paragraph.\n";
  const raw = path.join(root, "archive/rp/raw/test.md"); fs.mkdirSync(path.dirname(raw), { recursive: true }); fs.writeFileSync(raw, text);
  json(root, lib + "registry.json", { schema_version: "2.1", namespace_refs: { rp: lib + "rp/registry.json" } });
  json(root, lib + "rp/registry.json", { events: { test: { id: "test", title: "Fictional event", description: "A source-backed fixture", reality_id: "42", event_time: { day: 1 }, participants: [], evidence_ids: ["e1"] } } });
  json(root, lib + "evidence/registry.json", { e1: { evidence_id: "e1", source_id: "src-" + digest(text), source_path: "archive/rp/raw/test.md", source_version: digest(text), excerpt_sha256: digest(text), line_start: 1, line_end: 1, reality_id: "42", event_time: { day: 1 } } });
  json(root, lib + "audit/knowledge-results.json", { entries: {} });
}
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) { if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error("unsafe test cleanup"); fs.rmSync(root, { recursive: true, force: true }); }
});

describe("durable device inbox and privacy", () => {
  it("survives restart, makes lost-ack retries idempotent and rejects cross-device or stale revisions", () => {
    const root = temp(), id = randomUUID(), first = bundle(id); let inbox = new MemoryInbox(path.join(root, "data.sqlite"));
    expect(inbox.accept(first, id)).toMatchObject({ duplicate: false, revision: 1 }); inbox.close();
    inbox = new MemoryInbox(path.join(root, "data.sqlite")); closers.push(() => inbox.close());
    expect(inbox.accept(first, id)).toMatchObject({ duplicate: true });
    expect(() => inbox.accept(first, randomUUID())).toThrow("DEVICE_SCOPE");
    expect(() => inbox.accept(bundle(id, [file('{"memory":"changed"}')], 2, "0".repeat(64)), id)).toThrow("REVISION_CONFLICT");
    expect(inbox.current(id)?.digest).toBe(first.digest);
    const next = bundle(id, [], 2, first.digest); inbox.accept(next, id); expect(inbox.current(id)?.files).toEqual([]);
  });
  it("rejects credentials, path escapes, wrong namespaces and corrupt bytes before storage", () => {
    const id = randomUUID(), raw = bundle(id);
    expect(() => bundle(id, [file(JSON.stringify({ value: "sk-or-v1-" + "q".repeat(50) }))])).toThrow("CREDENTIAL");
    expect(() => validateBundle({ ...raw, files: [{ ...raw.files[0], path: "../../model-settings.json" }] })).toThrow();
    expect(() => validateBundle({ ...raw, files: [{ ...raw.files[0], domain: "reality0" }] })).toThrow();
    expect(() => validateBundle({ ...raw, files: [{ ...raw.files[0], sha256: "0".repeat(64) }] })).toThrow("HASH");
  });
  it("collects memory sources but excludes credentials, caches and transient model consents", () => {
    const root = temp(); json(root, "memory.json", { l2: [{ text: "fictional remembered fact" }] });
    json(root, "model-settings.json", { apiKey: "not exported" }); json(root, "rag/memory-store.json", { embedding: [1, 2, 3] });
    json(root, "crp-memory-bridge/config.json", { version: 1, stores: {} });
    const codec = { available: () => true, encrypt: (s: string) => Buffer.from(s).toString("base64"), decrypt: (s: string) => Buffer.from(s, "base64").toString() };
    const store = new LocalMemoryStore(path.join(root, "crp-memory-bridge/stores/writer.sqlite"), "writer", codec); closers.push(() => store.close());
    const record = store.create({ content: "a protected fixture", sensitive: true, participants: [] }); store.grant(record.id, record.revision, "test-session", "test-destination");
    const files = collectMemoryFiles(root); expect(files.map(f => f.path)).toEqual(["bridge/writer.json", "native/memory.json"]);
    const logical = JSON.parse(Buffer.from(files[0].contentBase64, "base64").toString()); expect(logical.versions[0].sensitive).toBe(1);
    expect(JSON.stringify(logical)).not.toContain("a protected fixture"); expect(JSON.stringify(logical)).not.toContain("test-destination"); expect(logical.consents).toBeUndefined();
    const outside = temp(); fs.mkdirSync(path.join(root, "memory/wiki"), { recursive: true }); fs.symlinkSync(outside, path.join(root, "memory/wiki/linked"), "junction");
    expect(() => collectMemoryFiles(root)).toThrow("UNSAFE");
  });
});

async function harness() {
  const root = temp(), profile = temp(), deviceId = randomUUID(), token = "t".repeat(48), commit = "a".repeat(40);
  const checkout = path.join(root, "checkouts", commit); fixture(checkout);
  const snapshot = await importSnapshot(checkout, path.join(root, "snapshots"), []);
  const config = { root, repository: "example/archive", channels: { main: "main" }, pollMs: 60000, devices: [{ deviceId, tokenSha256: digest(token), channels: ["main"] }] };
  const server = new CrpSyncServer(config); closers.push(() => server.close());
  let published = { repository: config.repository, channel: "main", commit, snapshot, checkout, publishedAt: new Date().toISOString() };
  vi.spyOn(server.source, "refresh").mockImplementation(async () => published);
  await server.listen(0); await server.requestRefresh();
  const address = server.server.address() as { port: number }, endpoint = `http://127.0.0.1:${address.port}/`, tokenFile = path.join(profile, "sync.token"); fs.writeFileSync(tokenFile, token);
  const bridge = new MemoryBridgeService(path.join(profile, "crp-memory-bridge"), { available: () => false, encrypt: () => { throw Error(); }, decrypt: () => { throw Error(); } }, new BridgePolicy()); closers.push(() => bridge.close());
  const adopt = vi.fn((source: string, provenance: { repository: string; commit: string }, signal: AbortSignal) => bridge.import(source, signal, false, provenance));
  let files = [file()], calls = 0;
  const clientConfig = { version: 1 as const, enabled: true, endpoint, repository: config.repository, deviceId, tokenFile, publishMs: 1000 };
  const options = { allowHttpLoopback: true, adopt, collect: () => files, publish: async (b: any) => { calls++; return { url: "https://github.com/example/archive/pull/1", commit: "f".repeat(40), revision: b.revision }; } };
  const client = new CrpSyncClient(profile, clientConfig, options); closers.push(() => client.close());
  return { root, profile, config, server, endpoint, token, deviceId, bridge, adopt, client, clientConfig, options,
    publishCalls: () => calls, files: (next: SyncFile[]) => { files = next; }, next: async () => {
      const newCommit = "b".repeat(40), nextRoot = path.join(root, "checkouts", newCommit); fs.cpSync(checkout, nextRoot, { recursive: true });
      json(nextRoot, "canon/fixture.json", { new: "source update" }); const nextSnapshot = await importSnapshot(nextRoot, path.join(root, "snapshots"), []);
      published = { ...published, commit: newCommit, snapshot: nextSnapshot, checkout: nextRoot }; await server.requestRefresh(); return newCommit;
    } };
}
describe("actual HTTP delivery and native bridge adoption", () => {
  it("follows source changes, restores client state and resumes upload/publication after a lost acknowledgement", async () => {
    const h = await harness(); await h.client.tick(); expect(h.bridge.status().githubSource?.commit).toBe("a".repeat(40));
    expect(h.client.status()).toMatchObject({ uploadedRevision: 1, publishedRevision: 1 }); expect(h.publishCalls()).toBe(1);
    await h.client.close(); const restored = new CrpSyncClient(h.profile, h.clientConfig, h.options); closers.push(() => restored.close());
    await restored.tick(); expect(h.adopt).toHaveBeenCalledTimes(1); expect(h.server.inbox.current(h.deviceId)?.revision).toBe(1);
    const newCommit = await h.next(); await restored.tick(); expect(h.bridge.status().githubSource?.commit).toBe(newCommit); expect(h.adopt).toHaveBeenCalledTimes(2);
    h.files([file('{"memory":"a changed native fact"}')]); await restored.tick(); expect(h.server.inbox.current(h.deviceId)?.revision).toBe(2);
    expect(restored.status().publishedRevision).toBe(1); // publication interval does not block immediate server upload
  });
  it("rejects unauthenticated, wrong-channel and cross-device writes", async () => {
    const h = await harness(); expect((await fetch(h.endpoint + "sync/v1/state")).status).toBe(401);
    expect((await fetch(h.endpoint + "sync/v1/state?channel=other", { headers: { Authorization: `Bearer ${h.token}` } })).status).toBe(403);
    const reply = await fetch(h.endpoint + "sync/v1/memories", { method: "PUT", headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" }, body: JSON.stringify(bundle(randomUUID())) });
    expect(reply.status).toBe(422); expect(h.server.inbox.current(h.deviceId)).toBeNull();
  });
  it("a tampered transfer preserves the active snapshot while outgoing memory still succeeds", async () => {
    const h = await harness(); await h.client.tick(); const originalId = h.bridge.status().snapshotId; await h.next();
    const corruptFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (!String(input).includes("/snapshot?")) return res;
      const b = await res.json() as any; b.files[0].contentBase64 = Buffer.from("changed").toString("base64"); return new Response(JSON.stringify(b));
    };
    const client = new CrpSyncClient(h.profile, h.clientConfig, { ...h.options, fetch: corruptFetch }); closers.push(() => client.close());
    await client.tick(); expect(client.status().lastError).toBe("SYNC_REMOTE_FILE_HASH"); expect(h.bridge.status().snapshotId).toBe(originalId);
    expect(h.server.inbox.current(h.deviceId)?.revision).toBe(1);
  });
  it("server restart restores the same committed snapshot and upload history", async () => {
    const h = await harness(); await h.client.tick(); const state = h.server.state(); await h.server.close();
    const restored = new CrpSyncServer(h.config); closers.push(() => restored.close());
    expect(restored.state()?.snapshotId).toBe(state?.snapshotId); expect(restored.inbox.current(h.deviceId)?.revision).toBe(1);
  });
  it("shutdown cancels an in-flight transfer and leaves the last complete snapshot intact", async () => {
    const h = await harness(); await h.client.tick(); const snapshotId = h.bridge.status().snapshotId;
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const pendingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => { entered(); init?.signal?.addEventListener("abort", () => reject(Error("cancelled")), { once: true }); });
    const client = new CrpSyncClient(h.profile, h.clientConfig, { ...h.options, fetch: pendingFetch });
    const pending = client.tick(); await started; await client.close(); await pending;
    expect(h.bridge.status().snapshotId).toBe(snapshotId); expect(h.server.inbox.current(h.deviceId)?.revision).toBe(1);
    expect(() => new CrpSyncClient(h.profile, h.clientConfig, { ...h.options, allowHttpLoopback: false })).toThrow("HTTPS_REQUIRED");
  });
});
