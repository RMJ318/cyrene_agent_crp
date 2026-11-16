import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.join(root, "integrations/crp-v3/skill-source");
const destination = path.join(root, ".build-temp/crp3-skill-packs");
const check = process.argv.slice(2);
if (check.length && (check.length !== 1 || check[0] !== "--check")) throw new Error("Usage: node scripts/crp/build-skill-packs.mjs [--check]");
const read = name => fs.readFileSync(path.join(source, name), "utf8").replace(/\r\n/g, "\n");
const files = new Map();
for (const runtime of ["repository", "chatgpt"]) for (const [name, entry] of [["crp-archivist-v3-preview", "archivist.md"], ["crp-fact-auditor-v3-preview", "auditor.md"]]) {
  const prefix = `${runtime}/${name}`;
  const skill = read(entry);
  if (!skill.startsWith(`---\nname: ${name}\n`) || !skill.includes("description:")) throw new Error("Invalid skill metadata");
  files.set(`${prefix}/SKILL.md`, skill);
  files.set(`${prefix}/references/common.md`, read("common.md"));
  files.set(`${prefix}/references/runtime.md`, read(`runtime-${runtime}.md`));
  files.set(`${prefix}/references/operations.md`, read("operations.md"));
}
const hashes = Object.fromEntries([...files].map(([relative, body]) => [relative, crypto.createHash("sha256").update(body).digest("hex")]));
const privateManifest = path.join(root, "integrations/crp-v3/manifest.json");
const baseline = JSON.parse(fs.readFileSync(fs.existsSync(privateManifest) ? privateManifest : path.join(root, "integrations/crp-v3/manifest.example.json"), "utf8"));
files.set("manifest.json", JSON.stringify({ contract: baseline.contract, sourceCommit: baseline.sourceCommit, published: false,
  productionReady: false, replacesExistingSkills: false, legacyAuthority: "CRP 2.0/2.1 repository skills and scripts", files: hashes }, null, 2) + "\n");
// Remove only the four obsolete, locally generated preview directories whose old names collide with production skills.
for (const runtime of ["repository", "chatgpt"]) for (const legacyName of ["crp-archivist", "crp-fact-auditor"]) {
  const obsolete = path.resolve(destination, runtime, legacyName);
  if (!obsolete.startsWith(destination + path.sep)) throw new Error("Unsafe obsolete output");
  let current = root;
  for (const part of path.relative(root, obsolete).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink())) throw new Error("Unsafe obsolete output directory");
  }
  if (fs.existsSync(obsolete)) {
    if (check.length) throw new Error("Obsolete preview skill identity collides with production");
    const resolved = fs.realpathSync(obsolete), ownedRoot = fs.realpathSync(destination);
    if (!resolved.startsWith(ownedRoot + path.sep)) throw new Error("Unsafe obsolete output target");
    fs.rmSync(resolved, { recursive: true });
  }
}
for (const [relative, body] of files) {
  const target = path.resolve(destination, relative);
  if (!target.startsWith(destination + path.sep)) throw new Error("Unsafe output");
  let current = root;
  for (const part of path.relative(root, path.dirname(target)).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink())) throw new Error("Unsafe output directory");
    if (!check.length) fs.mkdirSync(current, { recursive: true });
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("Unsafe output file");
  if (check.length) {
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== body) throw new Error("Skill pack out of date");
  } else fs.writeFileSync(target, body, { mode: 0o600 });
}
console.log(JSON.stringify({ packs: 4, files: files.size, checked: !!check.length, published: false }));
