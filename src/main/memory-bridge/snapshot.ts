import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BridgeMemory, BridgeResult, BridgeScope, BridgeSource } from "../../shared/memory-bridge";
import { rankTextCandidates } from "../rag/text-ranking";
import type { CrpAlias, CrpDocument } from "../crp-core/contracts";
import { assertNotAborted, atomicJson, fail, hash, parsePythonJson, pythonJson, readBounded, safePath, validateScope, visible, within } from "./safety";

type Row = Record<string, any>;
interface Manifest { version: 1; snapshotId: string; files: Record<string, string>; createdAt: string }
const LIB = "archive/rp/library/";
const ROOTS = ["archive/rp/library", "archive/rp/raw", "archive/rp/inbox", "archive/rp/continuity", "manuscripts", "canon"];
const CHANNELS = new Set(["AUTHORED", "CO_FORMULATED", "READ_FULL", "READ_FULL_AND_HEARD_RECITAL", "HEARD_RECITAL", "HEARD_RECITAL_AND_VIEWED_TEXT", "HEARD_DISCLOSURE", "HEARD_REPORT", "READ_SOURCE_TABLE", "WITNESSED", "DIRECT_EXPERIENCE", "PERSONALLY_EXPERIENCED"]);

/** Copies bytes only into an owned staging directory; never executes source scripts or writes source files. */
export async function importSnapshot(source: string, outputRoot: string, forbiddenRoots: string[], signal?: AbortSignal): Promise<CrpSnapshot> {
  const realSource = fs.realpathSync(source);
  if (fs.lstatSync(source).isSymbolicLink()) fail("UNSAFE_PATH");
  let ancestor = path.resolve(outputRoot);
  const suffix: string[] = [];
  while (!fs.existsSync(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  const intendedOutput = path.join(fs.realpathSync(ancestor), ...suffix);
  if (within(realSource, intendedOutput) || within(intendedOutput, realSource)
    || forbiddenRoots.some(r => within(r, realSource) || within(realSource, r))) fail("ROOT_OVERLAP");
  if (fs.existsSync(path.join(realSource, ".crp-runtime", "pending.json"))) fail("PENDING_TRANSACTION");
  fs.mkdirSync(outputRoot, { recursive: true });
  const realOutput = fs.realpathSync(outputRoot);
  if (realOutput !== intendedOutput) fail("OUTPUT_ROOT_CHANGED");
  const id = randomUUID();
  const target = path.join(realOutput, id);
  fs.mkdirSync(target);
  const files: Record<string, string> = {};
  let size = 0;
  try {
    const visit = async (rel: string): Promise<void> => {
      assertNotAborted(signal);
      const full = safePath(realSource, rel);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(full).sort()) await visit(`${rel}/${name}`);
      } else {
        if (!/\.(json|md)$/i.test(rel)) return;
        const bytes = readBounded(full);
        size += bytes.length;
        if (Object.keys(files).length >= 10000 || size > 512 * 1024 * 1024) fail("SNAPSHOT_LIMIT");
        const dest = path.join(target, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, bytes, { flag: "wx", mode: 0o600 });
        files[rel] = hash(bytes);
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    for (const rel of ROOTS) if (fs.existsSync(path.join(realSource, rel))) await visit(rel);
    if (fs.existsSync(path.join(realSource, ".crp-runtime", "pending.json"))) fail("SOURCE_CHANGED");
    // Verify source did not change during the copy. The snapshot itself pins every byte.
    for (const [rel, sha] of Object.entries(files)) {
      assertNotAborted(signal);
      if (hash(readBounded(safePath(realSource, rel))) !== sha) fail("SOURCE_CHANGED");
    }
    const manifest: Manifest = { version: 1, snapshotId: id, files, createdAt: new Date().toISOString() };
    atomicJson(path.join(target, "snapshot.json"), manifest);
    const snapshot = new CrpSnapshot(target);
    snapshot.validate();
    assertNotAborted(signal);
    return snapshot;
  } catch (error) {
    // Only remove the exact staging directory we created inside the verified output root.
    if (within(realOutput, target) && path.basename(target) === id) fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export class CrpSnapshot {
  readonly manifest: Manifest;
  private manifestDigest: string;
  private metadataFiles = new Set<string>();
  private data: Record<string, Record<string, Row>> = {};
  private evidence: Record<string, Row> = {};
  private audits: Record<string, Row> = {};
  private passages: Record<string, Row[]> = {};
  private versions: Row[] = [];
  private workEvidence: Row = {};
  private verificationCache?: Map<string, Buffer>;
  private sourceTextCache?: Map<string, { text: string; chars?: string[]; lines?: string[] }>;
  private withVerification<T>(operation: () => T): T {
    const previous = this.verificationCache;
    const previousText = this.sourceTextCache;
    this.verificationCache ??= new Map();
    this.sourceTextCache ??= new Map();
    try { return operation(); } finally { this.verificationCache = previous; this.sourceTextCache = previousText; }
  }
  constructor(readonly root: string) {
    const bytes = readBounded(safePath(root, "snapshot.json"), 4 * 1024 * 1024);
    this.manifestDigest = hash(bytes);
    this.manifest = JSON.parse(bytes.toString());
    if (this.manifest.version !== 1 || !this.manifest.files || typeof this.manifest.snapshotId !== "string") fail("SNAPSHOT_VERSION");
  }
  continuityFiles(): string[] { return Object.keys(this.manifest.files).filter(p => p.startsWith("archive/rp/continuity/") && p.endsWith(".md")).sort(); }
  realities(): string[] {
    return [...new Set([...Object.values(this.data).flatMap(records => Object.values(records).filter(r => ["rp", "ooc"].includes(r._namespace)).map(r => String(r.reality_id))), ...this.versions.map(v => String(v.reality))])]
      .filter(id => /^(0|[1-9]\d*)$/.test(id)).sort((a, b) => Number(a) - Number(b));
  }
  continuitySource(rel: string): BridgeSource {
    if (!this.continuityFiles().includes(rel)) fail("CONTINUITY_PATH");
    return { path: rel, sha256: hash(this.bytes(rel)) };
  }
  private bytes(rel: string): Buffer {
    const cached = this.verificationCache?.get(rel);
    if (cached) return cached;
    const expected = this.manifest.files[rel];
    if (!expected) fail("UNREGISTERED_SOURCE");
    const bytes = readBounded(safePath(this.root, rel));
    if (hash(bytes) !== expected) fail("SOURCE_CHANGED");
    this.verificationCache?.set(rel, bytes);
    return bytes;
  }
  private json(rel: string): Row { this.metadataFiles.add(rel); return parsePythonJson(this.bytes(rel).toString("utf8")); }
  /** Persistent caches may not hide changed authorization metadata or source bytes during async retrieval. */
  verifyProjection(sources: readonly BridgeSource[] = [], signal?: AbortSignal): void {
    this.withVerification(() => {
      if (hash(readBounded(safePath(this.root, "snapshot.json"), 4 * 1024 * 1024)) !== this.manifestDigest) fail("SOURCE_CHANGED");
      for (const relative of this.metadataFiles) { assertNotAborted(signal); this.bytes(relative); }
      for (const source of sources) { assertNotAborted(signal); if (hash(this.bytes(source.path)) !== source.sha256) fail("SOURCE_CHANGED"); }
    });
  }
  validate(): void {
    this.withVerification(() => {
    for (const rel of Object.keys(this.manifest.files)) this.bytes(rel);
    const registry = this.json(LIB + "registry.json");
    if (!/^2\.[01]$/.test(String(registry.schema_version))) fail("CRP_SCHEMA");
    this.data = {};
    this.workEvidence = registry.work_evidence ?? {};
    this.versions = this.manifest.files["manuscripts/catalog.json"] ? this.json("manuscripts/catalog.json").versions ?? [] : [];
    const shards = registry.namespace_refs
      ? Object.entries(registry.namespace_refs).map(([namespace, rel]) => ({ namespace, data: this.json(String(rel)) }))
      : [{ namespace: "rp", data: registry }];
    for (const { namespace, data } of shards) {
      if (!["rp", "ooc", "unknown"].includes(namespace)) fail("CRP_NAMESPACE");
      for (const [kind, records] of Object.entries(data)) {
        if (!records || typeof records !== "object" || Array.isArray(records)) continue;
        for (const [id, record] of Object.entries(records as Row)) {
          if (!record || typeof record !== "object" || record.id !== id) continue;
          if (this.data[kind]?.[id]) fail("DUPLICATE_ID");
          (this.data[kind] ??= {})[id] = { ...record, _namespace: namespace };
        }
      }
    }
    this.evidence = this.json(LIB + "evidence/registry.json");
    this.audits = this.json(LIB + "audit/knowledge-results.json").entries ?? {};
    this.passages = this.manifest.files[LIB + "evidence/passages.json"] ? this.json(LIB + "evidence/passages.json") as any : {};
    for (const [id, ev] of Object.entries(this.evidence)) {
      if (ev.evidence_id !== id) fail("EVIDENCE_ID");
      this.verifyEvidence(ev);
    }
    });
  }
  private manuscript(version: Row, scope: BridgeScope, full = false, offset = 0, pageSize = 2400): BridgeMemory | null {
    if (scope.domain !== "rp" || String(version.reality) !== scope.realityId || (version.branch_id ?? null) !== scope.branchId) return null;
    const meta = this.workEvidence[version.version_id];
    if (!meta || !visible(meta.version_time, scope.asOf)) return null;
    const acquisition = Object.values(this.data.acquisitions ?? {}).find(a => a.character_id === scope.characterId
      && a.target_type === "work_version" && a.target_id === version.version_id && a._namespace === "rp"
      && a.ic_status === "in_character" && String(a.reality_id) === scope.realityId
      && (a.branch_id ?? null) === scope.branchId && visible(a.acquired_at, scope.asOf) && this.reviewed(a)
      && ["AUTHORED", "CO_FORMULATED", "READ_FULL", "READ_FULL_AND_HEARD_RECITAL"].includes(a.acquisition_channel));
    if (scope.audience === "character-knowledge" && !acquisition) return null;
    if (scope.audience === "character-knowledge") {
      if (version.logical_namespace && version.logical_namespace !== "rp" || meta.logical_namespace && meta.logical_namespace !== "rp") return null;
      if (!acquisition!.evidence_ids?.length || acquisition!.evidence_ids.some((id: string) => {
        const ev = this.evidence[id], spans = this.passages[id];
        return !ev || ev.legacy_class === "O" || ev.logical_namespace === "ooc" || String(ev.reality_id) !== scope.realityId
          || !visible(ev.event_time, scope.asOf) || !spans?.length || spans.some(span => span.namespace !== "rp");
      })) return null;
    }
    const refs: BridgeSource[] = [];
    const bodies: string[] = [];
    for (const component of version.components ?? []) {
      const bytes = this.bytes(component.path);
      if (hash(bytes) !== component.archived_text_sha256) fail("MANUSCRIPT_HASH");
      // A mixed OOC work needs passage-level review; do not strip parentheses and call the rest safe.
      if (scope.audience === "character-knowledge" && /\booc\b/i.test(bytes.toString())) return null;
      refs.push({ path: component.path, sha256: component.archived_text_sha256 }); bodies.push(bytes.toString());
    }
    if (!refs.length) return null;
    const body = full ? bodies.join("\n") : String(version.title ?? version.version_id);
    const text = Array.from(body).slice(offset, offset + (full ? pageSize : 1200)).join("");
    const review = acquisition ? this.reviewed(acquisition) : null;
    return { memoryId: `work_version:${version.version_id}`, domain: "rp", realityId: scope.realityId, branchId: scope.branchId,
      participants: [], eventTime: meta.version_time ?? null, acquiredAt: acquisition?.acquired_at ?? null,
      acquisitionChannel: acquisition?.acquisition_channel ?? null, source: refs, evidenceType: "VERSIONED_MANUSCRIPT",
      sourceVerification: "COMPONENT_SHA256_VERIFIED", occurrenceVerdict: review?.occurrence ?? "NOT_REVIEWED",
      fullAuditStatus: review?.status ?? "NOT_REVIEWED", epistemicStatus: String(version.text_completeness ?? "UNKNOWN"),
      content: text, contentKind: full ? "verbatim" : "summary", truncated: Array.from(body).length > offset + Array.from(text).length,
      ...(full ? { contentOffset: offset, nextOffset: offset + Array.from(text).length } : {}),
      access: { audience: scope.audience, characterId: scope.characterId } };
  }
  private verifyEvidence(ev: Row): { ref: BridgeSource; excerpt: string } {
    const bytes = this.bytes(ev.source_path);
    // bytes() has verified the actual bytes against this manifest in this operation.
    // Compare the evidence to that same digest instead of hashing a whole source twice per excerpt.
    if (this.manifest.files[ev.source_path] !== ev.source_version || ev.source_id !== `src-${ev.source_version}`) fail("EVIDENCE_SOURCE_HASH");
    let decoded = this.sourceTextCache?.get(ev.source_path);
    if (!decoded) {
      decoded = { text: bytes.toString("utf8") };
      this.sourceTextCache?.set(ev.source_path, decoded);
    }
    let excerpt: string;
    if (ev.char_start != null || ev.char_end != null) {
      const chars = decoded.chars ??= Array.from(decoded.text); // Python Unicode code points.
      if (!Number.isInteger(ev.char_start) || !Number.isInteger(ev.char_end) || ev.char_start < 0 || ev.char_end <= ev.char_start || ev.char_end > chars.length) fail("EVIDENCE_COORDINATES");
      excerpt = chars.slice(ev.char_start, ev.char_end).join("");
      if (chars.slice(0, ev.char_start).filter(c => c === "\n").length + 1 !== ev.line_start
        || chars.slice(0, ev.char_end - 1).filter(c => c === "\n").length + 1 !== ev.line_end) fail("EVIDENCE_COORDINATES");
    } else {
      const lines = decoded.lines ??= decoded.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      if (!Number.isInteger(ev.line_start) || !Number.isInteger(ev.line_end) || ev.line_start < 1 || ev.line_end < ev.line_start || ev.line_end > lines.length) fail("EVIDENCE_COORDINATES");
      excerpt = lines.slice(ev.line_start - 1, ev.line_end).join("");
    }
    if (hash(excerpt) !== ev.excerpt_sha256) fail("EXCERPT_HASH");
    return { ref: { path: ev.source_path, sha256: ev.source_version, evidenceId: ev.evidence_id, lineStart: ev.line_start, lineEnd: ev.line_end, excerptSha256: ev.excerpt_sha256 }, excerpt };
  }
  private reviewed(a: Row): { occurrence: string; status: string } | null {
    const row = this.audits[a.id];
    const { _namespace, ...original } = a;
    const evidence = Object.fromEntries((a.evidence_ids ?? []).map((id: string) => [id, this.evidence[id]]));
    if (!row || row.reviewed_fingerprint !== hash(pythonJson({ entry: original, evidence }))) return null;
    const occurrence = row.occurrence_verdict ?? row.status;
    return occurrence === "PASS" ? { occurrence, status: row.status ?? "NOT_REVIEWED" } : null;
  }
  private candidate(kind: string, record: Row, scope: BridgeScope): BridgeMemory | null {
    const namespace = scope.domain === "rp" ? "rp" : scope.domain === "reality0" ? "ooc" : "none";
    if (record._namespace !== namespace || record.logical_namespace && record.logical_namespace !== namespace || String(record.reality_id) !== scope.realityId
      || (record.branch_id ?? null) !== scope.branchId || !visible(record.event_time, scope.asOf)) return null;
    let a: Row | undefined;
    let review: { occurrence: string; status: string } | null = null;
    if (scope.audience === "character-knowledge") {
      a = Object.values(this.data.acquisitions ?? {}).find(acq => acq.character_id === scope.characterId
        && acq.target_type === kind && acq.target_id === record.id && acq.ic_status === "in_character"
        && acq._namespace === "rp" && String(acq.reality_id) === scope.realityId
        && (acq.branch_id ?? null) === scope.branchId && visible(acq.acquired_at, scope.asOf)
        && !!this.reviewed(acq) && CHANNELS.has(acq.acquisition_channel));
      if (!a) return null;
      review = this.reviewed(a);
    }
    const ids = scope.audience === "character-knowledge" ? a!.evidence_ids : record.evidence_ids;
    if (!Array.isArray(ids) || !ids.length) return null;
    const refs: BridgeSource[] = [];
    for (const id of ids) {
      const ev = this.evidence[id];
      if (!ev || String(ev.reality_id) !== scope.realityId || !visible(ev.event_time, scope.asOf)) return null;
      if (scope.audience === "character-knowledge") {
        const spans = this.passages[id];
        // Mixed or unclassified evidence is not a safe character excerpt.
        if (ev.legacy_class === "O" || ev.logical_namespace === "ooc" || !spans?.length || spans.some(s => s.namespace !== "rp")) return null;
      }
      refs.push(this.verifyEvidence(ev).ref);
    }
    let content = [record.title, record.description ?? record.content ?? record.value].filter(v => typeof v === "string").join("\n");
    let limitedScope = false;
    if (a) {
      // An acquisition may authorize only a narrow part of the archival target.
      // Never promote the full target description when that scope is free text or unmodelled.
      if (typeof a.scope !== "string" || !a.scope.trim()) return null;
      if (!["target_claim", "full_target"].includes(a.scope)) {
        content = `知识取得范围（原登记，不能扩展为目标全部内容）：${a.scope}`;
        limitedScope = true;
      }
    }
    if (!content) return null;
    return {
      memoryId: `${kind}:${record.id}`, domain: scope.domain, realityId: scope.realityId, branchId: scope.branchId,
      participants: limitedScope ? [a!.character_id] : record.participants ?? (record.character_id ? [record.character_id] : []), eventTime: limitedScope ? null : record.event_time ?? null,
      acquiredAt: a?.acquired_at ?? null, acquisitionChannel: a?.acquisition_channel ?? null, source: refs,
      evidenceType: scope.domain === "reality0" ? "CRP_OOC_ARCHIVAL_REFERENCE_NOT_PERSONAL_EXPERIENCE" : "CRP_EVIDENCE_LINKED_RECORD", sourceVerification: "SOURCE_AND_EXCERPT_SHA256_VERIFIED",
      occurrenceVerdict: review?.occurrence ?? "NOT_REVIEWED", fullAuditStatus: review?.status ?? "NOT_REVIEWED",
      epistemicStatus: record.epistemic_status ?? record.origin ?? "occurrence_not_claim_truth",
      content: content.slice(0, 1200), contentKind: "summary", truncated: content.length > 1200,
      access: { audience: scope.audience, ...(scope.characterId ? { characterId: scope.characterId } : {}) },
    };
  }
  candidates(scope: BridgeScope, signal?: AbortSignal): BridgeMemory[] {
    return this.withVerification(() => {
    scope = validateScope(scope);
    assertNotAborted(signal);
    const candidates: BridgeMemory[] = [];
    for (const kind of ["events", "relationships", "commitments", "research", "memories", "artifacts", "claims", "profiles", "cases"]) {
      for (const record of Object.values(this.data[kind] ?? {})) {
        assertNotAborted(signal);
        const memory = this.candidate(kind, record, scope);
        if (memory) candidates.push(memory);
      }
    }
    for (const version of this.versions) {
      assertNotAborted(signal);
      const memory = this.manuscript(version, scope);
      if (memory) candidates.push(memory);
    }
    return candidates;
    });
  }
  /** Preserve legacy search; v3 builds only from the existing authorized projection. */
  identityAliases(scope: BridgeScope): CrpAlias[] {
    return this.withVerification(() => {
      const aliases: CrpAlias[] = [];
      for (const record of Object.values(this.data.profiles ?? {})) {
        if ((record.field !== "identity" && record.dimension !== "identity") || typeof record.value !== "string" || typeof record.character_id !== "string") continue;
        if (!this.candidate("profiles", record, validateScope(scope))) continue;
        for (const text of record.value.split(/[／/、]/u).map((s: string) => s.trim()).filter((s: string) => s.length >= 2 && s.length <= 40)) aliases.push({ text, entityId: record.character_id, realityId: scope.realityId });
      }
      return aliases;
    });
  }
  documents(scope: BridgeScope, signal?: AbortSignal): CrpDocument[] {
    return this.withVerification(() => {
      const documents: CrpDocument[] = [];
      const add = (memory: BridgeMemory, suffix: string) => {
        const chars = Array.from(memory.content);
        for (let start = 0; start < chars.length; start += 880) {
          assertNotAborted(signal);
          if (documents.length >= 20_000) fail("RETRIEVAL_LIMIT");
          const text = chars.slice(start, start + 1000).join("");
          const offset = (memory.contentOffset ?? 0) + start;
          documents.push({ id: `${scope.domain}:${scope.realityId}:${scope.branchId ?? ""}:${memory.memoryId}:${suffix}:${offset}`,
            text, memory: { ...memory, content: text, truncated: memory.truncated || start + 1000 < chars.length,
              ...(memory.contentKind === "verbatim" ? { contentOffset: offset, nextOffset: offset + Array.from(text).length } : {}) } });
          if (start + 1000 >= chars.length) break;
        }
      };
      for (const memory of this.candidates(scope, signal)) {
        add(memory, "summary");
        // Character claims authorize summaries, not entire source messages. Full work versions
        // have a separate acquisition check in readMemory/manuscript and may be expanded.
        if (scope.audience !== "archive-reference" && !memory.memoryId.startsWith("work_version:")) continue;
        // Materialize an authorized source once. Repeated paged reads would repeatedly
        // scan the entire source and become quadratic for long manuscripts.
        assertNotAborted(signal);
        const detail = this.readMemory(scope, memory.memoryId, 0, signal, 20_000_000).memories[0];
        if (!detail || detail.contentKind !== "verbatim") continue;
        if (detail.truncated) fail("RETRIEVAL_LIMIT");
        add(detail, "source");
      }
      return documents;
    });
  }
  search(scope: BridgeScope, query: string, signal?: AbortSignal): BridgeResult {
    if (typeof query !== "string" || query.length > 2000) fail("INVALID_QUERY");
    const candidates = this.candidates(scope, signal);
    const hits = query.trim() ? rankTextCandidates(query, candidates.map(item => ({ item, text: item.content })), 5).filter(r => r.score > 0).map(r => r.item) : [];
    return { status: hits.length ? "ok" : "unknown", memories: hits, gaps: hits.length ? ["Source fidelity is verified; semantic and later-corpus audit statuses remain separate."] : ["No authorized evidence matches this scope; unindexed continuity and manuscripts are not inferred."], snapshotId: this.manifest.snapshotId };
  }
  get(scope: BridgeScope, id: string, offset = 0, signal?: AbortSignal): BridgeResult {
    return this.withVerification(() => this.readMemory(scope, id, offset, signal));
  }
  private readMemory(scope: BridgeScope, id: string, offset: number, signal?: AbortSignal, pageSize = 2400): BridgeResult {
    scope = validateScope(scope);
    assertNotAborted(signal);
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) fail("INVALID_OFFSET");
    const at = id.indexOf(":");
    const kind = id.slice(0, at), key = id.slice(at + 1);
    if (kind === "work_version") {
      const version = this.versions.find(v => v.version_id === key);
      const memory = version && this.manuscript(version, scope, true, offset, pageSize);
      return { status: memory ? "ok" : "unknown", memories: memory ? [memory] : [], gaps: memory ? [] : ["Unknown version or no audited full-text acquisition."], snapshotId: this.manifest.snapshotId };
    }
    const record = this.data[kind]?.[key];
    const memory = record && this.candidate(kind, record, scope);
    if (!memory) return { status: "unknown", memories: [], gaps: ["Unknown or unauthorized memory."], snapshotId: this.manifest.snapshotId };
    // Raw mixed messages remain archive-only: knowledge of a target does not grant the entire source message.
    if (scope.audience === "archive-reference") {
      const text = memory.source.map(ref => this.verifyEvidence(this.evidence[ref.evidenceId!]).excerpt).join("\n");
      memory.content = Array.from(text).slice(offset, offset + pageSize).join("");
      memory.contentKind = "verbatim";
      memory.contentOffset = offset;
      memory.nextOffset = offset + Array.from(memory.content).length;
      memory.truncated = Array.from(text).length > offset + pageSize;
    }
    return { status: "ok", memories: [memory], gaps: scope.audience === "character-knowledge" ? ["Only the acquired target summary is released; source-message text is archive-only."] : [], snapshotId: this.manifest.snapshotId };
  }
}
