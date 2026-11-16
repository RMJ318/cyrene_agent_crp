import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, ".build-temp/crp-sync-runtime"); fs.mkdirSync(out, { recursive: true });
for (const [source, name] of [["server-cli.ts", "server.cjs"], ["client-runtime.ts", "client.cjs"]]) {
  const result = await build({ entryPoints: [path.join(root, "src/main/crp-sync", source)], outfile: path.join(out, name), bundle: true, platform: "node", target: "node24", format: "cjs", external: ["@node-rs/jieba"], logLevel: "warning", metafile: true });
  if (Object.keys(result.metafile.inputs).some(name => /(?:^|\/)electron\/|\/rag\/(?:embedding|model-status)\.ts$/.test(name.replaceAll("\\", "/")))) throw Error("SYNC_RUNTIME_DESKTOP_DEPENDENCY");
}
fs.copyFileSync(path.join(root, "integrations/crp-sync/Dockerfile"), path.join(out, "Dockerfile"));
const jieba = JSON.parse(fs.readFileSync(path.join(root, "node_modules/@node-rs/jieba/package.json"), "utf8"));
fs.writeFileSync(path.join(out, "package.json"), JSON.stringify({ private: true, engines: { node: ">=24" }, dependencies: { "@node-rs/jieba": jieba.version } }, null, 2));
console.log(JSON.stringify({ built: true, modelCalls: 0, credentialsIncluded: false, dataIncluded: false }));
