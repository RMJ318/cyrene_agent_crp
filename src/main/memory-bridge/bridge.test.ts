import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeScope } from "../../shared/memory-bridge";
import { BridgePolicy } from "./policy";
import { hash, pythonJson, visible } from "./safety";
import { CrpSnapshot, importSnapshot } from "./snapshot";
import { LocalMemoryStore, type PrivateCodec } from "./local-store";
import { MemoryBridgeService } from "./service";
import * as github from "./github";
import { previewLegacyMigration } from "../crp-core/migration-preview";
import { verifySnapshotRecall } from "../crp-core/recall-verification";
import { createSnapshotQueryExecutor } from "../crp-core/snapshot-query-adapter";

const roots: string[] = [];
const closers: Array<() => void> = [];
function temp() { const p = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-bridge-test-")); roots.push(p); return p; }
function json(root: string, rel: string, obj: unknown) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj)); }
const key = randomBytes(32);
const codec: PrivateCodec = { available: () => true,
  encrypt(text) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); const body = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64"); },
  decrypt(ciphertext) { const b = Buffer.from(ciphertext, "base64"), cipher = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)); cipher.setAuthTag(b.subarray(12, 28)); return Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString(); },
};
const scope: BridgeScope = { domain: "rp", realityId: "42", branchId: null, audience: "character-knowledge", characterId: "river", asOf: { day: 9, clock: "22:00" } };
/** Entirely fictional corpus. No private archive or user profile is read by tests. */
function fixture() {
  const root = temp();
  const raw = "Fictional 😀 couple confirmed on day nine.\n";
  fs.mkdirSync(path.join(root, "archive/rp/raw"), { recursive: true });
  fs.writeFileSync(path.join(root, "archive/rp/raw/test.md"), raw);
  const evidence: any = { e1: { evidence_id: "e1", source_id: `src-${hash(raw)}`, source_path: "archive/rp/raw/test.md", source_version: hash(raw), excerpt_sha256: hash(raw), line_start: 1, line_end: 1, char_start: null, char_end: null, reality_id: "42", event_time: { day: 9, clock: "21:05" }, legacy_class: "R", logical_namespace: "rp" } };
  const event = { id: "couple", title: "couple confirmed", description: "Formal relationship on day nine; day eight was affection only.", reality_id: "42", event_time: { day: 9, clock: "21:05" }, participants: ["river", "traveler"], evidence_ids: ["e1"], logical_namespace: "rp" };
  const acquisition = { id: "a1", character_id: "river", target_type: "events", target_id: "couple", acquisition_channel: "DIRECT_EXPERIENCE", acquired_at: { day: 9, clock: "21:05" }, reality_id: "42", ic_status: "in_character", scope: "target_claim", evidence_ids: ["e1"], logical_namespace: "rp" };
  const lib = "archive/rp/library/";
  json(root, lib + "registry.json", { schema_version: "2.1", namespace_refs: { rp: lib + "rp/registry.json", ooc: lib + "ooc/registry.json", unknown: lib + "unknown/registry.json" } });
  json(root, lib + "rp/registry.json", { events: { couple: event }, acquisitions: { a1: acquisition } });
  json(root, lib + "ooc/registry.json", { claims: { planning: { id: "planning", title: "publication discussion", description: "An author discussion; not a character experience.", reality_id: "0", event_time: null, evidence_ids: ["e0"], logical_namespace: "ooc" } } });
  const oocRaw = "Fictional author considers private publication.\n";
  fs.writeFileSync(path.join(root, "archive/rp/raw/ooc.md"), oocRaw);
  evidence.e0 = { ...evidence.e1, evidence_id: "e0", source_path: "archive/rp/raw/ooc.md", source_id: `src-${hash(oocRaw)}`, source_version: hash(oocRaw), excerpt_sha256: hash(oocRaw), reality_id: "0", event_time: null, legacy_class: "O", logical_namespace: "ooc" };
  json(root, lib + "unknown/registry.json", {});
  json(root, lib + "evidence/registry.json", evidence);
  json(root, lib + "evidence/passages.json", { e1: [{ char_start: 0, char_end: Array.from(raw).length, namespace: "rp" }] });
  json(root, lib + "audit/knowledge-results.json", { entries: { a1: { status: "INSUFFICIENT_EVIDENCE", occurrence_verdict: "PASS", reviewed_fingerprint: hash(pythonJson({ entry: acquisition, evidence: { e1: evidence.e1 } })) } } });
  return { root, event, acquisition, evidence };
}
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });

it("GitHub provenance survives restart and rollback; failure/cancellation preserve the active snapshot", async () => {
  const source = fixture().root, root = temp();
  const service = new MemoryBridgeService(root, codec, new BridgePolicy()); closers.push(() => service.close());
  const fetch = vi.spyOn(github, "exportGitHub").mockResolvedValue({ source, repository: "example/crp", commit: "a".repeat(40) });
  try {
    const first = await service.import("example/crp", undefined, true);
    expect(service.status().githubSource?.commit).toBe("a".repeat(40));
    const restored = new MemoryBridgeService(root, codec, new BridgePolicy()); closers.push(() => restored.close());
    expect(restored.status().githubSource?.repository).toBe("example/crp");
    await service.import(source); expect(service.status().githubSource).toBeUndefined();
    service.rollback(); expect(service.status().snapshotId).toBe(first);
    expect(service.status().githubSource?.commit).toBe("a".repeat(40));
    fetch.mockRejectedValueOnce(new Error("BRIDGE_GITHUB_FETCH_FAILED"));
    await expect(service.import("example/crp", undefined, true)).rejects.toThrow("FETCH_FAILED");
    expect(service.status().snapshotId).toBe(first);
    let finish!: (value: { source: string; repository: string; commit: string }) => void;
    fetch.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    const pending = service.import("example/crp", undefined, true);
    await expect(service.import(source)).rejects.toThrow("IMPORT_BUSY");
    service.cancel(); finish({ source, repository: "example/crp", commit: "b".repeat(40) });
    await expect(pending).rejects.toThrow();
    expect(service.status().snapshotId).toBe(first);
    expect(fs.readdirSync(path.join(root, "github-imports"))).toEqual([]);
  } finally { fetch.mockRestore(); }
});

describe("CRP read-only and knowledge boundaries", () => {
  it("authenticated-service backend shares real snapshot retrieval and source pagination without widening character knowledge", async () => {
    const snapshot = await importSnapshot(fixture().root, temp(), []), execute = createSnapshotQueryExecutor(snapshot, randomBytes(32));
    const author = { id: "author", policyVersion: "v1", expiresAt: Date.now() + 60000, scopes: [{ ...scope, audience: "archive-reference" as const }] };
    const context = await execute(author, { operation: "context", input: {} }, AbortSignal.timeout(10000)) as any;
    const found = await execute(author, { operation: "search", input: { context: context.context, query: "couple" } }, AbortSignal.timeout(10000)) as any;
    expect(found.memories.some((m: any) => m.memoryId === "events:couple")).toBe(true);
    const read = await execute(author, { operation: "read", input: { context: context.context, memoryId: "events:couple", offset: 0 } }, AbortSignal.timeout(10000)) as any;
    expect(read.memories[0].contentKind).toBe("verbatim"); expect(read.memories[0].source[0].excerptSha256).toBeTruthy();
    const character = { ...author, id: "character", scopes: [scope] };
    const charContext = await execute(character, { operation: "context", input: {} }, AbortSignal.timeout(10000)) as any;
    const charRead = await execute(character, { operation: "read", input: { context: charContext.context, memoryId: "events:couple" } }, AbortSignal.timeout(10000)) as any;
    expect(charRead.memories[0].contentKind).toBe("summary"); expect(charRead.memories[0].content).not.toContain("😀");
    const explanation = await execute(author, { operation: "explain", input: { context: context.context, receiptId: found.receiptId } }, AbortSignal.timeout(10000)) as any;
    expect(explanation.evidence.length).toBeGreaterThan(0);
    const denied = await execute(character, { operation: "explain", input: { context: charContext.context, receiptId: found.receiptId } }, AbortSignal.timeout(10000)) as any;
    expect(denied.status).toBe("unknown");
  });
  it("ordinary-chat reference recall requires an authorized read and is cleared by scope changes", async () => {
    const root = temp(), service = new MemoryBridgeService(root, codec, new BridgePolicy()); closers.push(() => service.close());
    await service.import(fixture().root); service.setEnabled(true); service.setPluginActive(true); service.setRetrievalV3(true); service.setRecallRealities("normal", ["42"]);
    expect(await service.normalRecallContextAsync("normal", "那次后来呢", "desktop")).not.toContain("events:couple");
    await service.queryAsync({ sessionId: "normal", runId: "r", origin: "desktop", fingerprint: service.fingerprint("normal"), id: "events:couple" });
    expect(await service.normalRecallContextAsync("normal", "那次后来呢", "desktop")).toContain("events:couple");
    service.setRecallRealities("normal", ["0"]);
    expect(await service.normalRecallContextAsync("normal", "那次后来呢", "desktop")).not.toContain("events:couple");
  });
  it("read-only recall verification checks real source bytes and the final budget without altering the snapshot", async () => {
    const f = fixture(), snapshot = await importSnapshot(f.root, temp(), []);
    const before = fs.readFileSync(path.join(snapshot.root, "snapshot.json"));
    const report = await verifySnapshotRecall(snapshot.root, { query: "couple", realities: ["42"], expectedIds: ["events:couple"], detailIds: ["claims:planning"] });
    expect(report.expected[0]).toMatchObject({ v3: true, budgeted: true });
    expect(report.modelAttempts).toBe(0); expect(report.runtimeAnswerVerified).toBe(false);
    expect(report.details.find(detail => detail.id === "claims:planning")?.found).toBe(false);
    expect(fs.readFileSync(path.join(snapshot.root, "snapshot.json"))).toEqual(before);
    expect(fs.readdirSync(snapshot.root).sort()).toEqual(["archive", "snapshot.json"]);
  });
  it("per-operation decoded-source reuse does not hide wrong excerpts or later file changes", async () => {
    const f = fixture(), lib = "archive/rp/library/", raw = fs.readFileSync(path.join(f.root, "archive/rp/raw/test.md"), "utf8");
    f.evidence.e2 = { ...f.evidence.e1, evidence_id: "e2", char_start: 0, char_end: 1, excerpt_sha256: hash(Array.from(raw)[0]) };
    json(f.root, lib + "evidence/registry.json", f.evidence);
    const snapshot = await importSnapshot(f.root, temp(), []);
    expect(snapshot.documents({ ...scope, audience: "archive-reference" }).length).toBeGreaterThan(0);
    fs.writeFileSync(path.join(snapshot.root, "archive/rp/raw/test.md"), raw.replace("Fictional", "Frictional"));
    expect(() => snapshot.documents({ ...scope, audience: "archive-reference" })).toThrow("SOURCE_CHANGED");
    f.evidence.e2.excerpt_sha256 = "0".repeat(64); json(f.root, lib + "evidence/registry.json", f.evidence);
    await expect(importSnapshot(f.root, temp(), [])).rejects.toThrow("EXCERPT_HASH");
  });
  it("migration preview is deterministic, preserves original assessment bytes and refuses changed source", async () => {
    const f = fixture(), snapshot = await importSnapshot(f.root, temp(), []);
    const audit = path.join(snapshot.root, "archive/rp/library/audit/knowledge-results.json"), before = fs.readFileSync(audit);
    const preview = previewLegacyMigration(snapshot.root);
    expect(previewLegacyMigration(snapshot.root)).toEqual(preview);
    expect(preview.mode).toBe("read-only-preview"); expect(preview.auditComplete).toBe(false);
    expect(preview.assessments[0].sourceSha256).toBe(hash(before));
    expect(preview.objects.find(r => r.legacyId === "a1")).toMatchObject({ namespace: "rp", kind: "acquisitions" });
    expect(fs.readFileSync(audit)).toEqual(before);
    fs.appendFileSync(audit, " "); expect(() => previewLegacyMigration(snapshot.root)).toThrow();
  });
  it("v3 searches authorized evidence text in ordinary chat without leaking raw text into character summaries", async () => {
    const f = fixture();
    const raw = "Fictional 😀 couple confirmed on day nine. Secretword heliotrope.\n";
    fs.writeFileSync(path.join(f.root, "archive/rp/raw/test.md"), raw);
    f.evidence.e1.source_id = `src-${hash(raw)}`; f.evidence.e1.source_version = hash(raw); f.evidence.e1.excerpt_sha256 = hash(raw);
    json(f.root, "archive/rp/library/evidence/registry.json", f.evidence);
    json(f.root, "archive/rp/library/evidence/passages.json", { e1: [{ char_start: 0, char_end: Array.from(raw).length, namespace: "rp" }] });
    json(f.root, "archive/rp/library/audit/knowledge-results.json", { entries: { a1: { status: "INSUFFICIENT_EVIDENCE", occurrence_verdict: "PASS", reviewed_fingerprint: hash(pythonJson({ entry: f.acquisition, evidence: { e1: f.evidence.e1 } })) } } });
    const root = temp(), factory = vi.fn();
    const service = new MemoryBridgeService(root, codec, new BridgePolicy(), () => [], factory); closers.push(() => service.close());
    await service.import(f.root); service.setEnabled(true); service.setPluginActive(true); service.setRecallRealities("normal", ["42"]);
    expect(await service.normalRecallContextAsync("normal", "heliotrope", "desktop")).not.toContain("Secretword");
    service.setRetrievalV3(true);
    expect(await service.normalRecallContextAsync("normal", "heliotrope", "desktop")).toContain("Secretword");
    expect((await service.previewAsync({ ...scope, audience: "archive-reference" }, "heliotrope")).memories[0].content).toContain("Secretword");
    const fingerprint = service.fingerprint("normal");
    expect((await service.queryAsync({ sessionId: "normal", runId: "r", origin: "desktop", fingerprint, id: "events:couple" })).memories[0].content).toContain("Secretword");
    expect((await service.queryAsync({ sessionId: "normal", runId: "r", origin: "desktop", fingerprint, id: "claims:planning" })).memories).toEqual([]);
    await expect(service.queryAsync({ sessionId: "normal", runId: "r", origin: "channel", fingerprint, id: "events:couple" })).rejects.toThrow("ACCESS_DENIED");
    await expect(service.queryAsync({ sessionId: "normal", runId: "r", origin: "desktop", fingerprint: "stale", id: "events:couple" })).rejects.toThrow("RUN_SCOPE_CHANGED");
    expect(factory).not.toHaveBeenCalled();
    service.bindNew("character", scope);
    expect((await service.queryAsync({ sessionId: "character", runId: "r", origin: "desktop", query: "heliotrope" })).memories).toEqual([]);
    const restored = new MemoryBridgeService(root, codec, new BridgePolicy()); closers.push(() => restored.close());
    expect(restored.status().retrievalV3Enabled).toBe(true);
  });
  it("environment lock prevents local-model probing even with saved semantic opt-in", async () => {
    const provider = { name: "mock", dims: 2, cacheIdentity: { provider: "local", model: "mock", dimensions: 2 }, embed: vi.fn(async () => [1, 0]), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])) };
    const factory = vi.fn(() => provider), service = new MemoryBridgeService(temp(), codec, new BridgePolicy(), () => [], factory); closers.push(() => service.close());
    await service.import(fixture().root); service.setEnabled(true); service.setPluginActive(true); service.setLocalSemantic(true); factory.mockClear();
    vi.stubEnv("CYRENE_CRP_DISABLE_LOCAL_MODELS", "1");
    try {
      service.setRetrievalV3(true); service.setRecallRealities("normal", ["42"]);
      await service.normalRecallContextAsync("normal", "couple", "desktop");
      expect(factory).not.toHaveBeenCalled(); expect(() => service.setLocalSemantic(true)).toThrow("LOCAL_MODELS_DISABLED");
    } finally { vi.unstubAllEnvs(); }
  });
  it("persistent v3 indexes survive restart but cannot hide changed registry/audit metadata", async () => {
    const root = temp(), service = new MemoryBridgeService(root, codec, new BridgePolicy()); closers.push(() => service.close());
    const id = await service.import(fixture().root); service.setEnabled(true); service.setPluginActive(true); service.setRetrievalV3(true); service.setRecallRealities("normal", ["42"]);
    expect(await service.normalRecallContextAsync("normal", "couple", "desktop")).toContain("events:couple");
    expect(fs.existsSync(path.join(root, "indexes/crp-v3/retrieval-v1.sqlite"))).toBe(true);
    const restored = new MemoryBridgeService(root, codec, new BridgePolicy()); closers.push(() => restored.close()); restored.setPluginActive(true);
    expect(await restored.normalRecallContextAsync("normal", "couple", "desktop")).toContain("events:couple");
    const audit = path.join(root, "snapshots", id, "archive/rp/library/audit/knowledge-results.json");
    fs.appendFileSync(audit, " ");
    await expect(restored.normalRecallContextAsync("normal", "couple", "desktop")).rejects.toThrow("SOURCE_CHANGED");
  });
  it("rejects a source changed while the local embedding is running and leaves staged indexes unpublished", async () => {
    const root = temp(); let finish!: (value: number[]) => void;
    const provider = { name: "mock", dims: 2, cacheIdentity: { provider: "local", model: "mock", dimensions: 2 }, embed: vi.fn(async () => new Promise<number[]>(resolve => { finish = resolve; })), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])) };
    const service = new MemoryBridgeService(root, codec, new BridgePolicy(), () => [], () => provider); closers.push(() => service.close());
    const id = await service.import(fixture().root); service.setEnabled(true); service.setPluginActive(true); service.setRetrievalV3(true); service.setLocalSemantic(true); service.setRecallRealities("normal", ["42"]);
    const pending = service.normalRecallContextAsync("normal", "couple", "desktop");
    fs.appendFileSync(path.join(root, "snapshots", id, "archive/rp/raw/test.md"), "changed during retrieval"); finish([1, 0]);
    await expect(pending).rejects.toThrow("SOURCE_CHANGED");
  });
  it("v3 indexes manuscript tails while keeping legacy pagination and future-version boundaries", async () => {
    const f = fixture(), lib = "archive/rp/library/", body = "fictional page. ".repeat(300) + "tailword chrysanthemum 😀\n";
    fs.mkdirSync(path.join(f.root, "manuscripts/texts"), { recursive: true });
    fs.writeFileSync(path.join(f.root, "manuscripts/texts/poem.md"), body);
    const version = { version_id: "poem-v1", title: "a poem", reality: "42", components: [{ path: "manuscripts/texts/poem.md", archived_text_sha256: hash(body) }] };
    json(f.root, "manuscripts/catalog.json", { versions: [version, { ...version, version_id: "poem-future" }] });
    json(f.root, lib + "registry.json", { schema_version: "2.1", namespace_refs: { rp: lib + "rp/registry.json" }, work_evidence: { "poem-v1": { version_time: { day: 8 } }, "poem-future": { version_time: { day: 10 } } } });
    const snapshot = await importSnapshot(f.root, temp(), []), archive = { ...scope, audience: "archive-reference" as const };
    expect(snapshot.get(archive, "work_version:poem-v1").memories[0].content).not.toContain("chrysanthemum");
    const docs = snapshot.documents(archive);
    expect(docs.some(d => d.text.includes("chrysanthemum"))).toBe(true);
    expect(docs.some(d => d.memory.memoryId === "work_version:poem-future")).toBe(false);
    expect(snapshot.documents(scope).some(d => d.memory.memoryId.startsWith("work_version:"))).toBe(false);
  });
  it("v3 cancels after scope changes before a local model reply can be released", async () => {
    let finish!: (value: number[]) => void;
    const provider = { name: "mock", dims: 2, cacheIdentity: { provider: "local", model: "mock", dimensions: 2 }, embed: vi.fn(async () => new Promise<number[]>(resolve => { finish = resolve; })), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])) };
    const service = new MemoryBridgeService(temp(), codec, new BridgePolicy(), () => [], () => provider); closers.push(() => service.close());
    await service.import(fixture().root); service.setEnabled(true); service.setPluginActive(true); service.setRetrievalV3(true); service.setLocalSemantic(true); service.setRecallRealities("normal", ["42"]);
    const pending = service.normalRecallContextAsync("normal", "partnership", "desktop");
    service.setRecallRealities("normal", []); finish([1, 0]);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(provider.embedBatch).not.toHaveBeenCalled();
  });
  it("reads Unicode-offset evidence and gates manuscript text by specific version and acquisition channel", async () => {
    const f = fixture(), lib = "archive/rp/library/";
    const raw = fs.readFileSync(path.join(f.root, "archive/rp/raw/test.md"), "utf8");
    f.evidence.e1.char_start = 0; f.evidence.e1.char_end = Array.from(raw).length;
    json(f.root, lib + "evidence/registry.json", f.evidence);
    const body = "An entirely fictional poem 😀.\n";
    fs.mkdirSync(path.join(f.root, "manuscripts/works"), { recursive: true }); fs.writeFileSync(path.join(f.root, "manuscripts/works/poem.md"), body);
    const version = { version_id: "poem-v1", title: "fictional poem", reality: "42", text_completeness: "COMPLETE_TEXT", components: [{ path: "manuscripts/works/poem.md", archived_text_sha256: hash(body) }] };
    json(f.root, "manuscripts/catalog.json", { versions: [version, { ...version, version_id: "poem-v2" }] });
    json(f.root, lib + "registry.json", { schema_version: "2.1", namespace_refs: { rp: lib + "rp/registry.json" }, work_evidence: { "poem-v1": { version_time: { day: 8 } }, "poem-v2": { version_time: { day: 10 } } } });
    const acquisition = { ...f.acquisition, target_type: "work_version", target_id: "poem-v1", acquisition_channel: "READ_FULL" };
    json(f.root, lib + "rp/registry.json", { acquisitions: { a1: acquisition } });
    json(f.root, lib + "audit/knowledge-results.json", { entries: { a1: { status: "PASS", reviewed_fingerprint: hash(pythonJson({ entry: acquisition, evidence: { e1: f.evidence.e1 } })) } } });
    let snap = await importSnapshot(f.root, temp(), []);
    expect(snap.get(scope, "work_version:poem-v1").memories[0]).toMatchObject({ content: body, contentKind: "verbatim", contentOffset: 0, nextOffset: Array.from(body).length });
    expect(snap.get({ ...scope, audience: "archive-reference" }, "work_version:poem-v2").status).toBe("unknown");
    f.evidence.e1.legacy_class = "O";
    json(f.root, lib + "evidence/registry.json", f.evidence);
    json(f.root, lib + "audit/knowledge-results.json", { entries: { a1: { status: "PASS", reviewed_fingerprint: hash(pythonJson({ entry: acquisition, evidence: { e1: f.evidence.e1 } })) } } });
    snap = await importSnapshot(f.root, temp(), []);
    expect(snap.get(scope, "work_version:poem-v1").status).toBe("unknown");
    expect(snap.get({ ...scope, audience: "archive-reference" }, "work_version:poem-v1").memories[0].content).toBe(body);
    f.evidence.e1.legacy_class = "R";
    json(f.root, lib + "evidence/registry.json", f.evidence);
    acquisition.acquisition_channel = "TITLE_ONLY";
    json(f.root, lib + "rp/registry.json", { acquisitions: { a1: acquisition } });
    json(f.root, lib + "audit/knowledge-results.json", { entries: { a1: { status: "PASS", reviewed_fingerprint: hash(pythonJson({ entry: acquisition, evidence: { e1: f.evidence.e1 } })) } } });
    snap = await importSnapshot(f.root, temp(), []); expect(snap.get(scope, "work_version:poem-v1").status).toBe("unknown");
  });
  it("A/D/F: day nine confirmation is traceable, day eight/other reality/other character/unknown stay unknown", async () => {
    const f = fixture();
    const before = fs.readFileSync(path.join(f.root, "archive/rp/raw/test.md"));
    const snap = await importSnapshot(f.root, temp(), []);
    const result = snap.search(scope, "couple");
    expect(result.memories[0]).toMatchObject({ acquiredAt: { day: 9, clock: "21:05" }, occurrenceVerdict: "PASS", fullAuditStatus: "INSUFFICIENT_EVIDENCE", contentKind: "summary" });
    expect(result.memories[0].source[0].excerptSha256).toBe(hash(before));
    for (const s of [{ ...scope, asOf: { day: 8 } }, { ...scope, asOf: { day: 9, clock: "21:04" } }, { ...scope, realityId: "43" }, { ...scope, characterId: "outsider" }, { ...scope, branchId: "other" }]) {
      expect(snap.search(s, "couple").status).toBe("unknown");
      expect(snap.get(s, "events:couple").status).toBe("unknown");
    }
    expect(snap.search(scope, "unrelated-unicorn").status).toBe("unknown");
    expect(snap.get(scope, "events:couple").memories[0].contentKind).toBe("summary");
    expect(snap.get({ ...scope, audience: "archive-reference" }, "events:couple").memories[0].contentKind).toBe("verbatim");
    expect(fs.readFileSync(path.join(f.root, "archive/rp/raw/test.md"))).toEqual(before);
  });
  it("B: OOC is separately labelled and cannot become RP knowledge", async () => {
    const f = fixture(), snap = await importSnapshot(f.root, temp(), []);
    expect(snap.search(scope, "publication").status).toBe("unknown");
    expect(snap.search({ domain: "reality0", realityId: "0", branchId: null, audience: "archive-reference" }, "publication").memories[0]).toMatchObject({ domain: "reality0", realityId: "0", occurrenceVerdict: "NOT_REVIEWED" });
  });
  it.each(["TITLE_ONLY", "RECEIVED", "UNKNOWN"])("denies unsupported channel %s", async channel => {
    const f = fixture(); f.acquisition.acquisition_channel = channel;
    json(f.root, "archive/rp/library/rp/registry.json", { events: { couple: f.event }, acquisitions: { a1: f.acquisition } });
    json(f.root, "archive/rp/library/audit/knowledge-results.json", { entries: { a1: { status: "PASS", reviewed_fingerprint: hash(pythonJson({ entry: f.acquisition, evidence: { e1: f.evidence.e1 } })) } } });
    expect((await importSnapshot(f.root, temp(), [])).search(scope, "couple").status).toBe("unknown");
  });
  it("does not expand a narrow acquired scope into the target's private archival description", async () => {
    const f = fixture(); f.acquisition.acquisition_channel = "HEARD_REPORT"; f.acquisition.scope = "Only the public meeting location was disclosed.";
    f.event.description = "Private archival description of an undisclosed secret.";
    json(f.root, "archive/rp/library/rp/registry.json", { events: { couple: f.event }, acquisitions: { a1: f.acquisition } });
    json(f.root, "archive/rp/library/audit/knowledge-results.json", { entries: { a1: { status: "PASS", reviewed_fingerprint: hash(pythonJson({ entry: f.acquisition, evidence: { e1: f.evidence.e1 } })) } } });
    const snap = await importSnapshot(f.root, temp(), []);
    const result = snap.get(scope, "events:couple");
    expect(result.memories[0].content).toContain("Only the public meeting location");
    expect(JSON.stringify(result)).not.toContain("undisclosed secret");
    expect(result.memories[0].participants).toEqual(["river"]); expect(result.memories[0].eventTime).toBeNull();
  });
  it("rejects stale audit fingerprints and mixed OOC passages", async () => {
    const f = fixture(); f.event.logical_namespace = "rp";
    json(f.root, "archive/rp/library/evidence/passages.json", { e1: [{ namespace: "rp" }, { namespace: "ooc" }] });
    expect((await importSnapshot(f.root, temp(), [])).search(scope, "couple").status).toBe("unknown");
    json(f.root, "archive/rp/library/evidence/passages.json", { e1: [{ namespace: "rp" }] });
    f.acquisition.acquired_at = { day: 8, clock: "21:05" };
    json(f.root, "archive/rp/library/rp/registry.json", { events: { couple: f.event }, acquisitions: { a1: f.acquisition } });
    expect((await importSnapshot(f.root, temp(), [])).search(scope, "couple").status).toBe("unknown");
  });
  it("rejects source mutation after load, pending transactions, unsafe paths and cancellation", async () => {
    const f = fixture(), output = temp(), snap = await importSnapshot(f.root, output, []);
    expect(snap.search(scope, "couple").status).toBe("ok");
    fs.writeFileSync(path.join(snap.root, "archive/rp/raw/test.md"), "tampered");
    expect(() => snap.get(scope, "events:couple")).toThrow("SOURCE_CHANGED");
    json(f.root, ".crp-runtime/pending.json", {});
    await expect(importSnapshot(f.root, output, [])).rejects.toThrow("PENDING_TRANSACTION");
    fs.rmSync(path.join(f.root, ".crp-runtime/pending.json"));
    f.evidence.e1.source_path = "../outside.md";
    json(f.root, "archive/rp/library/evidence/registry.json", f.evidence);
    await expect(importSnapshot(f.root, output, [])).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(importSnapshot(f.root, output, [], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(importSnapshot(f.root, path.join(f.root, "output"), [])).rejects.toThrow("ROOT_OVERLAP");
    expect(fs.existsSync(path.join(f.root, "output"))).toBe(false);
  });
  it("rejects a junction inside the source tree without following it", async () => {
    const f = fixture(), outside = temp(); fs.writeFileSync(path.join(outside, "private.md"), "fictional outside file");
    fs.symlinkSync(outside, path.join(f.root, "archive/rp/raw/junction"), "junction");
    await expect(importSnapshot(f.root, temp(), [])).rejects.toThrow("UNSAFE_PATH");
    expect(fs.readFileSync(path.join(outside, "private.md"), "utf8")).toBe("fictional outside file");
  });
  it("keeps same-day imprecise acquisition and future versions out of minute queries", () => {
    expect(visible({ day: 9 }, { day: 9, clock: "21:05" })).toBe(false);
    expect(visible({ day: 9, not_after: "21:04" }, { day: 9, clock: "21:05" })).toBe(true);
    expect(visible(null, { day: 9 })).toBe(false);
  });
});

describe("explicit personal records, consent and backups", () => {
  function store(domain: "writer" | "reality0" = "writer") { const file = path.join(temp(), "memory.sqlite"); const s = new LocalMemoryStore(file, domain, codec); closers.push(() => s.close()); return s; }
  it("v3 finds private record tails only with exact-run consent and never creates a durable private index", async () => {
    const root = temp(), factory = vi.fn(), service = new MemoryBridgeService(root, codec, new BridgePolicy(), () => [], factory); closers.push(() => service.close());
    service.bindNew("private", { domain: "writer", realityId: "-1", branchId: null, audience: "archive-reference" }); service.setEnabled(true); service.setPluginActive(true); service.setRetrievalV3(true);
    const record = service.manage("create", { domain: "writer", confirmed: true, record: { content: "fictional private text. ".repeat(100) + "heliotrope 😀", participants: [], sensitive: true } }) as { id: string; revision: number };
    const request = () => ({ sessionId: "private", runId: "run1", origin: "desktop", modelTarget: "approved", fingerprint: service.fingerprint("private"), query: "heliotrope" });
    expect((await service.queryAsync(request())).status).toBe("unknown");
    service.manage("grant", { domain: "writer", confirmed: true, id: record.id, revision: record.revision, sessionId: "private", modelTarget: "approved" });
    const found = await service.queryAsync(request()); expect(found.memories[0].content).toContain("heliotrope"); expect(found.memories[0].contentKind).toBe("user_statement");
    expect((await service.queryAsync({ ...request(), runId: "run2" })).memories).toEqual([]);
    expect(fs.existsSync(path.join(root, "indexes"))).toBe(false); expect(factory).not.toHaveBeenCalled();
    const page = service.query({ ...request(), id: record.id, offset: 2100 }); expect(page.memories[0].contentOffset).toBe(2100);
    service.manage("revoke", { domain: "writer", confirmed: true, id: record.id }); expect((await service.queryAsync(request())).memories).toEqual([]);
  });
  it("private consent expiry during model work blocks release and subsequent embedding batches", async () => {
    let finish!: (v: number[]) => void; let now = Date.now(); const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const provider = { name: "mock", dims: 2, cacheIdentity: { provider: "local", model: "mock", dimensions: 2 }, embed: vi.fn(async () => new Promise<number[]>(resolve => { finish = resolve; })), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])) };
    try {
      const service = new MemoryBridgeService(temp(), codec, new BridgePolicy(), () => [], () => provider); closers.push(() => service.close());
      service.bindNew("private", { domain: "writer", realityId: "-1", branchId: null, audience: "archive-reference" }); service.setEnabled(true); service.setPluginActive(true); service.setRetrievalV3(true); service.setLocalSemantic(true);
      const record = service.manage("create", { domain: "writer", confirmed: true, record: { content: "fictional private record", participants: [], sensitive: true } }) as { id: string; revision: number };
      service.manage("grant", { domain: "writer", confirmed: true, id: record.id, revision: record.revision, sessionId: "private", modelTarget: "approved" });
      const pending = service.queryAsync({ sessionId: "private", runId: "run1", origin: "desktop", modelTarget: "approved", fingerprint: service.fingerprint("private"), query: "companionship" });
      now += 11 * 60000; finish([1, 0]); await expect(pending).rejects.toThrow("CONSENT_CHANGED"); expect(provider.embedBatch).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it("C/E: empty is unknown, versions survive restart and update revokes run consent", () => {
    const s = store(); expect(s.forModel("s", "r")).toEqual([]);
    const r = s.create({ content: "A fictional writer builds a telescope", sensitive: true, participants: [] });
    expect(fs.readFileSync(s.file).includes(Buffer.from("telescope"))).toBe(false);
    expect(s.forModel("s", "r")).toEqual([]);
    s.grant(r.id, 1, "s"); expect(s.forModel("s", "r")).toHaveLength(1);
    expect(s.forModel("s", "another-run")).toEqual([]);
    expect(s.forModel("other-session", "r")).toEqual([]);
    s.update(r.id, 1, { content: "A fictional writer builds a clock", sensitive: true, participants: [] });
    expect(s.forModel("s", "r")).toEqual([]);
    expect(() => s.update(r.id, 1, r)).toThrow("REVISION_CONFLICT");
    expect(s.versions(r.id)).toHaveLength(2);
    const reopened = new LocalMemoryStore(s.file, "writer", codec); closers.push(() => reopened.close());
    expect(reopened.list()[0]).toMatchObject({ revision: 2, content: "A fictional writer builds a clock" });
    expect(() => s.export(false)).toThrow("SENSITIVE_EXPORT");
    s.grant(r.id, 2, "s"); s.revoke(r.id); expect(s.forModel("s", "r")).toEqual([]);
  });
  it("G: restores into a separate file without consent; deletion targets one record only", () => {
    const s = store();
    const a = s.create({ content: "alpha", sensitive: false, participants: [] });
    const b = s.create({ content: "beta", sensitive: false, participants: [] });
    s.grant(a.id, 1, "s");
    const backups = temp(), id = s.backup(backups);
    s.remove(a.id, 1, false); expect(s.list().map(r => r.id)).toEqual([b.id]);
    expect(s.versions(a.id)).toHaveLength(1);
    const restored = LocalMemoryStore.restore(backups, id, temp(), "writer", codec); closers.push(() => restored.close());
    expect(restored.file).not.toBe(s.file); expect(restored.list()).toHaveLength(2); expect(restored.forModel("s", "r")).toEqual([]);
    s.remove(a.id, 1, true); expect(s.versions(a.id)).toEqual([]); expect(s.list()).toHaveLength(1);
    fs.appendFileSync(path.join(backups, id, "memory.sqlite"), "corrupt");
    expect(() => LocalMemoryStore.restore(backups, id, temp(), "writer", codec)).toThrow("BACKUP_CHECKSUM");
    expect(() => LocalMemoryStore.restore(backups, "../outside", temp(), "writer", codec)).toThrow("INVALID_BACKUP");
  });
  it("refuses sensitive persistence without secure encryption and domain mismatches", () => {
    const file = path.join(temp(), "memory.sqlite");
    const s = new LocalMemoryStore(file, "writer", { ...codec, available: () => false }); closers.push(() => s.close());
    expect(() => s.create({ content: "sensitive", sensitive: true, participants: [] })).toThrow("ENCRYPTION_UNAVAILABLE");
    expect(() => new LocalMemoryStore(file, "reality0", codec)).toThrow("DOMAIN_MISMATCH");
    expect(s.list()).toEqual([]);
  });
});

describe("host-owned scope lifecycle", () => {
  it("ordinary conversations recall multiple explicitly selected realities and persist selection without dedicated-session restrictions", async () => {
    const f = fixture(), root = temp();
    f.event.description = "shared keyword: fictional relationship";
    json(f.root, "archive/rp/library/rp/registry.json", { events: { couple: f.event }, acquisitions: { a1: f.acquisition } });
    json(f.root, "archive/rp/library/ooc/registry.json", { claims: { discussion: { id: "discussion", title: "shared keyword author discussion", reality_id: "0", event_time: null, evidence_ids: ["e0"] } } });
    const policy = new BridgePolicy(), service = new MemoryBridgeService(root, codec, policy); closers.push(() => service.close());
    await service.import(f.root); service.setEnabled(true);
    expect(service.recallState("ordinary").available).toEqual(["0", "42"]);
    service.setRecallRealities("ordinary", ["42", "0"]);
    expect(policy.protects("ordinary")).toBe(false); expect(policy.blocksLegacy("ordinary")).toBe(true);
    expect(service.contextFloor("ordinary", "r1", 20)).toBe(0);
    const context = service.normalRecallContext("ordinary", "shared keyword", "desktop");
    expect(context).toContain('"realityId":"42"'); expect(context).toContain('"realityId":"0"'); expect(context).toContain("不向 RP 人物自动授予");
    expect(service.normalRecallContext("ordinary", "shared", "channel")).toBe("");
    const reloaded = new BridgePolicy(); reloaded.initialize(root); expect(reloaded.recall("ordinary")?.realities).toEqual(["42", "0"]);
    const oldFingerprint = service.fingerprint("ordinary");
    service.setRecallRealities("ordinary", ["0"]);
    expect(() => service.normalRecallContext("ordinary", "shared", "desktop", undefined, oldFingerprint)).toThrow("RUN_SCOPE_CHANGED");
    expect(service.contextFloor("ordinary", "r2", 30)).toBe(30);
    expect(service.normalRecallContext("ordinary", "shared keyword", "desktop")).not.toContain('"realityId":"42"');
    service.setRecallRealities("ordinary", []); expect(service.normalRecallContext("ordinary", "shared keyword", "desktop")).toBe("");
    expect(() => service.setRecallRealities("ordinary", ["-1"])).toThrow("RECALL_DENIED");
    service.setRecallRealities(undefined, ["42"]); service.inheritRecall("new-chat");
    expect(service.recallState("new-chat").realities).toEqual(["42"]); expect(service.recallState().realities).toEqual([]);
  });
  it("refuses runtime stores inside repository or Vault roots before creating any files", () => {
    const forbidden = temp(), root = path.join(forbidden, "nested-profile", "bridge");
    expect(() => new MemoryBridgeService(root, codec, new BridgePolicy(), () => [forbidden])).toThrow("FORBIDDEN_DATA_ROOT");
    expect(fs.existsSync(root)).toBe(false);
  });
  it("continuity remains raw-pending, needs explicit scoped review, and expires on snapshot update", async () => {
    const f = fixture(); fs.mkdirSync(path.join(f.root, "archive/rp/continuity"), { recursive: true });
    fs.writeFileSync(path.join(f.root, "archive/rp/continuity/test.md"), "Fictional current-chat milestone; raw transcript not yet archived.");
    const service = new MemoryBridgeService(temp(), codec, new BridgePolicy()); closers.push(() => service.close());
    await service.import(f.root); service.setEnabled(true); service.setPluginActive(true);
    const id = service.mapContinuity({ path: "archive/rp/continuity/test.md", scope: { ...scope, asOf: { day: 9, clock: "21:05" } }, content: "Fictional milestone keyword zeta", confirmed: true });
    service.bindNew("scoped", scope);
    const result = service.query({ sessionId: "scoped", runId: "r", origin: "desktop", id });
    expect(result.memories[0]).toMatchObject({ evidenceType: "CONTINUITY_SUMMARY_RAW_PENDING", fullAuditStatus: "NOT_REVIEWED", occurrenceVerdict: "USER_CONFIRMED_MAPPING", contentKind: "summary" });
    expect(service.preview({ ...scope, asOf: { day: 8 } }, "zeta").status).toBe("unknown");
    service.unmapContinuity(id, true); expect(service.query({ sessionId: "scoped", runId: "r-next", origin: "desktop", id }).status).toBe("unknown");
    service.mapContinuity({ path: "archive/rp/continuity/test.md", scope: { ...scope, asOf: { day: 9, clock: "21:05" } }, content: "Fictional milestone keyword zeta corrected", confirmed: true });
    expect(() => service.mapContinuity({ path: "archive/rp/continuity/test.md", scope, content: "zeta" })).toThrow("CONFIRMATION_REQUIRED");
    await service.import(f.root); expect(service.query({ sessionId: "scoped", runId: "r2", origin: "desktop", id }).status).toBe("unknown");
  });
  it("semantic search uses only an explicitly enabled local provider and authorized candidates", async () => {
    const provider = { name: "mock-local", dims: 2, cacheIdentity: { provider: "local", model: "mock", dimensions: 2 }, embed: vi.fn(async () => [1, 0]), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])) };
    const service = new MemoryBridgeService(temp(), codec, new BridgePolicy(), () => [], () => provider); closers.push(() => service.close());
    await service.import(fixture().root); service.bindNew("scoped", scope); service.setEnabled(true); service.setPluginActive(true);
    const input = { sessionId: "scoped", runId: "r", origin: "desktop", query: "partnership" };
    expect((await service.queryAsync(input)).status).toBe("unknown"); expect(provider.embed).not.toHaveBeenCalled();
    service.setLocalSemantic(true);
    const result = await service.queryAsync(input); expect(result.memories[0].memoryId).toBe("events:couple");
    expect(JSON.stringify(provider.embedBatch.mock.calls)).not.toContain("publication");
    expect(result.memories[0].fullAuditStatus).toBe("INSUFFICIENT_EVIDENCE");
    service.bindNew("earlier", { ...scope, asOf: { day: 8 } }); provider.embed.mockClear();
    expect((await service.queryAsync({ ...input, sessionId: "earlier" })).status).toBe("unknown"); expect(provider.embed).not.toHaveBeenCalled();
    let resolve!: (v: number[]) => void; provider.embed.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = service.queryAsync(input); await Promise.resolve(); service.cancel(); resolve([1, 0]);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  it("rejects cloud-provider substitution and binds personal grants to the exact model destination", () => {
    const cloud = new MemoryBridgeService(temp(), codec, new BridgePolicy(), () => [], () => ({ cacheIdentity: { provider: "openai" } } as any)); closers.push(() => cloud.close());
    expect(() => cloud.setLocalSemantic(true)).toThrow("LOCAL_MODEL_NOT_INSTALLED");
    const s = new LocalMemoryStore(path.join(temp(), "memory.sqlite"), "writer", codec); closers.push(() => s.close());
    const record = s.create({ content: "fictional personal record", sensitive: false, participants: [] });
    s.grant(record.id, 1, "s", "destination-A"); expect(s.forModel("s", "r", "destination-B")).toEqual([]); expect(s.forModel("s", "r", "destination-A")).toHaveLength(1);
  });
  it("persists isolation after disable/restart; denies external origins, unbound sessions and stale runs", async () => {
    const root = temp(), policy = new BridgePolicy();
    const service = new MemoryBridgeService(root, codec, policy); closers.push(() => service.close());
    expect(service.status().enabled).toBe(false);
    const writer = { domain: "writer", realityId: "-1", audience: "archive-reference", branchId: null };
    service.bindNew("private-session", writer);
    service.setEnabled(true); service.setPluginActive(true);
    const request = { sessionId: "private-session", runId: "r1", origin: "desktop", query: "clock", fingerprint: service.fingerprint("private-session") };
    expect(service.query(request).status).toBe("unknown");
    expect(() => service.query({ ...request, origin: "channel" })).toThrow("ACCESS_DENIED");
    expect(() => service.query({ ...request, sessionId: "unbound" })).toThrow();
    expect(() => service.bindNew("private-session", writer)).toThrow("NEW_SESSION_REQUIRED");
    service.manage("create", { domain: "writer", record: { content: "clock", sensitive: false, participants: [] }, confirmed: true });
    expect(() => service.query(request)).toThrow("RUN_SCOPE_CHANGED");
    expect(() => service.manage("create", { domain: "writer", record: { content: "clock", sensitive: false, participants: [] } })).toThrow("CONFIRMATION_REQUIRED");
    service.setPluginActive(false); expect(policy.protects("private-session")).toBe(true);
    const reloaded = new BridgePolicy(); reloaded.initialize(root); expect(reloaded.protects("private-session")).toBe(true);
    service.deactivate("private-session"); expect(policy.protects("private-session")).toBe(true); expect(() => policy.scope("private-session")).toThrow();
  });
  it("fails closed on corrupt persistent policy", () => {
    const root = temp(); fs.writeFileSync(path.join(root, "bridge-policy.json"), "broken");
    const policy = new BridgePolicy(); policy.initialize(root);
    expect(policy.protects("unknown-session")).toBe(true); expect(() => policy.scope("unknown-session")).toThrow();
  });
  it("cancelled/failed snapshot update preserves previous active snapshot", async () => {
    const policy = new BridgePolicy(), service = new MemoryBridgeService(temp(), codec, policy); closers.push(() => service.close());
    const first = await service.import(fixture().root);
    const controller = new AbortController(); controller.abort();
    await expect(service.import(fixture().root, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(service.status().snapshotId).toBe(first);
    const second = await service.import(fixture().root); expect(second).not.toBe(first);
    service.rollback(); expect(service.status().snapshotId).toBe(first);
  });
});
