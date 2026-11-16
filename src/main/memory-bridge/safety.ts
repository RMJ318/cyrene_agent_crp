import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BridgeScope, StoryTime } from "../../shared/memory-bridge";

export function fail(code: string): never { throw new Error(`BRIDGE_${code}`); }
export function hash(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
export function modelConsentTarget(settings: { provider?: string; baseUrl: string; model: string; apiKey?: string }): string {
  // Bind consent to the exact profile destination/account without persisting credentials.
  return hash(JSON.stringify([settings.provider ?? "", settings.baseUrl, settings.model, settings.apiKey ?? ""]));
}
export function assertNotAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException("Cancelled", "AbortError"); }
export function within(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
}
/** Reject all symlink/junction components, including an otherwise internal link. */
export function safePath(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes("\\") || relative.includes(":")) fail("UNSAFE_PATH");
  const parts = relative.split("/");
  if (parts.some(p => !p || p === "." || p === "..")) fail("UNSAFE_PATH");
  let current = path.resolve(root);
  if (fs.lstatSync(current).isSymbolicLink()) fail("UNSAFE_PATH");
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail("UNSAFE_PATH");
  }
  if (!within(fs.realpathSync(root), fs.realpathSync(current))) fail("UNSAFE_PATH");
  return current;
}
export function readBounded(file: string, max = 32 * 1024 * 1024): Buffer {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > max) fail("FILE_LIMIT");
  return fs.readFileSync(file);
}
export function atomicJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(data, null, 2), { flag: "wx", mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
export function validTime(t: unknown): t is StoryTime {
  if (!t || typeof t !== "object") return false;
  const x = t as StoryTime;
  return Number.isInteger(x.day) && x.day >= 0
    && [x.clock, x.not_after].every(v => v === undefined || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v));
}
export function visible(time: unknown, asOf?: StoryTime): boolean {
  if (!validTime(time)) return !asOf;
  if (!asOf) return true;
  if (time.day !== asOf.day) return time.day < asOf.day;
  return !asOf.clock || !!((time.clock ?? time.not_after) && (time.clock ?? time.not_after)! <= asOf.clock);
}
export function validateScope(value: unknown): BridgeScope {
  if (!value || typeof value !== "object") fail("INVALID_SCOPE");
  const s = value as BridgeScope;
  if (!["rp", "writer", "reality0"].includes(s.domain) || !["archive-reference", "character-knowledge"].includes(s.audience)) fail("INVALID_SCOPE");
  if (typeof s.realityId !== "string" || !/^-?\d+$/.test(s.realityId)) fail("INVALID_SCOPE");
  if (s.domain === "writer" && s.realityId !== "-1" || s.domain === "reality0" && s.realityId !== "0") fail("INVALID_SCOPE");
  if (s.domain !== "rp" && s.audience !== "archive-reference") fail("INVALID_SCOPE");
  if (s.domain !== "rp" && s.branchId !== null) fail("INVALID_SCOPE");
  if (s.characterId !== undefined && (typeof s.characterId !== "string" || !/^[\w.-]{1,100}$/.test(s.characterId))) fail("INVALID_SCOPE");
  if (s.domain === "rp" && ["0", "-1"].includes(s.realityId)) fail("INVALID_SCOPE");
  if (s.branchId !== null && (typeof s.branchId !== "string" || !/^[\w.-]{1,100}$/.test(s.branchId))) fail("INVALID_SCOPE");
  if (s.asOf !== undefined && !validTime(s.asOf)) fail("INVALID_SCOPE");
  if (s.audience === "character-knowledge" && (!s.characterId || !s.asOf)) fail("CHARACTER_COORDINATES_REQUIRED");
  return structuredClone(s);
}
class PythonFloat {
  constructor(readonly number: number) {}
  valueOf(): number { return this.number; }
  toString(): string { return String(this.number); }
  toJSON(): number { return this.number; }
  repr(): string {
    if (!Number.isFinite(this.number)) fail("NONFINITE_JSON_NUMBER");
    if (Object.is(this.number, -0)) return "-0.0";
    const n = this.number, abs = Math.abs(n);
    let value = abs !== 0 && (abs >= 1e16 || abs < 1e-4) ? n.toExponential() : String(n);
    if (value.includes("e")) value = value.replace(/e([+-]?)(\d+)$/, (_all, sign, digits) => `e${sign || "+"}${digits.padStart(2, "0")}`);
    else if (!value.includes(".")) value += ".0";
    return value;
  }
}
/** Preserve Python int/float distinction for audit hashes (1 != the encoding of 1.0). Node 24 supplies source text to revivers. */
export function parsePythonJson(text: string): any {
  return JSON.parse(text, ((_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && /[.eE]/.test(context?.source ?? "") ? new PythonFloat(value) : value) as any);
}
/** Python enc(): sort_keys=True, ensure_ascii=False, indent=2, trailing LF. */
export function pythonJson(value: unknown): string {
  function encode(v: any, level: number): string {
    if (v instanceof PythonFloat) return v.repr();
    const indent = "  ".repeat(level), nextIndent = indent + "  ";
    if (Array.isArray(v)) return v.length ? `[\n${v.map(item => nextIndent + encode(item, level + 1)).join(",\n")}\n${indent}]` : "[]";
    if (v && typeof v === "object") {
      const keys = Object.keys(v).sort();
      return keys.length ? `{\n${keys.map(k => nextIndent + JSON.stringify(k) + ": " + encode(v[k], level + 1)).join(",\n")}\n${indent}}` : "{}";
    }
    return JSON.stringify(v);
  }
  return encode(value, 0) + "\n";
}
