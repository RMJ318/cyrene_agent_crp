import { createHash, timingSafeEqual } from "node:crypto";

export const SYNC_LIMITS = { files: 2000, fileBytes: 8 * 1024 * 1024, memoryBytes: 32 * 1024 * 1024, bodyBytes: 48 * 1024 * 1024 };
export interface SyncFile { path: string; sha256: string; contentBase64: string; domain: "writer" | "reality0" }
export interface MemoryBundle { version: 1; deviceId: string; revision: number; previousDigest: string | null; digest: string; createdAt: string; files: SyncFile[] }
export interface SyncClientConfig { version: 1; enabled: boolean; endpoint: string; repository: string; deviceId: string; tokenFile: string; channel?: string; pollMs?: number; publishMs?: number }
export const digest = (body: string | Buffer): string => createHash("sha256").update(body).digest("hex");
export const validCommit = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export const validDevice = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function relativePath(value: unknown): value is string {
  return typeof value === "string" && value.length < 600 && !/^[\/]|[\\:\x00-\x1f]/.test(value) && value.split("/").every(p => !!p && p !== "." && p !== "..");
}
export function memoryPath(value: unknown): value is string {
  return relativePath(value) && /^(?:native\/(?:memory\.json|wiki\/[\w./-]+\.(?:md|json)|summary\/[\w./-]+\.md|workspaces\/[a-f0-9]{64}\/[\w./-]+\.md)|bridge\/(?:writer|reality0)\.json)$/.test(value);
}
export function credentialMaterial(body: Buffer): boolean {
  return /(?:sk-or-v1-[A-Za-z0-9]{40,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|["'](?:api[_-]?key|client[_-]?secret)["']\s*[:=]\s*["'][A-Za-z0-9_+\/-]{24,}["'])/i.test(body.toString("utf8"));
}
export function contentDigest(files: readonly SyncFile[]): string {
  return digest(JSON.stringify([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(f => [f.path, f.domain, f.sha256])));
}
export function validateBundle(value: unknown): MemoryBundle {
  const b = value as MemoryBundle;
  if (!b || b.version !== 1 || !validDevice(b.deviceId) || !Number.isSafeInteger(b.revision) || b.revision < 1
    || b.previousDigest !== null && !/^[a-f0-9]{64}$/.test(b.previousDigest) || !/^[a-f0-9]{64}$/.test(b.digest)
    || typeof b.createdAt !== "string" || !Number.isFinite(Date.parse(b.createdAt)) || !Array.isArray(b.files) || b.files.length > SYNC_LIMITS.files) throw Error("SYNC_INVALID_BUNDLE");
  let total = 0; const seen = new Set<string>();
  for (const f of b.files) {
    if (!f || !memoryPath(f.path) || seen.has(f.path) || !["writer", "reality0"].includes(f.domain)
      || f.domain !== (f.path === "bridge/reality0.json" ? "reality0" : "writer") || typeof f.contentBase64 !== "string"
      || f.contentBase64.length > Math.ceil(SYNC_LIMITS.fileBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.contentBase64)) throw Error("SYNC_INVALID_FILE");
    const body = Buffer.from(f.contentBase64, "base64"); total += body.length;
    if (body.toString("base64") !== f.contentBase64 || body.length > SYNC_LIMITS.fileBytes || total > SYNC_LIMITS.memoryBytes || digest(body) !== f.sha256) throw Error("SYNC_FILE_HASH_OR_LIMIT");
    if (credentialMaterial(body)) throw Error("SYNC_CREDENTIAL_MATERIAL_BLOCKED");
    if (f.path.endsWith(".json")) JSON.parse(body.toString("utf8"));
    seen.add(f.path);
  }
  if (contentDigest(b.files) !== b.digest) throw Error("SYNC_BUNDLE_HASH");
  return b;
}
export function tokenMatches(token: string, expectedHash: string): boolean {
  return /^[a-f0-9]{64}$/.test(expectedHash) && timingSafeEqual(Buffer.from(digest(token)), Buffer.from(expectedHash));
}
