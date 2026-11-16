import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface DevApp { isPackaged: boolean; setPath(name: "appData" | "userData" | "sessionData" | "logs", value: string): void }
/** Runs before any service import. No existing profile, migration source or credentials are read. */
export function prepareBridgeDevProfile(target: DevApp, enabled: boolean, parent = os.tmpdir()): string | undefined {
  if (!enabled) return undefined;
  if (target.isPackaged) throw new Error("BRIDGE_DEV_PROFILE_REQUIRES_SOURCE_BUILD");
  const root = fs.mkdtempSync(path.join(parent, "cyrene-bridge-dev-"));
  for (const name of ["appData", "userData", "sessionData", "logs"] as const) {
    const directory = path.join(root, name); fs.mkdirSync(directory); target.setPath(name, directory);
  }
  fs.writeFileSync(path.join(root, "userData", "model-settings.json"), JSON.stringify({ memoryMode: "off", runtimeSync: "local", apiKey: "", baseUrl: "", model: "", profiles: [] }), { flag: "wx" });
  fs.writeFileSync(path.join(root, "userData", "app-settings.json"), JSON.stringify({ momentsEnabled: false, chatSocialContextEnabled: false, proactiveChatEnabled: false }), { flag: "wx" });
  console.log(`[MemoryBridge] Isolated development profile: ${root}`);
  return root;
}

prepareBridgeDevProfile(app, process.env.CYRENE_BRIDGE_DEV_PROFILE === "1");
