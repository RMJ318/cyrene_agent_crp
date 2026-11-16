import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createHash } from "node:crypto";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const destination = path.join(root, ".build-temp/crp3-repository-runtime"); fs.mkdirSync(destination, { recursive: true });
const built = await build({ entryPoints: [path.join(root, "src/main/crp-core/repository-api.ts")], outfile: path.join(destination, "core.cjs"), bundle: true,
  platform: "node", target: "node24", format: "cjs", external: ["@node-rs/jieba"], logLevel: "warning", metafile: true });
if (Object.keys(built.metafile.inputs).some(name => /(?:^|\/)electron\/|\/rag\/(?:embedding|model-status)\.ts$/.test(name.replaceAll("\\", "/")))) throw Error("CRP_RUNTIME_DESKTOP_DEPENDENCY");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "node_modules/@node-rs/jieba/package.json"), "utf8"));
fs.writeFileSync(path.join(destination, "package.json"), JSON.stringify({ name: "crp-core-runtime", private: true, version: "3.0.0-preview.2", main: "core.cjs", engines: { node: ">=24" }, dependencies: { "@node-rs/jieba": pkg.version } }, null, 2));
const runtime = await import("node:module").then(({ createRequire }) => createRequire(import.meta.url)(path.join(destination, "core.cjs")));
for (const [name, schema] of [["record", runtime.CORE_RECORD_SCHEMA], ["change", runtime.CORE_CHANGE_SCHEMA], ["query", runtime.CORE_QUERY_SCHEMA]]) fs.writeFileSync(path.join(destination, `${name}.schema.json`), JSON.stringify(schema, null, 2));
const hashes = Object.fromEntries(fs.readdirSync(destination).filter(name => name !== "manifest.json").map(name => [name, createHash("sha256").update(fs.readFileSync(path.join(destination, name))).digest("hex")]));
fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify({ contract: runtime.CRP_CORE_VERSION, productionActivated: false, paidApiCalls: 0, files: hashes }, null, 2));
console.log(JSON.stringify({ files: Object.keys(hashes).length, contract: runtime.CRP_CORE_VERSION, productionActivated: false }));
