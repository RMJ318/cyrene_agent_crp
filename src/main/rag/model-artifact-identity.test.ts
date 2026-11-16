import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { modelArtifactIdentity } from "./model-artifact-identity";
const roots: string[] = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-artifact-test-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it("binds bytes and names, catching same-size replacements even when timestamps are restored", () => {
  const root = temp(), file = path.join(root, "model.onnx"); fs.writeFileSync(file, "firstweights"); fs.writeFileSync(path.join(root, "tokenizer.json"), "{}");
  const initial = modelArtifactIdentity(root), stat = fs.statSync(file);
  expect(modelArtifactIdentity(root)).toBe(initial); fs.writeFileSync(file, "otherweights"); fs.utimesSync(file, stat.atime, stat.mtime);
  expect(modelArtifactIdentity(root)).not.toBe(initial);
  const changed = modelArtifactIdentity(root); fs.renameSync(file, path.join(root, "renamed.onnx")); expect(modelArtifactIdentity(root)).not.toBe(changed);
});
it("refuses links and empty artifact roots", () => {
  const root = temp(); expect(() => modelArtifactIdentity(root)).toThrow("EMPTY");
  const target = temp(); fs.writeFileSync(path.join(target, "weights"), "fiction");
  try { fs.symlinkSync(target, path.join(root, "link"), "junction"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EPERM") return; throw e; }
  expect(() => modelArtifactIdentity(root)).toThrow("PATH");
});
