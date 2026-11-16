import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safePath } from "../memory-bridge/safety";

/** All units are integer microdollars; pending reservations survive crashes and remain charged. */
export class CrpBudgetLedger {
  private db: DatabaseSync;
  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    if (fs.realpathSync(directory).toLowerCase() !== path.resolve(directory).toLowerCase()) throw Error("CRP_BUDGET_UNSAFE_ROOT");
    for (const name of ["budget-v1.sqlite", "budget-v1.sqlite-journal", "budget-v1.sqlite-wal", "budget-v1.sqlite-shm"])
      if (fs.existsSync(path.join(directory, name))) safePath(directory, name);
    this.db = new DatabaseSync(path.join(directory, "budget-v1.sqlite"));
    try {
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) throw Error("CRP_BUDGET_VERSION");
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,account TEXT NOT NULL,reserved INTEGER NOT NULL,settled INTEGER);
        PRAGMA user_version=1;`);
    } catch (e) { this.db.close(); throw e; }
  }
  close(): void { this.db.close(); }
  reserve(account: string, ceilingUsd: number, maxCostUsd: number): string {
    const ceiling = Math.floor(ceilingUsd * 1e6), amount = Math.ceil(maxCostUsd * 1e6);
    if (!account || !Number.isSafeInteger(ceiling) || !Number.isSafeInteger(amount) || ceiling < 0 || amount <= 0) throw Error("BRIDGE_INVALID_MODEL_BUDGET");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used = Number(this.db.prepare("SELECT COALESCE(SUM(COALESCE(settled,reserved)),0) AS used FROM reservations WHERE account=?").get(account)?.used);
      if (used + amount > ceiling) throw Error("BRIDGE_MODEL_BUDGET_EXCEEDED");
      const id = randomUUID(); this.db.prepare("INSERT INTO reservations VALUES(?,?,?,NULL)").run(id, account, amount);
      this.db.exec("COMMIT"); return id;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  settle(id: string, costUsd: number): void {
    const cost = Math.ceil(costUsd * 1e6);
    if (!Number.isSafeInteger(cost) || cost < 0) throw Error("BRIDGE_MODEL_COST_INVALID");
    const result = this.db.prepare("UPDATE reservations SET settled=? WHERE id=? AND settled IS NULL AND reserved>=?").run(cost, id, cost);
    if (result.changes !== 1) throw Error("BRIDGE_MODEL_COST_INVALID");
  }
  usedUsd(account: string): number {
    return Number(this.db.prepare("SELECT COALESCE(SUM(COALESCE(settled,reserved)),0) AS used FROM reservations WHERE account=?").get(account)?.used) / 1e6;
  }
}
