import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { assertNotAborted, visible } from "../memory-bridge/safety";
import { rankTextCandidates } from "../rag/text-ranking";
import { characterSearchTokens } from "./query-plan";
import { rankTokenizedCandidates } from "../rag/text-ranking";
import { reciprocalRankFusion } from "./retrieval";
import { coreFingerprint, recordKey, type CoreRecord, type RecordRef } from "./core-contracts";
import { parseCoreQuery, type CoreMethod, type CoreQueryAdapter, type CoreQueryReceipt, type CoreQueryResponse, type CoreReadContext } from "./query-contracts";
import type { CrpCoreStore } from "./core-store";

const methods: CoreMethod[] = ["open_context", "search", "read", "timeline", "related", "continuity", "coverage", "explain"];
/** Canonical read adapter. Review verification is host-injected: a caller-written PASS is never enough. */
export class CrpCoreQueryAdapter implements CoreQueryAdapter {
  private receipts = new Map<string, CoreQueryReceipt>();
  constructor(private store: CrpCoreStore, private cursorKey: Buffer, private authorize: (context: CoreReadContext) => boolean,
    private verifiedAssessment: (assessment: CoreRecord<"assessment">) => boolean) {
    if (cursorKey.length < 32) throw Error("CRP_CURSOR_KEY_REQUIRED");
  }
  async execute(context: CoreReadContext, input: Parameters<CoreQueryAdapter["execute"]>[1], signal?: AbortSignal): Promise<CoreQueryResponse> {
    const query = parseCoreQuery(input), contextFingerprint = coreFingerprint(context);
    assertNotAborted(signal);
    if (!this.authorize(context)) throw Error("CRP_CONTEXT_DENIED");
    const generation = this.store.read(undefined, signal);
    if (generation.id !== context.snapshotId || generation.digest !== context.sourceManifestSha256) throw Error("CRP_CONTEXT_CHANGED");
    const records = generation.records, map = new Map(records.map(r => [recordKey(r), r]));
    const sameScope = (r: CoreRecord, s: CoreReadContext["scopes"][number]) =>
      r.coordinates.realityId === s.realityId && r.coordinates.branchId === s.branchId && (s.domain === "rp" ? r.namespace === "rp" : s.domain === "reality0" ? r.namespace === "ooc" : false);
    const when = (r: CoreRecord) => r.kind === "event" ? r.data.occurredAt : r.kind === "acquisition" ? r.data.acquiredAt : r.kind === "revision" ? r.data.effectiveAt : null;
    const inTime = (r: CoreRecord, s: CoreReadContext["scopes"][number]) => {
      const time = when(r); if (!time) return !s.asOf || !["event", "acquisition", "revision"].includes(r.kind);
      return visible({ day: time.day, ...(time.clock ? { clock: time.clock } : {}), ...(time.notAfter ? { not_after: time.notAfter } : {}) }, s.asOf);
    };
    const allowed = new Set<string>();
    for (const scope of context.scopes) {
      const candidates = records.filter(r => sameScope(r, scope) && inTime(r, scope));
      if (scope.audience === "archive-reference") { candidates.forEach(r => allowed.add(recordKey(r))); continue; }
      const assessments = candidates.filter((r): r is CoreRecord<"assessment"> => r.kind === "assessment" && r.data.verdict === "PASS" && this.verifiedAssessment(r));
      for (const r of candidates) {
        if (r.kind !== "acquisition" || r.data.character.id !== scope.characterId || !r.data.acquiredAt) continue;
        const target = map.get(recordKey(r.data.object));
        if (!target || !sameScope(target, scope) || !inTime(target, scope)) continue;
        const checks = assessments.filter(a => recordKey(a.data.subject) === recordKey(r));
        if (!checks.some(a => a.data.dimension === "knowledge") || !checks.some(a => a.data.dimension === "occurrence")) continue;
        // Fine-grained grants require a dedicated Claim; title/received/excerpt never expose a full record payload.
        if (["received", "title"].includes(r.data.extent) || r.data.extent !== "full" && target.kind !== "claim") continue;
        allowed.add(recordKey(target));
      }
    }
    // Navigation never escapes the authorized set, including graph edges and audit explain data.
    const authorized = records.filter(r => allowed.has(recordKey(r)));
    const latest = new Map<string, CoreRecord>();
    for (const r of authorized) if ((latest.get(r.id)?.revision ?? 0) < r.revision) latest.set(r.id, r);
    const current = authorized.filter(r => latest.get(r.id)?.revision === r.revision);
    const byRef = (ref: RecordRef) => allowed.has(recordKey(ref)) ? map.get(recordKey(ref)) : undefined;
    const result: CoreQueryResponse = { status: "unknown", contextFingerprint, records: [], nextCursor: null,
      receipt: { id: randomUUID(), contextFingerprint, method: query.method, queryFingerprint: coreFingerprint(query), sourceChecks: [], gaps: [], modelCalls: 0 } };
    if (query.method === "open_context") { result.status = "ok"; result.capabilities = [...methods]; }
    else if (query.method === "explain") {
      const previous = this.receipts.get(query.input.receiptId);
      if (previous?.contextFingerprint === contextFingerprint) { result.status = "ok"; result.receipt = structuredClone(previous); }
    } else if (query.method === "read") {
      const record = byRef(query.input.ref); if (record) {
        if (record.kind === "work-version" && record.data.components && record.data.joiner === null) {
          result.status = "insufficient_evidence"; result.records = [record]; result.receipt.gaps.push("Work component join semantics are unknown; verbatim rendering is unavailable.");
        } else {
        const content = this.store.content(generation, record), chars = Array.from(content.text);
        const { offset, pageSize } = query.input, end = Math.min(chars.length, offset + pageSize);
        result.contentPage = { text: chars.slice(offset, end).join(""), offset, nextOffset: end < chars.length ? end : null, kind: content.kind };
        if (Buffer.byteLength(JSON.stringify(record)) <= 8000) result.records = [record];
        result.status = "ok";
        }
      }
    } else {
      let candidates: CoreRecord[] = [];
      if (query.method === "search") {
        const text = (r: CoreRecord) => JSON.stringify(r.data);
        const words = rankTextCandidates(query.input.query, current.map(item => ({ item, text: text(item) })), 100).filter(r => r.score > 0).map(r => recordKey(r.item));
        const chars = rankTokenizedCandidates(characterSearchTokens(query.input.query), current.map(item => ({ item, tokens: characterSearchTokens(text(item)) })), 100).filter(r => r.score > 0).map(r => recordKey(r.item));
        candidates = reciprocalRankFusion([words, chars], 100).map(key => map.get(key)!);
      } else if (query.method === "timeline") {
        const q = query.input;
        candidates = current.filter(r => { const t = when(r); return t && t.day >= q.fromDay && t.day <= q.toDay
          && (!q.participants.length || r.kind === "event" && q.participants.every(id => r.data.participants.some(p => p.id === id))); })
          .sort((a, b) => when(a)!.day - when(b)!.day || (when(a)!.clock ?? "").localeCompare(when(b)!.clock ?? "") || recordKey(a).localeCompare(recordKey(b)));
      } else if (query.method === "continuity") {
        const thread = query.input.thread;
        candidates = current.filter(r => r.kind === "thread" && (!thread || recordKey(r) === recordKey(thread)));
        // A thread's title/state may itself reveal unacquired facts: character access still requires a grant.
      } else if (query.method === "coverage") {
        const q = query.input;
        if (byRef(q.source)) candidates = current.filter(r => r.kind === "coverage" && recordKey(r.data.source) === recordKey(q.source) && r.data.direction === q.direction);
      } else if (query.method === "related") {
        const q = query.input, seed = byRef(q.ref);
        if (seed) {
          const edges: RecordRef[] = [];
          if (q.relation === "evidence" && "evidence" in seed.data) edges.push(...seed.data.evidence);
          if (q.relation === "participants" && seed.kind === "event") edges.push(...seed.data.participants);
          if (q.relation === "versions" && seed.kind === "work") for (const r of current) if (r.kind === "work-version" && r.data.work.id === seed.id) edges.push(r);
          if (q.relation === "acquisitions") for (const r of current) if (r.kind === "acquisition" && recordKey(r.data.object) === recordKey(seed)) edges.push(r);
          if (q.relation === "revisions") for (const r of current) if (r.kind === "revision" && r.data.before.id === seed.id) edges.push(r);
          if (q.relation === "threads") for (const r of current) if (r.kind === "thread" && r.data.anchors.some(a => recordKey(a) === recordKey(seed))) edges.push(r);
          candidates = [...new Map(edges.map(ref => [recordKey(ref), byRef(ref)])).values()].filter((r): r is CoreRecord => !!r);
        }
      }
      const q = query.input as { limit: number; cursor: string | null }, key = coreFingerprint({ ...query, input: { ...query.input, cursor: null } });
      const sign = (body: string) => createHmac("sha256", this.cursorKey).update(body).digest("base64url");
      let offset = 0;
      if (q.cursor) {
        const [body, signature, extra] = q.cursor.split(".");
        if (!body || !signature || extra || signature.length !== sign(body).length || !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(body)))) throw Error("CRP_CURSOR_INVALID");
        const cursor = JSON.parse(Buffer.from(body, "base64url").toString());
        if (cursor.context !== contextFingerprint || cursor.query !== key || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.expires < Date.now()) throw Error("CRP_CURSOR_INVALID"); offset = cursor.offset;
      }
      result.records = candidates.slice(offset, offset + q.limit); result.status = result.records.length ? "ok" : "unknown";
      const next = offset + result.records.length;
      if (next < candidates.length) { const body = Buffer.from(JSON.stringify({ context: contextFingerprint, query: key, offset: next, expires: Date.now() + 600000 })).toString("base64url"); result.nextCursor = `${body}.${sign(body)}`; }
    }
    let releasedBytes = 0;
    result.records = result.records.filter(r => { const size = Buffer.byteLength(JSON.stringify(r));
      if (releasedBytes + size > 16000) { result.receipt.gaps.push("Record payload omitted by response budget; use bounded read for details."); return false; }
      releasedBytes += size; return true;
    });
    // Source verification checks are limited to records actually released; no denied-scope path enumeration.
    const sourceRefs = (record: CoreRecord) => {
      const sources: Array<{ path: string; sha256: string }> = [...record.provenance];
      const addSource = (r: CoreRecord | undefined) => { if (r?.kind === "source") sources.push({ path: r.data.path, sha256: r.data.sha256 }); };
      addSource(record);
      if (record.kind === "evidence" || record.kind === "work-version") addSource(map.get(recordKey(record.data.source)));
      if (record.kind === "work-version") for (const component of record.data.components ?? []) addSource(map.get(recordKey(component.source)));
      if ("evidence" in record.data) for (const ref of record.data.evidence) { const ev = map.get(recordKey(ref)); if (ev?.kind === "evidence") addSource(map.get(recordKey(ev.data.source))); }
      return sources;
    };
    const refs = result.records.flatMap(sourceRefs);
    if (query.method !== "explain") result.receipt.sourceChecks = [...new Map(refs.map(r => [r.path, { path: r.path, sha256: r.sha256, verified: true }])).values()];
    if (this.store.read(undefined, signal).id !== generation.id || !this.authorize(context)) throw Error("CRP_CONTEXT_CHANGED");
    assertNotAborted(signal);
    if (this.receipts.size >= 512) this.receipts.delete(this.receipts.keys().next().value!);
    this.receipts.set(result.receipt.id, structuredClone(result.receipt));
    return structuredClone(result);
  }
}
