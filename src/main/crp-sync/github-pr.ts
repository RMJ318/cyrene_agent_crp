import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { validCommit, validateBundle, type MemoryBundle } from "./protocol";

export type PublishCommand = (command: string, args: string[], cwd: string, input?: Buffer, extraEnv?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<Buffer>;
export const publishCommand: PublishCommand = (command, args, cwd, input, extraEnv, signal) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, signal, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...extraEnv, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1" } });
  const pieces: Buffer[] = []; let total = 0, done = false;
  const timer = setTimeout(() => { child.kill(); }, 120000); timer.unref();
  const fail = () => { if (!done) { done = true; clearTimeout(timer); reject(Error(signal?.aborted ? "SYNC_CANCELLED" : "SYNC_GITHUB_PUBLISH_FAILED")); } };
  child.once("error", fail); child.stdout.on("data", data => { if ((total += data.length) > 8 * 1024 * 1024) { child.kill(); fail(); } else pieces.push(Buffer.from(data)); });
  child.stderr.resume(); child.stdin.on("error", () => undefined);
  child.once("close", code => { clearTimeout(timer); if (done) return; if (code !== 0) return fail(); done = true; resolve(Buffer.concat(pieces)); });
  child.stdin.end(input);
});
export class MemoryPrPublisher {
  readonly bare: string;
  constructor(readonly root: string, readonly repository: string, readonly run: PublishCommand = publishCommand) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw Error("SYNC_REPOSITORY");
    fs.mkdirSync(root, { recursive: true }); this.bare = path.join(root, "github.git");
  }
  async publish(raw: MemoryBundle, signal?: AbortSignal): Promise<{ url: string; commit: string; revision: number }> {
    const b = validateBundle(raw), prefix = `archive/cyrene-memory/${b.deviceId}/`, branch = `codex/cyrene-memory-${b.deviceId}`;
    const remote = `https://github.com/${this.repository}.git`, index = path.join(this.root, `index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "Cyrene Memory Sync", GIT_AUTHOR_EMAIL: "cyrene-memory-sync@users.noreply.github.com", GIT_COMMITTER_NAME: "Cyrene Memory Sync", GIT_COMMITTER_EMAIL: "cyrene-memory-sync@users.noreply.github.com" };
    const git = (args: string[], input?: Buffer) => this.run("git", ["-c", "core.hooksPath=", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", ...args], this.bare, input, env, signal);
    if (!fs.existsSync(this.bare)) { fs.mkdirSync(this.bare); await git(["init", "--bare", "--template=", "."]); }
    await git(["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", remote, "+refs/heads/main:refs/remotes/origin/main"]);
    const base = (await git(["rev-parse", "refs/remotes/origin/main^{commit}"])).toString().trim(); if (!validCommit(base)) throw Error("SYNC_COMMIT");
    const remoteBranch = (await git(["ls-remote", "--heads", remote, `refs/heads/${branch}`])).toString().trim();
    let prior: string | undefined;
    if (remoteBranch) { await git(["fetch", "--depth=1", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/origin/memory`]); prior = (await git(["rev-parse", "refs/remotes/origin/memory^{commit}"])).toString().trim(); if (!validCommit(prior)) throw Error("SYNC_COMMIT"); }
    await git(["read-tree", base]);
    const previousPaths = (await git(["ls-tree", "-rz", "--full-tree", base, "--", prefix])).toString("utf8").split("\0").filter(Boolean).map(line => line.slice(line.indexOf("\t") + 1));
    const staged: Array<[string, Buffer]> = b.files.map(f => [prefix + "files/" + f.path, Buffer.from(f.contentBase64, "base64")]);
    staged.push([prefix + "latest.json", Buffer.from(JSON.stringify({ version: 1, deviceId: b.deviceId, revision: b.revision, digest: b.digest, createdAt: b.createdAt,
      namespace: "writer-or-explicit-reality0; never automatic RP knowledge", modelRelease: "not-granted-by-sync", files: b.files.map(({ path: p, sha256, domain }) => ({ path: "files/" + p, sha256, domain })) }, null, 2) + "\n")]);
    const lines = previousPaths.map(p => `0 ${"0".repeat(40)}\t${p}\0`);
    for (const [relative, bytes] of staged) { const oid = (await git(["hash-object", "-w", "--stdin"], bytes)).toString().trim(); if (!validCommit(oid)) throw Error("SYNC_GIT_BLOB"); lines.push(`100644 ${oid}\t${relative}\0`); }
    await git(["update-index", "-z", "--index-info"], Buffer.from(lines.join("")));
    const tree = (await git(["write-tree"])).toString().trim(); let commit: string;
    const previousTree = prior ? (await git(["rev-parse", `${prior}^{tree}`])).toString().trim() : undefined;
    if (prior && previousTree === tree) commit = prior;
    else {
      const parents = [...new Set([prior, base].filter((p): p is string => !!p))];
      commit = (await git(["commit-tree", tree, ...parents.flatMap(p => ["-p", p])], Buffer.from(`feat(记忆同步): 同步Cyrene记忆第${b.revision}版\n`))).toString().trim();
      if (!validCommit(commit)) throw Error("SYNC_COMMIT");
      await git(["push", remote, `${commit}:refs/heads/${branch}`]);
    }
    const rows = JSON.parse((await this.run("gh", ["pr", "list", "--repo", this.repository, "--head", branch, "--base", "main", "--state", "open", "--json", "url"], this.root, undefined, undefined, signal)).toString());
    let url = rows[0]?.url;
    if (!url) {
      const bodyFile = path.join(this.root, `pr-${b.deviceId}.md`);
      fs.writeFileSync(bodyFile, `Cyrene 的记忆已自动同步至受认证服务器，本 PR 保存设备 ${b.deviceId} 的第 ${b.revision} 版。仅更新 \`${prefix}\`，不改 RP 2.x 或并行 3.0 档案，不自动合并。\n\n原始记忆文本、Wiki 与摘要保持内容和范围；个人资料不自动变成 RP 角色知识，同步不授予模型读取同意。敏感 Bridge 记录仍保留本机密文，临时同意表不外传。凭据扫描通过。删除通过本设备目录中的最新清单和 Git 历史表达，不删除旧 CRP 数据。\n\n内容摘要：\`${b.digest}\`。后续记忆变化会定期更新此 PR；正文不包含私密全文或密钥。\n`, { mode: 0o600 });
      url = (await this.run("gh", ["pr", "create", "--repo", this.repository, "--base", "main", "--head", branch, "--title", "feat(记忆同步): 持续同步Cyrene记忆", "--body-file", bodyFile], this.root, undefined, undefined, signal)).toString().trim();
    }
    if (typeof url !== "string" || !url.startsWith(`https://github.com/${this.repository}/pull/`) || !/\/\d+$/.test(url)) throw Error("SYNC_PR_RESPONSE");
    // Index files are private to this transaction, not a working copy of CRP.
    if (path.dirname(path.resolve(index)) !== path.resolve(this.root)) throw Error("SYNC_INDEX_PATH");
    fs.rmSync(index, { force: true });
    return { url, commit, revision: b.revision };
  }
}
