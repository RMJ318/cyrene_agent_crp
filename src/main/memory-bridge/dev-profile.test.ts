import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: { isPackaged: false } }));
import { prepareBridgeDevProfile } from "./dev-profile";

it("leaves normal startup alone and creates a fresh, credential-free profile only on explicit development launch", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dev-test-"));
  try {
    const target = { isPackaged: false, setPath: vi.fn() };
    expect(prepareBridgeDevProfile(target, false, parent)).toBeUndefined(); expect(target.setPath).not.toHaveBeenCalled();
    const root = prepareBridgeDevProfile(target, true, parent)!;
    expect(target.setPath.mock.calls).toHaveLength(4);
    expect(target.setPath.mock.calls.every(([, value]) => path.relative(root, value).split(path.sep).length === 1)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, "userData/model-settings.json"), "utf8"))).toMatchObject({ memoryMode: "off", apiKey: "", baseUrl: "" });
    expect(() => prepareBridgeDevProfile({ ...target, isPackaged: true }, true, parent)).toThrow("SOURCE_BUILD");
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
