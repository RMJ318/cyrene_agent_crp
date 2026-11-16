import { expect, it, vi } from "vitest";
import { reciprocalRankFusion, retrieveCrp } from "./retrieval";
import type { CrpDocument } from "./contracts";
import type { EmbeddingProvider } from "../rag/embedding";
import { planCrpQuery } from "./query-plan";

function document(id: string, text: string): CrpDocument {
  return { id, text, memory: { memoryId: id, domain: "rp", realityId: "42", branchId: null, participants: [], eventTime: null, acquiredAt: null,
    acquisitionChannel: null, source: [], evidenceType: "TEST", sourceVerification: "TEST", occurrenceVerdict: "NOT_REVIEWED", fullAuditStatus: "NOT_REVIEWED",
    epistemicStatus: "test", content: text, contentKind: "summary", truncated: false, access: { audience: "archive-reference" } } };
}
it("can recall a semantic-only item after the legacy 200-item cutoff", async () => {
  const documents = Array.from({ length: 230 }, (_, i) => document(`d${i}`, i === 229 ? "a committed companionship" : "irrelevant rock"));
  const provider: EmbeddingProvider = { name: "mock", dims: 2, cacheIdentity: { provider: "local", model: "mock", dimensions: 2 },
    embed: vi.fn(async () => [1, 0]), embedBatch: vi.fn(async texts => texts.map(t => t.includes("companionship") ? [1, 0] : [0, 1])) };
  const result = await retrieveCrp("partnership", documents, { localAllowed: true, localProvider: () => provider });
  expect(result.documents[0].id).toBe("d229"); expect(result.trace.semanticHits).toBe(1);
});
it("does not even probe models when disabled and degrades to authorized lexical data on failure", async () => {
  const factory = vi.fn(() => { throw new Error("model unavailable"); }); const docs = [document("a", "fictional keyword")];
  expect((await retrieveCrp("keyword", docs, { localAllowed: false, localProvider: factory })).documents[0].id).toBe("a");
  expect(factory).not.toHaveBeenCalled();
  const failed = await retrieveCrp("keyword", docs, { localAllowed: true, localProvider: factory });
  expect(failed.trace.degraded).toBe(true); expect(failed.documents[0].id).toBe("a");
});
it("isolates cached embeddings by model identity and rejects cancellation after a model reply", async () => {
  const cache = new Map<string, number[]>(), docs = [document("a", "keyword")];
  const embedBatch = vi.fn(async () => [[1, 0]]); let model = "one";
  const provider = () => ({ name: model, dims: 2, cacheIdentity: { provider: "local", model, dimensions: 2 }, embed: async () => [1, 0], embedBatch });
  await retrieveCrp("keyword", docs, { localAllowed: true, localProvider: provider, vectors: cache }); model = "two";
  await retrieveCrp("keyword", docs, { localAllowed: true, localProvider: provider, vectors: cache }); expect(embedBatch).toHaveBeenCalledTimes(2);
  const abort = new AbortController();
  await expect(retrieveCrp("keyword", docs, { localAllowed: true, signal: abort.signal, localProvider: () => ({ ...provider(), embed: async () => { abort.abort(); return [1, 0]; } }) })).rejects.toMatchObject({ name: "AbortError" });
});
it("fuses independent ranks without rewarding duplicate entries and keeps unknown questions empty", async () => {
  expect(reciprocalRankFusion([["a", "a"], ["b", "a"]], 2)).toEqual(["a", "b"]);
  expect((await retrieveCrp("absent", [document("a", "rock")], { localAllowed: false })).documents).toEqual([]);
});
it("matches stable IDs, retries missing participant metadata only once, and rejects foreign reranker IDs", async () => {
  const unrelated = document("unrelated", "ordinary stone"), target = document("events:fictional-target", "a distant heliotrope promise");
  unrelated.memory.participants = ["actor"]; const aliases = [{ text: "虚构甲", entityId: "actor", realityId: "42" }];
  const retry = await retrieveCrp("虚构甲 heliotrope", [unrelated, target], { localAllowed: false, aliases });
  expect(retry.trace.supplementalSearches).toBe(1); expect(retry.documents[0].id).toBe(target.id);
  const exact = await retrieveCrp("查找 events:fictional-target", [unrelated, target], { localAllowed: false }); expect(exact.documents[0].id).toBe(target.id);
  const a = document("a", "flower"), b = document("b", "flower in a field");
  const bad = await retrieveCrp("flower", [a, b], { localAllowed: false, rerank: async () => ["unselected-private-id"] });
  expect(bad.trace.rerank).toBe("degraded"); expect(bad.documents.every(d => ["a", "b"].includes(d.id))).toBe(true);
});
it("uses an explicit previously-read reference for pronouns without reviving a removed scope", async () => {
  const target = document("events:reference", "a fictional promise");
  const reference = { memoryId: target.memory.memoryId, domain: target.memory.domain, realityId: target.memory.realityId, branchId: target.memory.branchId };
  const follow = await retrieveCrp("那次后来呢", [target], { localAllowed: false, reference });
  expect(follow.trace.referenceUsed).toBe(true); expect(follow.documents[0].id).toBe(target.id);
  expect((await retrieveCrp("那次后来呢", [], { localAllowed: false, reference })).documents).toEqual([]);
  expect((await retrieveCrp("那次后来呢 #43", [target], { localAllowed: false, reference })).trace.referenceUsed).not.toBe(true);
});
it("finds an event despite test boilerplate, nickname distractors and compound Chinese segmentation", async () => {
  // Synthetic reproduction of the user's question; no private transcript is copied.
  const confession = document("event", "昔涟主动表白并保留关系自主\n她表达喜欢，仍保留关系命名的自主性。");
  confession.memory.participants = ["ronghao", "cyrene"]; confession.memory.realityId = "33550336";
  const duplicate = structuredClone(confession); duplicate.id = "relationship"; duplicate.memory.memoryId = "relationship";
  const distractors = Array.from({ length: 20 }, (_, i) => {
    const d = document(`d${i}`, "记忆测试研究：测试一下记忆，小光和小涟的称呼背景；不是那次事件。");
    d.memory.participants = ["ronghao", "cyrene"]; d.memory.realityId = "33550336"; return d;
  });
  const unrelated = document("wrong-observer", "表白的事她并未获知。"); unrelated.memory.realityId = "33550336"; unrelated.memory.participants = ["other"];
  const aliases = [{ text: "小光", entityId: "ronghao", realityId: "33550336" }, { text: "小涟", entityId: "cyrene", realityId: "33550336" }];
  const query = "测试一下记忆：还记得#33550336小光和小涟表白的时候吗";
  expect(planCrpQuery(query, aliases).focus).toBe("表白");
  expect(planCrpQuery("看看 #13 的记录", aliases).normalized).toContain("#13");
  const result = await retrieveCrp(query, [...distractors, unrelated, confession, duplicate], { localAllowed: false, aliases });
  expect(result.documents[0].memory.content).toContain("主动表白");
  expect(result.documents.filter(d => d.memory.content.includes("主动表白"))).toHaveLength(1);
  expect(result.documents.some(d => d.id === "wrong-observer")).toBe(false);
});
