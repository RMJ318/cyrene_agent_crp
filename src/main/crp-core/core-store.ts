import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { assertNotAborted, hash, readBounded, safePath, within } from "../memory-bridge/safety";
import { changeFingerprint, coreFingerprint, recordKey, validateChangeSet, validateCoreGraph, type CoreChangeSet, type CoreRecord } from "./core-contracts";

export interface CoreGeneration { id: string; digest: string; records: CoreRecord[]; protectedFiles: Record<string, string> }
const error = (code: string): never => { throw new Error(`CRP_STORE_${code}`); };
/** Explicit separate destination only. Source files are never written; all authority changes use one SQLite transaction. */
export class CrpCoreStore {
  private db: DatabaseSync;
  constructor(directory: string, private sourceRoot: string, private authorizeReview: (change: CoreChangeSet) => boolean) {
    this.sourceRoot = fs.realpathSync(sourceRoot);
    const resolved = path.resolve(directory);
    if (within(this.sourceRoot, resolved) || within(resolved, this.sourceRoot)) error("ROOT_OVERLAP");
    fs.mkdirSync(resolved, { recursive: true });
    if (fs.realpathSync(resolved).toLowerCase() !== resolved.toLowerCase() || fs.lstatSync(resolved).isSymbolicLink()) error("UNSAFE_ROOT");
    for (const name of ["core-v1.sqlite", "core-v1.sqlite-journal", "core-v1.sqlite-wal", "core-v1.sqlite-shm"])
      if (fs.existsSync(path.join(resolved, name))) safePath(resolved, name);
    this.db = new DatabaseSync(path.join(resolved, "core-v1.sqlite"));
    try {
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) error("VERSION");
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS generations(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,generation TEXT NOT NULL);
        PRAGMA user_version=1;`);
    } catch (e) { this.db.close(); throw e; }
  }
  close(): void { this.db.close(); }
  private protect(files: Record<string, string>, signal?: AbortSignal): void {
    for (const [relative, digest] of Object.entries(files)) {
      assertNotAborted(signal);
      if (!/^[a-f0-9]{64}$/.test(digest) || hash(readBounded(safePath(this.sourceRoot, relative))) !== digest) error("SOURCE_CHANGED");
    }
  }
  private protection(records: readonly CoreRecord[], initial: Record<string, string>): Record<string, string> {
    const result = { ...initial };
    for (const r of records) {
      const refs = [...r.provenance, ...(r.kind === "source" ? [{ path: r.data.path, sha256: r.data.sha256 }] : []),
        ...(r.kind === "assessment" && r.data.legacy ? [r.data.legacy] : [])];
      for (const ref of refs) {
        if (result[ref.path] && result[ref.path] !== ref.sha256) error("PROTECTED_PATH_CONFLICT");
        result[ref.path] = ref.sha256;
      }
    }
    return result;
  }
  private verifyRecords(records: readonly CoreRecord[], signal?: AbortSignal): void {
    const map = new Map(records.map(r => [recordKey(r), r]));
    const decoded = new Map<string, string>();
    for (const r of records) {
      assertNotAborted(signal);
      if (r.kind !== "source") continue;
      const bytes = readBounded(safePath(this.sourceRoot, r.data.path));
      if (bytes.length !== r.data.byteLength || hash(bytes) !== r.data.sha256) error("SOURCE_CHANGED");
      if (r.data.encoding === "utf-8") {
        try { decoded.set(recordKey(r), new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
        catch { error("SOURCE_ENCODING"); }
      }
    }
    for (const r of records) {
      assertNotAborted(signal);
      if (r.kind === "work-version" && r.data.components && r.data.joiner !== null) {
        const fragments = r.data.components.map(c => {
          const text = decoded.get(recordKey(c.source)); if (text === undefined) return error("EVIDENCE_SOURCE");
          if (!c.range) return text;
          const parts = c.range.unit === "line" ? text.match(/[^\n]*\n|[^\n]+$/g) ?? [] : Array.from(text);
          if (c.range.end > parts.length) error("SOURCE_RANGE");
          return parts.slice(c.range.unit === "line" ? c.range.start - 1 : c.range.start, c.range.end).join("");
        });
        if (r.data.contentSha256 && hash(fragments.join(r.data.joiner)) !== r.data.contentSha256) error("WORK_CONTENT_HASH");
      }
      if (r.kind !== "evidence") continue;
      const source = map.get(recordKey(r.data.source));
      const text = decoded.get(recordKey(r.data.source));
      if (!source || text === undefined) error("EVIDENCE_SOURCE");
      const range = r.data.range;
      const parts = range.unit === "line" ? text!.match(/[^\n]*\n|[^\n]+$/g) ?? [] : Array.from(text!);
      const start = range.unit === "line" ? range.start - 1 : range.start;
      if (range.end > parts.length || hash(parts.slice(start, range.end).join("")) !== r.data.excerptSha256) error("EVIDENCE_HASH");
    }
  }
  private tx<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  private decode(row: Record<string, unknown> | undefined): CoreGeneration {
    if (!row || typeof row.payload !== "string") return error("NOT_INITIALIZED");
    const payload = JSON.parse(row.payload);
    if (coreFingerprint(payload) !== row.digest) error("GENERATION_CORRUPT");
    return { id: String(row.id), digest: String(row.digest), records: validateCoreGraph(payload.records), protectedFiles: payload.protectedFiles };
  }
  read(id?: string, signal?: AbortSignal): CoreGeneration {
    const row = id ? this.db.prepare("SELECT * FROM generations WHERE id=?").get(id) : this.db.prepare("SELECT * FROM generations ORDER BY seq DESC LIMIT 1").get();
    const generation = this.decode(row); this.protect(generation.protectedFiles, signal); this.verifyRecords(generation.records, signal); return generation;
  }
  /** Called only after the query adapter authorizes the exact record version. Never expose this as a raw file API. */
  content(generation: CoreGeneration, record: CoreRecord): { text: string; kind: "verbatim" | "record-json" } {
    const map = new Map(generation.records.map(r => [recordKey(r), r]));
    if (record.kind === "work-version" && record.data.components) {
      const joiner = record.data.joiner;
      if (typeof joiner !== "string") return error("WORK_JOIN_UNKNOWN");
      const fragments = record.data.components.map(c => {
        const source = map.get(recordKey(c.source)); if (source?.kind !== "source") return error("EVIDENCE_SOURCE");
        const body = this.content(generation, source).text;
        if (!c.range) return body;
        return c.range.unit === "line" ? (body.match(/[^\n]*\n|[^\n]+$/g) ?? []).slice(c.range.start - 1, c.range.end).join("") : Array.from(body).slice(c.range.start, c.range.end).join("");
      });
      const text = fragments.join(joiner);
      if (record.data.contentSha256 && hash(text) !== record.data.contentSha256) error("WORK_CONTENT_HASH");
      return { text, kind: "verbatim" };
    }
    let source: CoreRecord | undefined;
    if (record.kind === "source") source = record;
    else if (record.kind === "evidence" || record.kind === "work-version") source = map.get(recordKey(record.data.source));
    if (source?.kind === "source") {
      if (source.data.encoding !== "utf-8") error("CONTENT_ENCODING");
      const bytes = readBounded(safePath(this.sourceRoot, source.data.path));
      if (hash(bytes) !== source.data.sha256) error("SOURCE_CHANGED");
      let text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (record.kind === "evidence") { const r = record.data.range;
        text = r.unit === "line" ? (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).slice(r.start - 1, r.end).join("") : Array.from(text).slice(r.start, r.end).join("");
        if (hash(text) !== record.data.excerptSha256) error("EVIDENCE_HASH");
      }
      return { text, kind: "verbatim" };
    }
    return { text: JSON.stringify(record.data), kind: "record-json" };
  }
  private append(id: string, records: CoreRecord[], protectedFiles: Record<string, string>): CoreGeneration {
    const payload = { records, protectedFiles }, digest = coreFingerprint(payload);
    this.db.prepare("INSERT INTO generations(id,digest,payload) VALUES(?,?,?)").run(id, digest, JSON.stringify(payload));
    return { id, digest, ...payload };
  }
  /** Initialization is explicit and idempotent, never a side effect of opening a production Bridge. */
  initialize(input: readonly unknown[], files: Record<string, string>, signal?: AbortSignal): CoreGeneration {
    const records = validateCoreGraph(input), protectedFiles = this.protection(records, files);
    this.protect(protectedFiles, signal);
    this.verifyRecords(records, signal);
    return this.tx(() => {
      if (this.db.prepare("SELECT 1 FROM generations LIMIT 1").get()) {
        const first = this.decode(this.db.prepare("SELECT * FROM generations ORDER BY seq LIMIT 1").get());
        if (first.digest !== coreFingerprint({ records, protectedFiles })) error("INITIALIZATION_CONFLICT");
        return this.read(undefined, signal);
      }
      this.protect(protectedFiles, signal); return this.append(randomUUID(), records, protectedFiles);
    });
  }
  publish(input: CoreChangeSet, signal?: AbortSignal): CoreGeneration {
    const change = structuredClone(input);
    assertNotAborted(signal);
    if (change.state !== "reviewed" || !this.authorizeReview(structuredClone(change))) error("REVIEW_DENIED");
    const fingerprint = changeFingerprint(change);
    return this.tx(() => {
      const previous = this.db.prepare("SELECT * FROM changes WHERE id=?").get(change.id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) error("IDEMPOTENCY_CONFLICT");
        return this.read(String(previous.generation), signal);
      }
      const head = this.read(undefined, signal);
      if (head.id !== change.baseSnapshot || head.digest !== change.baseManifestSha256) error("BASE_CHANGED");
      for (const [file, digest] of Object.entries(head.protectedFiles)) if (change.protectedFiles[file] !== digest) error("PROTECTION_INCOMPLETE");
      const records = validateChangeSet(change, head.records);
      const protectedFiles = this.protection(records, change.protectedFiles);
      this.protect(protectedFiles, signal);
      this.verifyRecords(records, signal);
      const next = this.append(randomUUID(), records, protectedFiles);
      this.db.prepare("INSERT INTO changes VALUES(?,?,?)").run(change.id, fingerprint, next.id);
      this.protect(protectedFiles, signal);
      return next;
    });
  }
}
