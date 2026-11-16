import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const destination = path.join(root, ".build-temp/crp3-query-service");
fs.mkdirSync(destination, { recursive: true });
const built = await build({ entryPoints: [path.join(root, "src/main/crp-core/query-service-cli.ts")], outfile: path.join(destination, "server.cjs"), bundle: true,
  platform: "node", target: "node24", format: "cjs", external: ["@node-rs/jieba"], logLevel: "warning", metafile: true });
if (Object.keys(built.metafile.inputs).some(name => /(?:^|\/)electron\/|\/rag\/(?:embedding|model-status)\.ts$/.test(name.replaceAll("\\", "/")))) throw Error("CRP_SERVICE_DESKTOP_DEPENDENCY");
const mcp = await build({ entryPoints: [path.join(root, "src/main/crp-core/mcp-service-cli.ts")], outfile: path.join(destination, "mcp.cjs"), bundle: true,
  platform: "node", target: "node24", format: "cjs", external: ["@node-rs/jieba"], logLevel: "warning", metafile: true });
if (Object.keys(mcp.metafile.inputs).some(name => /(?:^|\/)electron\/|\/rag\/(?:embedding|model-status)\.ts$/.test(name.replaceAll("\\", "/")))) throw Error("CRP_SERVICE_DESKTOP_DEPENDENCY");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "node_modules/@node-rs/jieba/package.json"), "utf8"));
fs.writeFileSync(path.join(destination, "package.json"), JSON.stringify({ private: true, engines: { node: ">=24" }, dependencies: { "@node-rs/jieba": pkg.version } }, null, 2));
fs.copyFileSync(path.join(root, "integrations/crp-v3/deployment/Dockerfile"), path.join(destination, "Dockerfile"));
console.log(JSON.stringify({ built: true, bundledModels: false, productionDataIncluded: false }));
