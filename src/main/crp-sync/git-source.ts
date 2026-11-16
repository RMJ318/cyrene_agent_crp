import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { safePath } from "../memory-bridge/safety";
import { importSnapshot, CrpSnapshot } from "../memory-bridge/snapshot";
import { digest, relativePath, validCommit } from "./protocol";

const exec = promisify(execFile);
export type SyncGit = (args: string[], cwd: string, signal?: AbortSignal, limit?: number) => Promise<Buffer>;
export function gitRunner(sshKey?: string, knownHosts?: string): SyncGit {
  if ([sshKey, knownHosts].some(p => p !== undefined && !/^\/[A-Za-z0-9_./-]+$/.test(p))) throw Error("SYNC_SSH_PATH");
  return async (args, cwd, signal, limit = 8 * 1024 * 1024) => {
    try {
      const result = await exec("git", ["-c", "core.hooksPath=", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", ...args], {
        cwd, signal, windowsHide: true, timeout: 120000, maxBuffer: limit, encoding: "buffer",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "",
          ...(sshKey ? { GIT_SSH_COMMAND: `ssh -F /dev/null -i ${sshKey} -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHosts}` } : {}) },
      }); return Buffer.from(result.stdout);
    } catch { throw Error(signal?.aborted ? "SYNC_CANCELLED" : "SYNC_GIT_OPERATION_FAILED"); }
  };
}
export interface PublishedSnapshot { repository: string; commit: string; channel: string; snapshot: CrpSnapshot; checkout: string; publishedAt: string }
export class GitSnapshotSource {
  readonly mirror: string;
  constructor(readonly root: string, readonly repository: string, readonly git: SyncGit) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw Error("SYNC_REPOSITORY");
    fs.mkdirSync(root, { recursive: true }); this.mirror = path.join(root, "mirror.git");
  }
  async refresh(channel: string, ref: string, previous?: PublishedSnapshot, signal?: AbortSignal): Promise<PublishedSnapshot> {
    if (!/^[\w-]{1,40}$/.test(channel) || !/^[\w./-]+$/.test(ref) || ref.includes("..") || ref.endsWith(".lock")) throw Error("SYNC_REF");
    if (!fs.existsSync(this.mirror)) { fs.mkdirSync(this.mirror); await this.git(["init", "--bare", "--template=", "."], this.mirror, signal); }
    await this.git(["fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", `git@github.com:${this.repository}.git`, `+refs/heads/${ref}:refs/sync/${channel}`], this.mirror, signal);
    const commit = (await this.git(["rev-parse", `refs/sync/${channel}^{commit}`], this.mirror, signal)).toString().trim();
    if (!validCommit(commit)) throw Error("SYNC_COMMIT");
    if (previous?.commit === commit) return previous;
    const checkout = path.join(this.root, "checkouts", commit); fs.mkdirSync(path.dirname(checkout), { recursive: true });
    if (!fs.existsSync(checkout)) {
      const stage = path.join(this.root, "checkouts", `.staging-${randomUUID()}`); fs.mkdirSync(stage);
      const tree = (await this.git(["ls-tree", "-rz", "-l", "--full-tree", commit], this.mirror, signal)).toString("utf8");
      let total = 0, count = 0;
      for (const row of tree.split("\0").filter(Boolean)) {
        if (signal?.aborted) throw Error("SYNC_CANCELLED");
        const m = /^(100644|100755) blob ([a-f0-9]{40})\s+(\d+)\t(.+)$/.exec(row);
        if (!m || !relativePath(m[4])) throw Error("SYNC_UNSAFE_GIT_TREE");
        const size = Number(m[3]); total += size;
        if (++count > 10000 || size > 32 * 1024 * 1024 || total > 512 * 1024 * 1024) throw Error("SYNC_REPOSITORY_LIMIT");
        let bytes: Buffer | undefined;
        if (previous && fs.existsSync(path.join(previous.checkout, m[4]))) {
          const priorFile = safePath(previous.checkout, m[4]), stat = fs.statSync(priorFile);
          if (stat.isFile() && stat.size === size) {
            const candidate = fs.readFileSync(priorFile);
            // Reuse only bytes matching the new Git blob, never just a timestamp.
            if (createHash("sha1").update(`blob ${candidate.length}\0`).update(candidate).digest("hex") === m[2]) bytes = candidate;
          }
        }
        bytes ??= await this.git(["cat-file", "blob", m[2]], this.mirror, signal, 32 * 1024 * 1024 + 1);
        if (bytes.length !== size) throw Error("SYNC_BLOB_CHANGED");
        const target = path.join(stage, m[4]); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
      }
      // No checkout, repository hooks, filters, source scripts or submodules run.
      fs.renameSync(stage, checkout);
    }
    const snapshot = await importSnapshot(checkout, path.join(this.root, "snapshots"), [], signal);
    // importSnapshot validates before returning; a second synchronous full-corpus
    // pass here blocks HTTP handling without providing another publication gate.
    return { repository: this.repository, commit, channel, snapshot, checkout, publishedAt: new Date().toISOString() };
  }
}
export function snapshotState(p: PublishedSnapshot) {
  const bytes = fs.readFileSync(path.join(p.snapshot.root, "snapshot.json"));
  return { version: 1, repository: p.repository, commit: p.commit, channel: p.channel, snapshotId: p.snapshot.manifest.snapshotId,
    manifest: p.snapshot.manifest, manifestSha256: digest(bytes), publishedAt: p.publishedAt, modelCalls: 0 };
}
