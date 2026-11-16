import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { exportGitHub, githubRepository, runGit, type GitRunner } from "./github";

const owned: string[] = [];
function temp() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-github-test-")); owned.push(root); return root; }
afterEach(() => { for (const root of owned.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it("accepts only GitHub slugs and credential-free HTTPS repository URLs", () => {
  expect(githubRepository("https://github.com/example/crp.git")).toBe("example/crp");
  for (const value of ["https://token@github.com/a/b", "file:///a/b", "a/../b", "-a/b", "a/b?token=x", "https://evil.test/a/b", "git@github.com:a/b", "a/b\n--upload-pack=x"]) expect(() => githubRepository(value)).toThrow("INVALID_GITHUB_REPOSITORY");
});
it("exports exact committed bytes without checkout, ignores other files and pins HEAD", async () => {
  const repo = temp(), output = temp();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true });
  git("init", "--template=", ".");
  fs.mkdirSync(path.join(repo, "archive/rp/raw"), { recursive: true });
  const bytes = Buffer.from("fictional 中文\r\nsecond line\n", "utf8");
  fs.writeFileSync(path.join(repo, "archive/rp/raw/test.md"), bytes);
  fs.writeFileSync(path.join(repo, "private.txt"), "not exported");
  git("-c", "core.autocrlf=false", "add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture");
  const expected = git("rev-parse", "HEAD").toString().trim();
  const runner: GitRunner = async (args, cwd, signal, max) => {
    if (args.includes("fetch")) return execFileSync("git", ["fetch", "--depth=1", "--no-tags", repo, "HEAD"], { cwd, windowsHide: true });
    return runGit(args, cwd, signal, max);
  };
  const result = await exportGitHub("example/crp", output, new AbortController().signal, runner);
  expect(result.commit).toBe(expected);
  expect(fs.readFileSync(path.join(result.source, "archive/rp/raw/test.md"))).toEqual(bytes);
  expect(fs.existsSync(path.join(result.source, "private.txt"))).toBe(false);
  expect(fs.existsSync(path.join(output, "repository.git", "index"))).toBe(false);
});
it("rejects symlinks and pending source transactions before reading blobs", async () => {
  for (const tree of ["120000 blob " + "a".repeat(40) + " 4\tcanon/link.md\0", "100644 blob " + "a".repeat(40) + " 4\t.crp-runtime/pending.json\0"]) {
    const runner = vi.fn<GitRunner>(async args => Buffer.from(args[0] === "rev-parse" ? "a".repeat(40) : args[0] === "ls-tree" ? tree : ""));
    await expect(exportGitHub("example/crp", temp(), new AbortController().signal, runner)).rejects.toThrow("BRIDGE_");
    expect(runner.mock.calls.some(([args]) => args[0] === "cat-file")).toBe(false);
  }
});
it("does no Git work after cancellation", async () => {
  const controller = new AbortController(); controller.abort(); const runner = vi.fn<GitRunner>();
  await expect(exportGitHub("example/crp", temp(), controller.signal, runner)).rejects.toThrow();
  expect(runner).not.toHaveBeenCalled();
});
