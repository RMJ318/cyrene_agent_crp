import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { BridgeDomain, LocalMemoryInput, LocalMemoryRecord } from "../../shared/memory-bridge";
import { atomicJson, fail, hash, readBounded, safePath } from "./safety";

export interface PrivateCodec { available(): boolean; encrypt(text: string): string; decrypt(cipher: string): string }
export class LocalMemoryStore {
  private db: DatabaseSync;
  constructor(readonly file: string, readonly domain: "writer" | "reality0", private codec: PrivateCodec) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_migrations VALUES(1);
      CREATE TABLE IF NOT EXISTS metadata(domain TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS record_versions(record_id TEXT NOT NULL, revision INTEGER NOT NULL, sensitive INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(record_id,revision), FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS consents(record_id TEXT NOT NULL, revision INTEGER NOT NULL, session_id TEXT NOT NULL, run_id TEXT, expires INTEGER NOT NULL, destination TEXT NOT NULL,
        PRIMARY KEY(record_id,revision,session_id), FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE);`);
    const domains = this.db.prepare("SELECT domain FROM metadata").all();
    if (!domains.length) this.db.prepare("INSERT INTO metadata VALUES(?)").run(domain);
    else if (domains.length !== 1 || domains[0].domain !== domain) { this.db.close(); fail("DOMAIN_MISMATCH"); }
    if (this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v !== 1) { this.db.close(); fail("DATABASE_VERSION"); }
  }
  close(): void { this.db.close(); }
  private tx<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private encode(input: LocalMemoryInput): string {
    if (typeof input.content !== "string" || !input.content.trim() || input.content.length > 12000
      || !Array.isArray(input.participants) || input.participants.some(p => typeof p !== "string" || p.length > 100)
      || typeof input.sensitive !== "boolean" || input.eventTime !== undefined && typeof input.eventTime !== "string") fail("INVALID_RECORD");
    const text = JSON.stringify(input);
    if (input.sensitive && !this.codec.available()) fail("ENCRYPTION_UNAVAILABLE");
    return input.sensitive ? this.codec.encrypt(text) : text;
  }
  private decode(row: any): LocalMemoryRecord {
    if (row.sensitive && !this.codec.available()) fail("ENCRYPTION_UNAVAILABLE");
    return { ...JSON.parse(row.sensitive ? this.codec.decrypt(row.payload) : row.payload), id: row.id,
      domain: this.domain, revision: row.revision, deleted: !!row.deleted, createdAt: row.created_at };
  }
  list(includeDeleted = false): LocalMemoryRecord[] {
    return this.db.prepare(`SELECT r.*,v.sensitive,v.payload FROM records r JOIN record_versions v ON r.id=v.record_id AND r.revision=v.revision ${includeDeleted ? "" : "WHERE r.deleted=0"} ORDER BY r.created_at,r.id`).all().map(r => this.decode(r));
  }
  create(input: LocalMemoryInput): LocalMemoryRecord {
    const payload = this.encode(input), id = randomUUID();
    return this.tx(() => {
      this.db.prepare("INSERT INTO records VALUES(?,1,0,?)").run(id, new Date().toISOString());
      this.db.prepare("INSERT INTO record_versions VALUES(?,1,?,?)").run(id, Number(input.sensitive), payload);
      return this.list().find(r => r.id === id)!;
    });
  }
  update(id: string, expectedRevision: number, input: LocalMemoryInput): LocalMemoryRecord {
    const payload = this.encode(input);
    return this.tx(() => {
      const changes = this.db.prepare("UPDATE records SET revision=revision+1,deleted=0 WHERE id=? AND revision=?").run(id, expectedRevision).changes;
      if (changes !== 1) fail("REVISION_CONFLICT");
      this.db.prepare("INSERT INTO record_versions VALUES(?,?,?,?)").run(id, expectedRevision + 1, Number(input.sensitive), payload);
      this.db.prepare("DELETE FROM consents WHERE record_id=?").run(id);
      return this.list().find(r => r.id === id)!;
    });
  }
  versions(id: string): LocalMemoryRecord[] {
    return this.db.prepare("SELECT r.id,r.deleted,r.created_at,v.revision,v.sensitive,v.payload FROM records r JOIN record_versions v ON r.id=v.record_id WHERE r.id=? ORDER BY v.revision DESC").all(id).map(r => this.decode(r));
  }
  remove(id: string, revision: number, permanent: boolean): void {
    this.tx(() => {
      const row = this.db.prepare("SELECT revision FROM records WHERE id=?").get(id);
      if (row?.revision !== revision) fail("REVISION_CONFLICT");
      if (permanent) this.db.prepare("DELETE FROM records WHERE id=?").run(id);
      else this.db.prepare("UPDATE records SET deleted=1 WHERE id=?").run(id);
      this.db.prepare("DELETE FROM consents WHERE record_id=?").run(id);
    });
  }
  grant(id: string, revision: number, sessionId: string, destination = ""): void {
    const row = this.db.prepare("SELECT revision,deleted FROM records WHERE id=?").get(id);
    if (row?.revision !== revision || row.deleted) fail("REVISION_CONFLICT");
    this.db.prepare("INSERT OR REPLACE INTO consents VALUES(?,?,?,NULL,?,?)").run(id, revision, sessionId, Date.now() + 10 * 60 * 1000, destination);
  }
  revoke(id: string): void { this.db.prepare("DELETE FROM consents WHERE record_id=?").run(id); }
  forModel(sessionId: string, runId: string, destination = ""): LocalMemoryRecord[] {
    if (!sessionId || !runId) fail("RUN_REQUIRED");
    // Even ordinary records need one-run release consent: no private text leaves by default.
    const rows = this.db.prepare(`SELECT r.*,v.sensitive,v.payload,c.run_id FROM records r
      JOIN record_versions v ON r.id=v.record_id AND r.revision=v.revision
      JOIN consents c ON c.record_id=r.id AND c.revision=r.revision
      WHERE r.deleted=0 AND c.session_id=? AND c.expires>? AND c.destination=? AND (c.run_id IS NULL OR c.run_id=?)`).all(sessionId, Date.now(), destination, runId);
    return rows.map(row => {
      this.db.prepare("UPDATE consents SET run_id=? WHERE record_id=? AND revision=? AND session_id=? AND run_id IS NULL").run(runId, row.id!, row.revision!, sessionId);
      return this.decode(row);
    });
  }
  /** Recheck in-flight releases without decrypting every private payload again. */
  assertReleases(sessionId: string, runId: string, destination: string, expected: readonly { id: string; revision: number }[]): void {
    const rows = this.db.prepare(`SELECT r.id,r.revision FROM records r JOIN consents c ON c.record_id=r.id AND c.revision=r.revision
      WHERE r.deleted=0 AND c.session_id=? AND c.run_id=? AND c.destination=? AND c.expires>?`).all(sessionId, runId, destination, Date.now());
    const authorized = new Map(rows.map(row => [String(row.id), Number(row.revision)]));
    if (expected.some(record => authorized.get(record.id) !== record.revision)) fail("CONSENT_CHANGED");
  }
  export(allowSensitive: boolean): LocalMemoryRecord[] {
    const records = this.list(true);
    if (!allowSensitive && records.some(r => r.sensitive)) fail("SENSITIVE_EXPORT_CONFIRMATION_REQUIRED");
    return records;
  }
  backup(root: string): string {
    fs.mkdirSync(root, { recursive: true });
    const id = randomUUID(), dir = path.join(root, id);
    fs.mkdirSync(dir);
    const target = path.join(dir, "memory.sqlite");
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    atomicJson(path.join(dir, "backup.json"), { version: 1, domain: this.domain, sha256: hash(readBounded(target, 64 * 1024 * 1024)) });
    return id;
  }
  static restore(backupRoot: string, backupId: string, outputRoot: string, domain: Exclude<BridgeDomain, "rp">, codec: PrivateCodec): LocalMemoryStore {
    if (!/^[a-f0-9-]{36}$/.test(backupId)) fail("INVALID_BACKUP");
    const directory = safePath(backupRoot, backupId);
    const manifest = JSON.parse(readBounded(safePath(directory, "backup.json")).toString());
    const bytes = readBounded(safePath(directory, "memory.sqlite"), 64 * 1024 * 1024);
    if (manifest.version !== 1 || manifest.domain !== domain || manifest.sha256 !== hash(bytes)) fail("BACKUP_CHECKSUM");
    fs.mkdirSync(outputRoot, { recursive: true });
    const target = path.join(outputRoot, `${randomUUID()}.sqlite`);
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    const probe = new DatabaseSync(target, { readOnly: true });
    try {
      if (probe.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
        || probe.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v !== 1
        || probe.prepare("SELECT domain FROM metadata").get()?.domain !== domain) fail("INVALID_BACKUP");
    } finally { probe.close(); }
    const store = new LocalMemoryStore(target, domain, codec);
    // Restored data requires fresh explicit consent; caller previews and elects to use this new file.
    store.db.exec("DELETE FROM consents");
    return store;
  }
}
