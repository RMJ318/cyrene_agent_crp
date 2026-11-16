import fs from "node:fs";
import path from "node:path";
import type { BridgeScope } from "../../shared/memory-bridge";
import { atomicJson, fail, validateScope, readBounded } from "./safety";

interface Binding { scope: BridgeScope; active: boolean }
interface RecallBinding { realities: string[]; hasRecalled: boolean; resetContext: boolean }
/** Persistent protected-session tombstones survive plugin disable and application restart. */
export class BridgePolicy {
  private sessions: Record<string, Binding> = {};
  private file?: string;
  private broken = false;
  private recalls: Record<string, RecallBinding> = {};
  initialize(root: string): void {
    this.sessions = Object.create(null); this.recalls = Object.create(null); this.broken = false;
    this.file = path.join(root, "bridge-policy.json");
    if (!fs.existsSync(this.file)) return;
    try {
      const value = JSON.parse(readBounded(this.file, 1024 * 1024).toString());
      if (value.version !== 1 || !Array.isArray(value.sessions)) fail("POLICY_VERSION");
      const sessions: Record<string, Binding> = Object.create(null);
      for (const row of value.sessions) {
        if (typeof row.id !== "string" || !/^[\w-]{1,160}$/.test(row.id) || typeof row.active !== "boolean") fail("INVALID_POLICY");
        sessions[row.id] = { scope: validateScope(row.scope), active: row.active };
      }
      this.sessions = sessions;
      for (const row of value.recalls ?? []) {
        if (typeof row.id !== "string" || !/^[\w-]{1,160}$/.test(row.id) || !Array.isArray(row.realities)
          || row.realities.some((id: unknown) => typeof id !== "string" || !/^(0|[1-9]\d*)$/.test(id))) fail("INVALID_RECALL");
        this.recalls[row.id] = { realities: [...new Set<string>(row.realities)], hasRecalled: row.hasRecalled === true, resetContext: row.resetContext === true };
      }
    } catch { this.broken = true; }
  }
  protects(id?: string): boolean { return this.broken || !!(id && Object.hasOwn(this.sessions, id)); }
  blocksLegacy(id?: string): boolean { return this.protects(id) || !!(id && Object.hasOwn(this.recalls, id)); }
  recall(id: string): RecallBinding | undefined { if (this.broken) fail("POLICY_CORRUPT"); return Object.hasOwn(this.recalls, id) ? structuredClone(this.recalls[id]) : undefined; }
  setRecall(id: string, realities: string[]): void {
    if (this.protects(id) || !/^[\w-]{1,160}$/.test(id)) fail("RECALL_DENIED");
    const previous = this.recall(id);
    const next = { ...this.recalls, [id]: { realities: [...realities], hasRecalled: previous?.hasRecalled ?? false, resetContext: previous?.resetContext === true || previous?.hasRecalled === true } };
    this.save(this.sessions, next); this.recalls = next;
  }
  markRecalled(id: string): void {
    const current = this.recall(id);
    if (!current || current.hasRecalled) return;
    const next = { ...this.recalls, [id]: { ...current, hasRecalled: true } };
    this.save(this.sessions, next); this.recalls = next;
  }
  resetRecallContexts(): void {
    const next = structuredClone(this.recalls);
    let changed = false;
    for (const state of Object.values(next)) if (state.hasRecalled && !state.resetContext) { state.resetContext = true; changed = true; }
    if (changed) { this.save(this.sessions, next); this.recalls = next; }
  }
  scope(id: string): BridgeScope {
    if (this.broken || !Object.hasOwn(this.sessions, id) || !this.sessions[id].active) fail("SCOPE_DENIED");
    return structuredClone(this.sessions[id].scope);
  }
  bindNew(id: string, scope: unknown): void {
    if (this.broken || !/^[\w-]{1,160}$/.test(id) || Object.hasOwn(this.sessions, id)) fail("NEW_SESSION_REQUIRED");
    const next = { ...this.sessions, [id]: { scope: validateScope(scope), active: true } };
    this.save(next); this.sessions = next;
  }
  deactivate(id: string): void {
    if (!Object.hasOwn(this.sessions, id)) fail("SCOPE_DENIED");
    const next = { ...this.sessions, [id]: { ...this.sessions[id], active: false } };
    this.save(next); this.sessions = next;
  }
  list(): Array<{ id: string; scope: BridgeScope; active: boolean }> {
    if (this.broken) fail("POLICY_CORRUPT");
    return Object.entries(this.sessions).map(([id, b]) => ({ id, ...structuredClone(b) }));
  }
  private save(sessions: Record<string, Binding>, recalls = this.recalls): void {
    if (!this.file) fail("NOT_INITIALIZED");
    const data = { version: 1, sessions: Object.entries(sessions).map(([id, b]) => ({ id, ...b })), recalls: Object.entries(recalls).map(([id, b]) => ({ id, ...b })) };
    if (Buffer.byteLength(JSON.stringify(data, null, 2)) > 1024 * 1024) fail("POLICY_LIMIT");
    atomicJson(this.file, data);
  }
}
export const bridgePolicy = new BridgePolicy();
export const allowsLegacyMemory = (id?: string): boolean => !bridgePolicy.blocksLegacy(id);
