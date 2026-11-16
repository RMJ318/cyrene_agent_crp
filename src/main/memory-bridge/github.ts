import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { assertNotAborted, fail, within } from "./safety";

export function githubRepository(input: unknown): string {
  if (typeof input !== "string" || input.length > 250) fail("INVALID_GITHUB_REPOSITORY");
  const value = input.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(value) || value.split("/").some(v => v === "." || v === "..")) fail("INVALID_GITHUB_REPOSITORY");
  return value;
}

export type GitRunner = (args: string[], cwd: string, signal: AbortSignal, maxBuffer?: number) => Promise<Buffer>;
export const runGit: GitRunner = (args, cwd, signal, maxBuffer = 4 * 1024 * 1024) => new Promise((resolve, reject) => {
  execFile("git", ["-c", "core.hooksPath=", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-c", "http.followRedirects=false", ...args], {
    cwd, signal, windowsHide: true, timeout: 120_000, maxBuffer, encoding: "buffer",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "" },
  }, (error, stdout) => {
    if (error) {
      // Never return Git stderr: it may include credentials or private source paths.
      reject(new Error(signal.aborted ? "BRIDGE_GITHUB_CANCELLED" : (error as NodeJS.ErrnoException).code === "ENOENT" ? "BRIDGE_GIT_NOT_INSTALLED" : "BRIDGE_GITHUB_FETCH_FAILED"));
    } else resolve(stdout);
  });
});

const roots = ["archive/rp/library", "archive/rp/raw", "archive/rp/inbox", "archive/rp/continuity", "manuscripts", "canon", ".crp-runtime/pending.json"];

/** The caller owns this fresh directory. No checkout, hooks, filters or remote writes. */
export async function exportGitHub(input: unknown, directory: string, signal: AbortSignal, git: GitRunner = runGit): Promise<{ source: string; repository: string; commit: string }> {
  const repository = githubRepository(input);
  assertNotAborted(signal);
  const bare = path.join(directory, "repository.git");
  const source = path.join(directory, "source");
  fs.mkdirSync(bare); fs.mkdirSync(source);
  await git(["init", "--bare", "--template=", "."], bare, signal);
  await git(["-c", "core.hooksPath=", "fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", `https://github.com/${repository}.git`, "HEAD"], bare, signal);
  const commit = (await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], bare, signal)).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) fail("INVALID_GITHUB_COMMIT");
  const tree = (await git(["ls-tree", "-r", "-z", "-l", "--full-tree", commit, "--", ...roots], bare, signal)).toString("utf8");
  let total = 0, count = 0;
  for (const entry of tree.split("\0").filter(Boolean)) {
    assertNotAborted(signal);
    const match = /^(\d+) blob ([a-f0-9]{40})\s+(\d+)\t(.+)$/.exec(entry);
    if (!match || !["100644", "100755"].includes(match[1])) fail("UNSAFE_GITHUB_TREE");
    const [, , oid, sizeText, relative] = match;
    if (relative === ".crp-runtime/pending.json") fail("PENDING_CRP_TRANSACTION");
    if (!/\.(md|json)$/i.test(relative)) continue;
    const target = path.resolve(source, relative);
    if (!within(source, target) || relative.split("/").some(p => !p || p === "." || p === ".." || /[\\:\x00-\x1f]/.test(p))) fail("UNSAFE_GITHUB_TREE");
    const size = Number(sizeText); total += size;
    if (size > 32 * 1024 * 1024 || total > 512 * 1024 * 1024 || ++count > 10_000) fail("SNAPSHOT_LIMIT");
    const bytes = await git(["cat-file", "blob", oid], bare, signal, 32 * 1024 * 1024 + 1);
    if (bytes.length !== size) fail("GITHUB_BLOB_CHANGED");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: "wx" });
  }
  assertNotAborted(signal);
  return { source, repository, commit };
}
