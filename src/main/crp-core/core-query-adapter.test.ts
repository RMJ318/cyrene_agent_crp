import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { CrpCoreQueryAdapter } from "./core-query-adapter";
import { CrpCoreStore } from "./core-store";
import { CRP_CORE_VERSION, type CoreKind, type CorePayloads, type CoreRecord } from "./core-contracts";
import { bindCoreContext } from "./query-contracts";
import { hash } from "../memory-bridge/safety";

const roots: string[] = [], closers: Array<() => void> = [];
afterEach(() => { for (const f of closers.splice(0)) f(); for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
const temp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), "crp-query-test-")); roots.push(p); return p; };
const ref = (id: string) => ({ id, revision: 1 });
function r<K extends CoreKind>(kind: K, id: string, data: CorePayloads[K]): CoreRecord<K> {
  return { contract: CRP_CORE_VERSION, id, revision: 1, kind, namespace: "rp", coordinates: { realityId: "42", branchId: null }, provenance: [], data } as CoreRecord<K>;
}
function fixture(extent: "title" | "hearsay" = "hearsay") {
  const source = temp(), destination = temp(), text = "😀虚构原文。\n第二行保留。\n"; fs.writeFileSync(path.join(source, "source.md"), text);
  const records: CoreRecord[] = [
    r("source", "source", { path: "source.md", sha256: hash(text), byteLength: Buffer.byteLength(text), encoding: "utf-8", media: "transcript" }),
    r("evidence", "evidence", { source: ref("source"), range: { unit: "codepoint", start: 0, end: 1 }, excerptSha256: hash("😀") }),
    r("entity", "character", { name: "虚构人物", aliases: [], identityLinks: [] }),
    r("claim", "claim", { subject: ref("character"), predicate: "knowledge", value: "fictional claim", epistemicStatus: "asserted", evidence: [ref("evidence")] }),
    r("event", "event", { title: "fictional event", occurredAt: { day: 8, clock: null, notAfter: null, precision: "day" }, participants: [ref("character")], evidence: [ref("evidence")] }),
    r("acquisition", "acquisition", { character: ref("character"), object: ref("claim"), acquiredAt: { day: 8, clock: null, notAfter: null, precision: "day" }, extent, channels: ["hearsay"], evidence: [ref("evidence")], assessment: ref("knowledge") }),
    ...(["knowledge", "occurrence"] as const).map(dimension => r("assessment", dimension, { subject: ref("acquisition"), dimension, verdict: "PASS", authority: "reviewed", basisFingerprint: hash("fictional reviewer"), algorithm: "test-only", evidence: [ref("evidence")], legacy: null })),
    r("thread", "thread1", { title: "fictional thread one", state: "active", anchors: [ref("event")], lastVerifiedAt: null }),
    r("thread", "thread2", { title: "fictional thread two", state: "active", anchors: [ref("claim")], lastVerifiedAt: null }),
    r("coverage", "coverage", { source: ref("source"), range: { unit: "line", start: 1, end: 2 }, direction: "source-to-registered", state: "read", checks: [], assessments: [] }),
  ];
  const store = new CrpCoreStore(destination, source, () => true); closers.push(() => store.close()); const head = store.initialize(records, {});
  const base = { snapshotId: head.id, sourceManifestSha256: head.digest, indexIdentity: "test-index", policyFingerprint: "test-policy" };
  const author = bindCoreContext({ ...base, scopes: [{ domain: "rp", realityId: "42", branchId: null, audience: "archive-reference" }] });
  const character = bindCoreContext({ ...base, scopes: [{ domain: "rp", realityId: "42", branchId: null, audience: "character-knowledge", characterId: "character", asOf: { day: 9 } }] });
  const adapter = new CrpCoreQueryAdapter(store, randomBytes(32), () => true, () => true);
  return { adapter, author, character, records, store, source, text };
}
it("executes all eight canonical methods with source receipts and bounded Unicode reads", async () => {
  const { adapter, author } = fixture();
  expect((await adapter.execute(author, { method: "open_context", input: {} })).capabilities).toHaveLength(8);
  const found = await adapter.execute(author, { method: "search", input: { query: "fictional claim", limit: 5, cursor: null } }); expect(found.records.some(r => r.id === "claim")).toBe(true);
  const read = await adapter.execute(author, { method: "read", input: { ref: ref("source"), offset: 0, pageSize: 1 } });
  expect(read.contentPage).toMatchObject({ text: "😀", nextOffset: 1, kind: "verbatim" }); expect(read.receipt.sourceChecks[0].verified).toBe(true);
  expect((await adapter.execute(author, { method: "timeline", input: { fromDay: 8, toDay: 9, participants: ["character"], limit: 10, cursor: null } })).records.some(r => r.id === "event")).toBe(true);
  expect((await adapter.execute(author, { method: "related", input: { ref: ref("claim"), relation: "evidence", limit: 10, cursor: null } })).records[0].id).toBe("evidence");
  expect((await adapter.execute(author, { method: "continuity", input: { thread: null, limit: 10, cursor: null } })).records).toHaveLength(2);
  expect((await adapter.execute(author, { method: "coverage", input: { source: ref("source"), direction: "source-to-registered", limit: 10, cursor: null } })).records[0].id).toBe("coverage");
  expect((await adapter.execute(author, { method: "explain", input: { receiptId: found.receipt.id } })).receipt.id).toBe(found.receipt.id);
});
it("releases acquired claims but denies raw evidence, unacquired events, early dates and title-only knowledge", async () => {
  const { adapter, character } = fixture();
  const read = (id: string, context = character) => adapter.execute(context, { method: "read", input: { ref: ref(id), offset: 0, pageSize: 100 } });
  expect((await read("claim")).status).toBe("ok"); expect((await read("source")).status).toBe("unknown"); expect((await read("event")).status).toBe("unknown");
  const early = bindCoreContext({ ...character, scopes: [{ ...character.scopes[0], asOf: { day: 7 } }] }); expect((await read("claim", early)).status).toBe("unknown");
  const title = fixture("title"); expect((await title.adapter.execute(title.character, { method: "read", input: { ref: ref("claim"), offset: 0, pageSize: 100 } })).status).toBe("unknown");
});
it("binds continuation cursors and receipts to the exact permission context", async () => {
  const { adapter, author, character } = fixture();
  const first = await adapter.execute(author, { method: "continuity", input: { thread: null, limit: 1, cursor: null } }); expect(first.nextCursor).toBeTruthy();
  expect((await adapter.execute(author, { method: "continuity", input: { thread: null, limit: 1, cursor: first.nextCursor } })).records[0].id).not.toBe(first.records[0].id);
  await expect(adapter.execute(character, { method: "continuity", input: { thread: null, limit: 1, cursor: first.nextCursor } })).rejects.toThrow("CURSOR_INVALID");
  expect((await adapter.execute(character, { method: "explain", input: { receiptId: first.receipt.id } })).status).toBe("unknown");
});
it("refuses corrupted evidence before initializing authority", () => {
  const f = fixture(); const record = f.records.find(r => r.kind === "evidence") as CoreRecord<"evidence">; record.data.excerptSha256 = hash("wrong");
  const store = new CrpCoreStore(temp(), f.source, () => true); closers.push(() => store.close()); expect(() => store.initialize(f.records, {})).toThrow("EVIDENCE_HASH");
});
