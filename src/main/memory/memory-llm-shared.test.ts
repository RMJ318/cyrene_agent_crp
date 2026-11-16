import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ root: "", settings: {} as Record<string, unknown> }));
vi.mock("electron", () => ({ app: { getPath: () => state.root } }));
vi.mock("../settings/model-settings", async original => ({
  ...await original<typeof import("../settings/model-settings")>(), loadModelSettings: () => state.settings,
}));
import { loadMemoryModelConfig } from "./memory-llm-shared";
beforeEach(() => { state.root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-memory-config-")); });
afterEach(() => { fs.rmSync(state.root, { recursive: true, force: true }); });
it("继承默认档案的协议和手动推理规则，而非空镜像", () => {
  const manual = { style: "custom", supportedEfforts: [], supportsDisable: true, customBodies: { on: { reasoning: { effort: "low" } }, off: { reasoning: { effort: "none" } } } };
  state.settings = { provider: "MiniMax（稀宇科技）", model: "", apiKey: "", baseUrl: "", modelProfiles: [{
    id: "p", provider: "自定义端点（云端）", model: "deepseek/deepseek-v4.1-flash", apiKey: "mock-key", baseUrl: "https://proxy.example/v1", explicitTransport: "responses",
    modelOptions: { "deepseek/deepseek-v4.1-flash": { manualReasoning: manual } },
  }] };
  expect(loadMemoryModelConfig()).toMatchObject({ source: "inherited-main", model: "deepseek/deepseek-v4.1-flash", explicitTransport: "responses", manualReasoning: manual });
});
