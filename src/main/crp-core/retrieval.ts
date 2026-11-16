import { getJiebaCustomWordsIdentity, rankTextCandidates, rankTokenizedCandidates, tokenizeText } from "../rag/text-ranking";
import { getSearchJiebaCacheIdentity, tokenizeSearchBatch } from "../search-jieba";
import type { CrpIndexCache } from "./persistent-index";
import type { EmbeddingProvider } from "../rag/embedding";
import { cosineSimilarity } from "../rag/vector-math";
import { assertNotAborted, fail, hash } from "../memory-bridge/safety";
import { CRP_CONTRACT_VERSION, type CrpAlias, type CrpDocument, type CrpRetrievalTrace } from "./contracts";
import { characterSearchTokens, planCrpQuery } from "./query-plan";
import type { BridgeResult } from "../../shared/memory-bridge";

export interface CrpRetrievalResult { documents: CrpDocument[]; trace: CrpRetrievalTrace }
export function toBridgeResult(snapshotId: string, result: CrpRetrievalResult): BridgeResult {
  const trace = result.trace;
  return { status: result.documents.length ? "ok" : "unknown", memories: result.documents.map(d => d.memory), snapshotId,
    gaps: [`CRP ${trace.contract}: ${trace.documents} authorized chunks; ${trace.mode}; lexical=${trace.lexicalHits}; semantic=${trace.semanticHits}${trace.degraded ? "; local semantic unavailable, authorized lexical fallback only" : ""}.`,
      "Source fidelity, occurrence review and full audit remain separate."] };
}

/** Independent candidate lists are fused by rank, never by incomparable raw scores. */
export function reciprocalRankFusion(lists: readonly (readonly string[])[], limit: number, constant = 60): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) for (const [index, id] of [...new Set(list)].entries()) scores.set(id, (scores.get(id) ?? 0) + 1 / (constant + index + 1));
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([id]) => id);
}

/** Input documents MUST already be projected by the trusted snapshot/consent adapter. */
export async function retrieveCrp(query: string, documents: readonly CrpDocument[], options: {
  signal?: AbortSignal; localProvider?: () => EmbeddingProvider | null; localAllowed: boolean;
  limit?: number; vectors?: Map<string, number[]>;
  aliases?: readonly CrpAlias[];
  selectedRealities?: readonly string[];
  index?: CrpIndexCache;
  /** Optional host-authorized reranker. It can reorder at most 30 authorized candidates, never add IDs. */
  rerank?: (documents: readonly CrpDocument[], signal?: AbortSignal) => Promise<readonly string[]>;
  reference?: Pick<import("../../shared/memory-bridge").BridgeMemory, "memoryId" | "domain" | "realityId" | "branchId">;
  guard?: () => void;
}): Promise<CrpRetrievalResult> {
  const check = () => { assertNotAborted(options.signal); options.guard?.(); };
  check();
  if (typeof query !== "string" || query.length > 2000 || documents.length > 20_000 || options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)) fail("RETRIEVAL_LIMIT");
  const docs = [...new Map(documents.map(d => [d.id, d])).values()];
  const plan = planCrpQuery(query, options.aliases, options.selectedRealities);
  const entityMatch = (doc: CrpDocument) => {
    const required = plan.entities.get(doc.memory.realityId);
    return !required?.size || [...required].every(id => doc.memory.participants.includes(id));
  };
  const focused = docs.filter(entityMatch);
  const lexicalPool = focused.length ? focused : docs;
  // Cache contents never supply documents or authorization, only expensive derived numbers/tokens.
  let cache = options.index;
  const cached = <T>(action: () => T): T | undefined => { try { return action(); } catch { cache = undefined; return undefined; } };
  const eligible = (doc: CrpDocument) => doc.memory.domain !== "writer" && doc.memory.contentKind !== "user_statement";
  const tokenized = tokenizeSearchBatch(() => tokenizeText(plan.focus), () => lexicalPool.map(item => {
    const tokenizer = getSearchJiebaCacheIdentity();
    const key = hash(JSON.stringify(["crp-tokenizer-v1", tokenizer, getJiebaCustomWordsIdentity(), item.id, item.memory.source, item.text]));
    // Never persist native-load failure tokens under the successful tokenizer identity.
    const reusable = !!tokenizer && eligible(item);
    const found = reusable && cache ? cached(() => cache!.tokens(key)) : undefined;
    const tokens = found || { words: tokenizeText(item.text), characters: characterSearchTokens(item.text) };
    if (!found && reusable && cache) cached(() => cache!.putTokens(key, tokens));
    return { item, ...tokens };
  }));
  let lexical = rankTokenizedCandidates(tokenized.queryTokens, tokenized.documents.map(d => ({ item: d.item, tokens: d.words })), 60).filter(r => r.score > 0).map(r => r.item.id);
  let characters = rankTokenizedCandidates(characterSearchTokens(plan.focus), tokenized.documents.map(d => ({ item: d.item, tokens: d.characters })), 60).filter(r => r.score > 0).map(r => r.item.id);
  const exact = docs.filter(d => d.memory.memoryId.length >= 4 && query.includes(d.memory.memoryId)).map(d => d.id);
  const trace: CrpRetrievalTrace = { contract: CRP_CONTRACT_VERSION, documents: docs.length, lexicalHits: lexical.length, semanticHits: 0, mode: "lexical", degraded: false, supplementalSearches: 0, exactHits: exact.length, rerank: "disabled" };
  if (!lexical.length && !characters.length && lexicalPool.length < docs.length) {
    // One bounded retry for missing participant metadata. All documents remain inside the original host authorization.
    lexical = rankTextCandidates(plan.focus, docs.map(item => ({ item, text: item.text })), 60).filter(r => r.score > 0).map(r => r.item.id);
    characters = rankTokenizedCandidates(characterSearchTokens(plan.focus), docs.map(item => ({ item, tokens: characterSearchTokens(item.text) })), 60).filter(r => r.score > 0).map(r => r.item.id);
    trace.supplementalSearches = 1; trace.lexicalHits = lexical.length;
  }
  let semantic: string[] = [];
  const reference = options.reference;
  const seeds = reference && !plan.entities.size && !/#\d+/.test(plan.normalized) && /那(?:次|件|封|首|个)|这(?:件|封|首)|当时|随后|后来/u.test(query)
    ? docs.filter(d => d.memory.memoryId === reference.memoryId && d.memory.domain === reference.domain && d.memory.realityId === reference.realityId && d.memory.branchId === reference.branchId) : [];
  const referenceIds = seeds.map(d => d.id);
  if (seeds.length) trace.referenceUsed = true;
  if (query.trim() && docs.length && options.localAllowed) {
    try {
      const provider = options.localProvider?.();
      if (!provider || provider.cacheIdentity?.provider !== "local") fail("LOCAL_MODEL_NOT_INSTALLED");
      const q = await provider.embed(plan.normalized); check();
      if (provider.cacheIdentity?.provider !== "local") fail("LOCAL_MODEL_IDENTITY_CHANGED");
      const identity = JSON.stringify(provider.cacheIdentity);
      const durableVectors = /^[a-f0-9]{64}$/.test(provider.cacheIdentity.artifactSha256 ?? "")
        && !!provider.cacheIdentity.preprocessing && !!provider.cacheIdentity.pooling;
      const valid = (v: number[]) => v.length === provider.dims && v.length === q.length && v.every(Number.isFinite) && v.some(n => n !== 0);
      if (!valid(q)) fail("LOCAL_VECTOR_DIMENSIONS");
      const scores: Array<{ id: string; score: number }> = [];
      for (let start = 0; start < docs.length; start += 16) {
        check();
        const batch = docs.slice(start, start + 16);
        const keys = batch.map(d => hash(JSON.stringify([identity, d.id, d.memory.source, d.text])));
        const existing = batch.map((d, i) => options.vectors?.get(keys[i]) ?? (durableVectors && eligible(d) && cache ? cached(() => cache!.vector(keys[i])) : undefined));
        const missing = batch.map((d, i) => ({ d, i })).filter(({ i }) => !existing[i] || !valid(existing[i]!));
        const generated = missing.length ? await provider.embedBatch(missing.map(({ d }) => d.text)) : [];
        check();
        if (generated.length !== missing.length || generated.some(v => !valid(v))) fail("LOCAL_VECTOR_DIMENSIONS");
        const generatedByIndex = new Map(missing.map(({ i }, j) => [i, generated[j]]));
        const batchVectors = batch.map((_, i) => generatedByIndex.get(i) ?? existing[i]);
        batch.forEach((d, i) => {
          const vector = batchVectors[i];
          if (!vector || !valid(vector)) fail("LOCAL_VECTOR_DIMENSIONS");
          const score = cosineSimilarity(q, vector);
          if (score >= 0.4) scores.push({ id: d.id, score });
          if (durableVectors && generatedByIndex.has(i) && eligible(d) && cache) cached(() => cache!.putVector(keys[i], vector));
          if (options.vectors) {
            if (options.vectors.size >= 512) options.vectors.delete(options.vectors.keys().next().value!);
            options.vectors.set(keys[i], vector);
          }
        });
      }
      semantic = scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 60).map(r => r.id);
      trace.semanticHits = semantic.length; trace.mode = "hybrid";
    } catch { check(); trace.degraded = true; }
  }
  check();
  const map = new Map(docs.map(d => [d.id, d]));
  let fused = reciprocalRankFusion([lexical, characters, semantic, referenceIds], 180);
  if (options.rerank && fused.length > 1) {
    const candidates = fused.slice(0, 30), permitted = new Set(candidates);
    try {
      const order = await options.rerank(candidates.map(id => structuredClone(map.get(id)!)), options.signal);
      check();
      if (!Array.isArray(order) || order.length > 30 || order.some(id => typeof id !== "string" || !permitted.has(id))) fail("RERANK_REPLY_INVALID");
      fused = [...new Set([...order, ...fused])]; trace.rerank = "applied";
    } catch { check(); trace.rerank = "degraded"; }
  }
  const selected: CrpDocument[] = [], seen = new Set<string>(), seenEvidence = new Set<string>();
  for (const id of new Set([...exact, ...fused])) {
    const doc = map.get(id)!;
    const identity = JSON.stringify([doc.memory.domain, doc.memory.realityId, doc.memory.branchId, doc.memory.memoryId]);
    const evidence = hash(JSON.stringify([doc.memory.domain, doc.memory.realityId, doc.memory.branchId, doc.memory.source,
      doc.memory.access, doc.memory.eventTime, doc.memory.acquiredAt, doc.memory.contentKind, doc.memory.content,
      doc.memory.fullAuditStatus, doc.memory.occurrenceVerdict]));
    if (seen.has(identity) || seenEvidence.has(evidence)) continue;
    seen.add(identity); seenEvidence.add(evidence); selected.push(doc);
    if (selected.length >= (options.limit ?? 5)) break;
  }
  return { documents: selected, trace };
}
