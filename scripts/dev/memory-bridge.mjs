import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(repo, "package.json"));
const electron = require("electron");
const env = { ...process.env, CYRENE_BRIDGE_DEV_PROFILE: "1" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV;
const child = spawn(electron, [repo], { cwd: repo, env, stdio: "inherit", windowsHide: true });
child.once("error", () => { console.error("Unable to start isolated Bridge development app. Run pnpm install first."); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
