import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { MemoryPrPublisher, publishCommand, type PublishCommand } from "./github-pr";
import { contentDigest, digest, validateBundle } from "./protocol";
import { GitSnapshotSource, type SyncGit } from "./git-source";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error("unsafe cleanup"); fs.rmSync(root, { recursive: true, force: true }); } });
it("incremental exports reuse only bytes with the exact new Git blob hash", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crp-sync-source-")); roots.push(root);
  const files: Record<string, string> = { "archive/rp/library/registry.json": '{"schema_version":"2.1","namespace_refs":{}}', "archive/rp/library/evidence/registry.json": "{}", "archive/rp/library/audit/knowledge-results.json": '{"entries":{}}', "archive/rp/raw/test.md": "fictional original\n" };
  const oid = (s: string) => createHash("sha1").update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest("hex"); let commit = "a".repeat(40), reads = 0;
  const git: SyncGit = async args => {
    if (args[0] === "rev-parse") return Buffer.from(commit);
    if (args[0] === "ls-tree") return Buffer.from(Object.entries(files).map(([p, s]) => `100644 blob ${oid(s)} ${Buffer.byteLength(s)}\t${p}\0`).join(""));
    if (args[0] === "cat-file") { reads++; return Buffer.from(Object.values(files).find(s => oid(s) === args[2])!); }
    return Buffer.alloc(0);
  };
  const source = new GitSnapshotSource(root, "example/archive", git), first = await source.refresh("main", "main");
  const initial = reads; files["canon/new.json"] = '{"new":"fixture"}'; commit = "b".repeat(40); const second = await source.refresh("main", "main", first);
  expect(reads - initial).toBe(1); const previous = reads;
  fs.writeFileSync(path.join(second.checkout, "archive/rp/raw/test.md"), "corrupted prior checkout\n"); commit = "c".repeat(40);
  const third = await source.refresh("main", "main", second); expect(reads - previous).toBe(1); expect(fs.readFileSync(path.join(third.checkout, "archive/rp/raw/test.md"), "utf8")).toBe(files["archive/rp/raw/test.md"]);
});
it("publishes append-only device branches, preserves main and follows newer upstream without force pushes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crp-sync-git-")); roots.push(root);
  const remote = path.join(root, "remote.git"), work = path.join(root, "source"); fs.mkdirSync(work);
  const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, windowsHide: true, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  git(root, ["init", "--bare", remote]); git(work, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(work, "original.txt"), "original 2.x fixture bytes\n"); git(work, ["add", "."]); git(work, ["commit", "-qm", "chore(测试): 创建原始档案"]); git(work, ["push", remote, "main"]);
  const firstMain = git(remote, ["rev-parse", "refs/heads/main"]), device = randomUUID(), ghCalls: string[][] = [];
  const run: PublishCommand = async (command, args, cwd, input, env, signal) => {
    if (command === "gh") { ghCalls.push(args); return Buffer.from(args[1] === "list" ? "[]" : "https://github.com/example/archive/pull/1\n"); }
    expect(args).not.toContain("--force"); expect(args).not.toContain("--force-with-lease");
    return publishCommand(command, args.map(a => a === "https://github.com/example/archive.git" ? remote : a === "protocol.file.allow=never" ? "protocol.file.allow=always" : a), cwd, input, env, signal);
  };
  const publisher = new MemoryPrPublisher(path.join(root, "publisher"), "example/archive", run);
  const make = (revision: number, content: string, previousDigest: string | null) => {
    const bytes = Buffer.from(JSON.stringify({ memory: content })), files = [{ path: "native/memory.json", domain: "writer", sha256: digest(bytes), contentBase64: bytes.toString("base64") }];
    return validateBundle({ version: 1, deviceId: device, revision, previousDigest, createdAt: new Date().toISOString(), files, digest: contentDigest(files as any) });
  };
  const b1 = make(1, "first fictional memory", null), p1 = await publisher.publish(b1);
  expect(git(remote, ["rev-parse", "refs/heads/main"])).toBe(firstMain);
  expect(git(remote, ["diff", "--name-only", firstMain, p1.commit]).split("\n").every(p => p.startsWith(`archive/cyrene-memory/${device}/`))).toBe(true);
  fs.writeFileSync(path.join(work, "upstream.txt"), "new upstream content must survive\n"); git(work, ["add", "."]); git(work, ["commit", "-qm", "feat(测试): 增加上游资料"]); git(work, ["push", remote, "main"]);
  const secondMain = git(remote, ["rev-parse", "refs/heads/main"]), p2 = await publisher.publish(make(2, "updated fictional memory", b1.digest));
  expect(git(remote, ["rev-parse", "refs/heads/main"])).toBe(secondMain);
  expect(git(remote, ["merge-base", p2.commit, secondMain])).toBe(secondMain);
  expect(git(remote, ["show", `${p2.commit}:original.txt`])).toBe("original 2.x fixture bytes");
  expect(git(remote, ["show", `${p2.commit}:upstream.txt`])).toBe("new upstream content must survive");
  expect(git(remote, ["rev-list", "--parents", "-n", "1", p2.commit]).split(" ").slice(1)).toContain(p1.commit);
  expect(ghCalls.some(args => args[1] === "create")).toBe(true);
}, 30000);
