import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { PersistentCrpIndex } from "./persistent-index";
import { retrieveCrp } from "./retrieval";
import { hash } from "../memory-bridge/safety";
import type { CrpDocument } from "./contracts";

const roots: string[] = [];
const directory = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "crp-index-test-")); roots.push(root); return root; };
const tokens = { words: [{ word: "fiction", tag: "eng", isStop: false, isNoun: false }], characters: [] };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function doc(id: string, text = "fictional phrase"): CrpDocument {
  return { id, text, memory: { memoryId: id, domain: "rp", realityId: "42", branchId: null, participants: [], eventTime: null, acquiredAt: null,
    acquisitionChannel: null, source: [], evidenceType: "TEST", sourceVerification: "TEST", occurrenceVerdict: "NOT_REVIEWED", fullAuditStatus: "NOT_REVIEWED",
    epistemicStatus: "unknown", content: text, contentKind: "summary", truncated: false, access: { audience: "archive-reference" } } };
}
it("restores committed indexes across restart and isolates snapshot/scope generations", () => {
  const root = directory(), ns = hash("snapshot + author + scope"), key = hash("text + tokenizer");
  let index = new PersistentCrpIndex(root, ns);
  index.putTokens(key, tokens); index.putVector(hash("model one"), [1, 0]); index.commit(); index.close();
  index = new PersistentCrpIndex(root, ns);
  expect(index.tokens(key)).toEqual(tokens); expect(index.vector(hash("model one"))).toEqual([1, 0]);
  expect(index.vector(hash("model two"))).toBeUndefined(); index.close();
  index = new PersistentCrpIndex(root, hash("same snapshot + different scope"));
  expect(index.tokens(key)).toBeUndefined(); expect(index.vector(hash("model one"))).toBeUndefined(); index.close();
});
it("does not publish staged data on close or cancellation, preserving the previous generation", () => {
  const root = directory(), ns = hash("scope"), key = hash("key");
  let index = new PersistentCrpIndex(root, ns); index.putTokens(key, tokens); index.commit(); index.close();
  index = new PersistentCrpIndex(root, ns); index.putTokens(key, { words: [], characters: [] });
  const controller = new AbortController(); controller.abort();
  expect(() => index.commit(controller.signal)).toThrow(); index.close();
  index = new PersistentCrpIndex(root, ns); expect(index.tokens(key)).toEqual(tokens); index.close();
});
it("rebuilds corrupt rows and refuses future schemas without overwriting them", () => {
  const root = directory(), ns = hash("scope"), key = hash("key");
  let index = new PersistentCrpIndex(root, ns); index.putTokens(key, tokens); index.commit(); index.close();
  let db = new DatabaseSync(path.join(root, "retrieval-v1.sqlite"));
  db.prepare("UPDATE entries SET payload=?").run("broken"); db.close();
  index = new PersistentCrpIndex(root, ns); expect(index.tokens(key)).toBeUndefined(); index.putTokens(key, tokens); index.commit(); index.close();
  db = new DatabaseSync(path.join(root, "retrieval-v1.sqlite")); db.exec("PRAGMA user_version=99"); db.close();
  expect(() => new PersistentCrpIndex(root, ns)).toThrow("VERSION");
  db = new DatabaseSync(path.join(root, "retrieval-v1.sqlite")); expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(99); db.close();
});
it("rolls back partial publication on SQLite write failure", () => {
  const root = directory(), ns = hash("scope"), first = hash("first"), failing = hash("failing");
  let index = new PersistentCrpIndex(root, ns); index.putTokens(first, tokens); index.commit(); index.close();
  const db = new DatabaseSync(path.join(root, "retrieval-v1.sqlite"));
  db.exec(`CREATE TRIGGER simulated_full BEFORE INSERT ON entries WHEN NEW.key='${failing}' BEGIN SELECT RAISE(ABORT,'simulated disk full'); END;`); db.close();
  index = new PersistentCrpIndex(root, ns); index.putTokens(first, { words: [], characters: [] }); index.putTokens(failing, tokens);
  expect(() => index.commit()).toThrow("simulated disk full"); index.close();
  index = new PersistentCrpIndex(root, ns); expect(index.tokens(first)).toEqual(tokens); expect(index.tokens(failing)).toBeUndefined(); index.close();
});
it("reuses local vectors after restart but never returns cached unauthorized documents or probes a disabled model", async () => {
  const root = directory(), ns = hash("scope"), docs = [doc("allowed"), doc("later-revoked")];
  const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
  const factory = vi.fn(() => ({ name: "mock", dims: 2, cacheIdentity: { provider: "local" as const, model: "one", dimensions: 2, artifactSha256: hash("mock weights"), preprocessing: "test-v1", pooling: "mean-normalized" }, embed: async () => [1, 0], embedBatch }));
  let index = new PersistentCrpIndex(root, ns);
  await retrieveCrp("other concept", docs, { localAllowed: true, localProvider: factory, index }); index.commit(); index.close();
  index = new PersistentCrpIndex(root, ns);
  const result = await retrieveCrp("other concept", docs.slice(0, 1), { localAllowed: true, localProvider: factory, index });
  expect(embedBatch).toHaveBeenCalledTimes(1); expect(result.documents.map(d => d.id)).toEqual(["allowed"]);
  factory.mockClear(); await retrieveCrp("phrase", docs, { localAllowed: false, localProvider: factory, index }); expect(factory).not.toHaveBeenCalled(); index.close();
});
it("does not persist private statement vectors and degrades a broken cache without losing lexical recall", async () => {
  const root = directory(), ns = hash("scope"), privateDoc = doc("private"); privateDoc.memory.contentKind = "user_statement";
  const embedBatch = vi.fn(async () => [[1, 0]]);
  const factory = () => ({ name: "mock", dims: 2, cacheIdentity: { provider: "local" as const, model: "one", dimensions: 2, artifactSha256: hash("mock weights"), preprocessing: "test-v1", pooling: "mean-normalized" }, embed: async () => [1, 0], embedBatch });
  let index = new PersistentCrpIndex(root, ns);
  await retrieveCrp("phrase", [privateDoc], { localAllowed: true, localProvider: factory, index }); index.commit(); index.close();
  index = new PersistentCrpIndex(root, ns);
  await retrieveCrp("phrase", [privateDoc], { localAllowed: true, localProvider: factory, index }); expect(embedBatch).toHaveBeenCalledTimes(2); index.close();
  const broken = { tokens: () => { throw new Error("disk"); }, vector: () => { throw new Error("disk"); }, putTokens() {}, putVector() {}, commit() {}, close() {}, hits: 0, misses: 0 };
  expect((await retrieveCrp("phrase", [doc("safe")], { localAllowed: false, index: broken })).documents[0].id).toBe("safe");
});
it("refuses durable vectors without a verified model artifact identity", async () => {
  const root = directory(), ns = hash("scope");
  const embedBatch = vi.fn(async () => [[1, 0]]);
  const factory = () => ({ name: "legacy mock", dims: 2, cacheIdentity: { provider: "local" as const, model: "same-name", dimensions: 2 }, embed: async () => [1, 0], embedBatch });
  for (let round = 0; round < 2; round++) {
    const index = new PersistentCrpIndex(root, ns);
    try { await retrieveCrp("concept", [doc("allowed")], { localAllowed: true, localProvider: factory, index }); index.commit(); }
    finally { index.close(); }
  }
  expect(embedBatch).toHaveBeenCalledTimes(2);
});
it("does not follow a cache file symlink", () => {
  const root = directory(), other = directory(), target = path.join(other, "untouched"); fs.writeFileSync(target, "protected");
  try { fs.symlinkSync(target, path.join(root, "retrieval-v1.sqlite")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
  expect(() => new PersistentCrpIndex(root, hash("scope"))).toThrow("UNSAFE_PATH"); expect(fs.readFileSync(target, "utf8")).toBe("protected");
});
