import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SearchToken } from "../rag/text-ranking";
import { assertNotAborted, hash, safePath } from "../memory-bridge/safety";

export interface IndexedTokens { words: SearchToken[]; characters: SearchToken[] }
export interface CrpIndexCache {
  tokens(key: string): IndexedTokens | undefined;
  vector(key: string): number[] | undefined;
  putTokens(key: string, value: IndexedTokens): void;
  putVector(key: string, value: number[]): void;
  commit(signal?: AbortSignal): void;
  close(): void;
  readonly hits: number;
  readonly misses: number;
}

const validKey = (key: string) => /^[a-f0-9]{64}$/.test(key);
function validTokens(value: unknown): value is SearchToken[] {
  return Array.isArray(value) && value.length <= 100_000 && value.every(t => t && typeof t.word === "string"
    && t.word.length <= 12000 && typeof t.tag === "string" && t.tag.length <= 64
    && typeof t.isStop === "boolean" && typeof t.isNoun === "boolean");
}

/** Disposable acceleration only. Callers must freshly authorize and verify documents before opening it.
 * No memory payload, permission, query text, personal record or source file is stored here.
 * Missing/corrupt/unwritable indexes are allowed to fail; retrieval continues without them.
 */
export class PersistentCrpIndex implements CrpIndexCache {
  private db: DatabaseSync;
  private pending = new Map<string, { kind: string; key: string; payload: string }>();
  hits = 0;
  misses = 0;
  constructor(directory: string, private namespace: string) {
    if (!validKey(namespace) || !fs.statSync(directory).isDirectory()) throw new Error("CRP_INDEX_IDENTITY");
    const file = path.join(directory, "retrieval-v1.sqlite");
    // SQLite may open sidecars too. Do not follow any pre-existing junction/symlink.
    for (const name of ["retrieval-v1.sqlite", "retrieval-v1.sqlite-journal", "retrieval-v1.sqlite-wal", "retrieval-v1.sqlite-shm"])
      if (fs.existsSync(path.join(directory, name))) safePath(directory, name);
    this.db = new DatabaseSync(file);
    try {
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error("CRP_INDEX_VERSION");
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=250; PRAGMA max_page_count=32768;
        CREATE TABLE IF NOT EXISTS namespaces(id TEXT PRIMARY KEY, touched INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS entries(namespace TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
          payload TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(namespace,kind,key));
        PRAGMA user_version=1;`);
    } catch (error) { this.db.close(); throw error; }
  }
  private read(kind: string, key: string): unknown {
    if (!validKey(key)) throw new Error("CRP_INDEX_KEY");
    const row = this.db.prepare("SELECT payload,digest FROM entries WHERE namespace=? AND kind=? AND key=?").get(this.namespace, kind, key);
    if (typeof row?.payload === "string" && row.payload.length <= 8 * 1024 * 1024 && hash(row.payload) === row.digest) {
      try { return JSON.parse(row.payload); } catch { /* rebuilt below */ }
    }
    return undefined;
  }
  tokens(key: string): IndexedTokens | undefined {
    const value = this.read("tokens", key) as IndexedTokens | undefined;
    if (value && validTokens(value.words) && validTokens(value.characters)) { this.hits++; return value; }
    this.misses++; return undefined;
  }
  vector(key: string): number[] | undefined {
    const value = this.read("vector", key);
    if (Array.isArray(value) && value.length > 0 && value.length <= 16384 && value.every(n => typeof n === "number" && Number.isFinite(n)) && value.some(n => n !== 0)) { this.hits++; return value; }
    this.misses++; return undefined;
  }
  private stage(kind: string, key: string, value: unknown): void {
    if (!validKey(key)) throw new Error("CRP_INDEX_KEY");
    const payload = JSON.stringify(value);
    if (payload.length > 8 * 1024 * 1024 || this.pending.size >= 40_000) return;
    this.pending.set(`${kind}:${key}`, { kind, key, payload });
  }
  putTokens(key: string, value: IndexedTokens): void { this.stage("tokens", key, value); }
  putVector(key: string, value: number[]): void { this.stage("vector", key, value); }
  commit(signal?: AbortSignal): void {
    assertNotAborted(signal);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const put = this.db.prepare("INSERT OR REPLACE INTO entries VALUES(?,?,?,?,?)");
      for (const entry of this.pending.values()) {
        assertNotAborted(signal);
        put.run(this.namespace, entry.kind, entry.key, entry.payload, hash(entry.payload));
      }
      this.db.prepare("INSERT OR REPLACE INTO namespaces VALUES(?,?)").run(this.namespace, Date.now());
      // Bounded, whole-namespace eviction; never partially publish a new generation.
      this.db.prepare(`DELETE FROM namespaces WHERE id<>? AND id NOT IN
        (SELECT id FROM namespaces WHERE id<>? ORDER BY touched DESC,id LIMIT 3)`).run(this.namespace, this.namespace);
      this.db.exec("DELETE FROM entries WHERE namespace NOT IN (SELECT id FROM namespaces)");
      assertNotAborted(signal);
      this.db.exec("COMMIT"); this.pending.clear();
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.pending.clear(); this.db.close(); }
}
