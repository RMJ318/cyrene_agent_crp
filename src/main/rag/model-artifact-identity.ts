import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Strong, bounded-memory identity for an explicitly requested local model; never called by availability probes. */
export function modelArtifactIdentity(root: string): string {
  if (fs.realpathSync(root).toLowerCase() !== path.resolve(root).toLowerCase() || fs.lstatSync(root).isSymbolicLink()) throw Error("MODEL_IDENTITY_PATH");
  const files: Array<[string, string]> = []; let total = 0;
  const visit = (relative: string) => {
    const full = path.join(root, relative), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw Error("MODEL_IDENTITY_PATH");
    if (stat.isDirectory()) { for (const name of fs.readdirSync(full).sort()) visit(path.join(relative, name)); return; }
    if (!stat.isFile() || files.length >= 4096 || (total += stat.size) > 12 * 1024 ** 3) throw Error("MODEL_IDENTITY_LIMIT");
    const fd = fs.openSync(full, "r"), digest = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    try { for (;;) { const n = fs.readSync(fd, buffer, 0, buffer.length, null); if (!n) break; digest.update(buffer.subarray(0, n)); } }
    finally { fs.closeSync(fd); }
    const after = fs.lstatSync(full);
    if (after.isSymbolicLink() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) throw Error("MODEL_IDENTITY_CHANGED");
    files.push([relative.split(path.sep).join("/"), digest.digest("hex")]);
  };
  visit(""); if (!files.length) throw Error("MODEL_IDENTITY_EMPTY");
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}
