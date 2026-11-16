import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CrpCoreStore } from "./core-store";
import { CrpBudgetLedger } from "./budget-ledger";
import { CRP_CORE_VERSION, changeFingerprint, type CoreChangeSet, type CoreRecord } from "./core-contracts";
import { hash } from "../memory-bridge/safety";
import { CrpModelRuntime } from "./model-runtime";
import { NO_MODEL_POLICY } from "./contracts";
import { spawnSync } from "node:child_process";

const roots: string[] = [], closers: Array<() => void> = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "crp-core-store-")); roots.push(root); return root; };
afterEach(() => { for (const f of closers.splice(0).reverse()) f(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const source = temp(), destination = temp(), text = "原文及审计测试，不是真实档案。\n";
  fs.writeFileSync(path.join(source, "original.md"), text);
  const record: CoreRecord<"source"> = { contract: CRP_CORE_VERSION, kind: "source", id: "source", revision: 1, namespace: "rp",
    coordinates: { realityId: "42", branchId: null }, provenance: [], data: { path: "original.md", sha256: hash(text), byteLength: Buffer.byteLength(text), encoding: "utf-8", media: "transcript" } };
  return { source, destination, record, text };
}
function changes(head: ReturnType<CrpCoreStore["read"]>): CoreChangeSet {
  const record: CoreRecord<"entity"> = { contract: CRP_CORE_VERSION, kind: "entity", id: "entity", revision: 1, namespace: "rp", coordinates: { realityId: "42", branchId: null }, provenance: [], data: { name: "虚构人物", aliases: [], identityLinks: [] } };
  const c: CoreChangeSet = { contract: CRP_CORE_VERSION, id: "change", baseSnapshot: head.id, baseManifestSha256: head.digest, state: "reviewed", protectedFiles: head.protectedFiles,
    readSet: [{ id: "source", revision: 1 }], operations: [{ expectedRevision: null, record }], review: null };
  c.review = { reviewer: "test-reviewer", changeFingerprint: changeFingerprint(c) }; return c;
}
it("publishes once, restores after restart and preserves additions when reading historical generations", () => {
  const f = fixture(); let store = new CrpCoreStore(f.destination, f.source, () => true);
  const initial = store.initialize([f.record], {}), change = changes(initial), next = store.publish(change);
  expect(store.publish(change).id).toBe(next.id); store.close();
  store = new CrpCoreStore(f.destination, f.source, () => true); closers.push(() => store.close());
  expect(store.read().id).toBe(next.id); expect(store.read(initial.id).records).toHaveLength(1);
  expect(store.read().records).toHaveLength(2); expect(fs.readFileSync(path.join(f.source, "original.md"), "utf8")).toBe(f.text);
});
it("recovers an interrupted SQLite writer without losing the committed head", () => {
  const f = fixture(); let store = new CrpCoreStore(f.destination, f.source, () => true);
  const head = store.initialize([f.record], {}); store.close();
  const script = "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO generations(id,digest,payload) VALUES(?,?,?)').run('uncommitted','bad','{}');process.exit(71);";
  const child = spawnSync(process.execPath, ["-e", script, path.join(f.destination, "core-v1.sqlite")], { encoding: "utf8", timeout: 10000 });
  expect(child.status).toBe(71);
  store = new CrpCoreStore(f.destination, f.source, () => true); closers.push(() => store.close()); expect(store.read().id).toBe(head.id);
});
it("rejects stale simultaneous writers and denies untrusted or altered reviews", () => {
  const f = fixture(), one = new CrpCoreStore(f.destination, f.source, () => true), two = new CrpCoreStore(f.destination, f.source, () => true);
  closers.push(() => one.close(), () => two.close());
  const head = one.initialize([f.record], {}), c = changes(head); one.publish(c);
  const stale = changes(head); stale.id = "other-change"; stale.review!.changeFingerprint = changeFingerprint(stale);
  expect(() => two.publish(stale)).toThrow("BASE_CHANGED");
  const denied = new CrpCoreStore(f.destination, f.source, () => false); closers.push(() => denied.close()); expect(() => denied.publish(c)).toThrow("REVIEW_DENIED");
  const changed = changes(one.read()); changed.operations[0].record.id = "another";
  expect(() => one.publish(changed)).toThrow(); expect(one.read().records).toHaveLength(2);
});
it("does not publish on cancellation or changed protected bytes", () => {
  const f = fixture(), store = new CrpCoreStore(f.destination, f.source, () => true); closers.push(() => store.close());
  const head = store.initialize([f.record], {}), change = changes(head), signal = AbortSignal.abort();
  expect(() => store.publish(change, signal)).toThrow(); expect(store.read().id).toBe(head.id);
  fs.appendFileSync(path.join(f.source, "original.md"), "tampered"); expect(() => store.publish(change)).toThrow("SOURCE_CHANGED");
  fs.writeFileSync(path.join(f.source, "original.md"), f.text); expect(store.read().id).toBe(head.id);
});
it("preserves ordered work fragments and rejects invented separators or hashes", () => {
  const f = fixture(), source2 = { ...f.record, id: "source2", data: { ...f.record.data, path: "second.md", sha256: hash("😀尾段"), byteLength: Buffer.byteLength("😀尾段") } };
  fs.writeFileSync(path.join(f.source, "second.md"), "😀尾段");
  const work: CoreRecord<"work"> = { ...f.record, id: "work", kind: "work", data: { title: "fragmented work", authors: [], currentVersion: null } };
  const version: CoreRecord<"work-version"> = { ...f.record, id: "version", kind: "work-version", data: { work: { id: "work", revision: 1 }, source: { id: "source", revision: 1 }, evidence: [], supersedes: null, state: "draft",
    components: [{ source: { id: "source", revision: 1 }, range: { unit: "codepoint", start: 0, end: 2 } }, { source: { id: "source2", revision: 1 }, range: null }], joiner: "", contentSha256: hash("原文😀尾段") } };
  const store = new CrpCoreStore(f.destination, f.source, () => true); closers.push(() => store.close());
  const head = store.initialize([f.record, source2, work, version], {}); expect(store.content(head, version).text).toBe("原文😀尾段");
  const bad = new CrpCoreStore(temp(), f.source, () => true); closers.push(() => bad.close());
  version.data.joiner = "\n"; expect(() => bad.initialize([f.record, source2, work, version], {})).toThrow("WORK_CONTENT_HASH");
});
it("durably charges uncertain requests and atomically limits two runtime instances", async () => {
  const root = temp(); let ledger = new CrpBudgetLedger(root);
  const ticket = ledger.reserve("approved-task", 1, 0.6); ledger.close();
  ledger = new CrpBudgetLedger(root); closers.push(() => ledger.close());
  expect(ledger.usedUsd("approved-task")).toBe(0.6); expect(() => ledger.reserve("approved-task", 1, 0.6)).toThrow("BUDGET_EXCEEDED");
  ledger.settle(ticket, 0.2); expect(ledger.usedUsd("approved-task")).toBe(0.2);
  const other = new CrpBudgetLedger(root); closers.push(() => other.close());
  const route = { provider: "openai" as const, model: "mock", identity: "mock-only" };
  const runtime = new CrpModelRuntime({ openai: async () => { throw Error("simulated lost reply"); } }, { store: ledger, account: "approved-task" });
  runtime.configure({ ...NO_MODEL_POLICY, cloudAllowed: true, budgetUsd: 1, routes: { rerank: route } });
  await expect(runtime.execute({ capability: "rerank", input: "fiction", routeIdentity: route.identity, allowCloudDisclosure: true, maxCostUsd: 0.6 })).rejects.toThrow("MODEL_OPERATION_FAILED");
  expect(other.usedUsd("approved-task")).toBe(0.8); expect(() => other.reserve("approved-task", 1, 0.3)).toThrow("BUDGET_EXCEEDED");
});
