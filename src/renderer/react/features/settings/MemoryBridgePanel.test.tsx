// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryBridgePanel } from "./MemoryBridgePanel";

let root: Root, host: HTMLDivElement, request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false, media: "", onchange: null }));
  request = vi.fn(async () => ({ ok: true, value: { enabled: true, configuredEnabled: true, pluginActive: true, sessions: [], paidBudgetUsd: 0 } }));
  window.memoryBridge = { request };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; delete window.memoryBridge; vi.unstubAllGlobals(); });
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(b => b.textContent?.replace(/\s/g, "") === label.replace(/\s/g, ""));
  expect(button, label).toBeDefined(); await act(async () => button!.click());
}
it("updates the saved GitHub repository only on click and keeps cancellation available", async () => {
  let finish!: (value: unknown) => void;
  request.mockImplementation(async command => command === "import-github" ? new Promise(resolve => { finish = resolve; }) : ({ ok: true, value: { sessions: [], paidBudgetUsd: 0, githubSource: { repository: "example/crp", commit: "a".repeat(40) } } }));
  await act(async () => root.render(<MemoryBridgePanel />));
  expect(request.mock.calls.map(c => c[0])).toEqual(["status"]);
  expect(host.textContent).toContain("a".repeat(40));
  await click("从 GitHub 导入／更新");
  expect(request).toHaveBeenCalledWith("import-github", { repository: "example/crp" });
  await click("取消当前导入／查询"); expect(request.mock.calls.some(c => c[0] === "cancel")).toBe(true);
  await act(async () => finish({ ok: false, error: "BRIDGE_GITHUB_CANCELLED" }));
  expect(host.textContent).toContain("当前快照保持不变");
});
it("mount reads only status and renders opt-in controls without loading or writing personal data", async () => {
  await act(async () => root.render(<MemoryBridgePanel />));
  expect(request.mock.calls.map(c => c[0])).toEqual(["status"]);
  expect(host.textContent).toContain("不自动保存对话"); expect(host.textContent).toContain("USD 0");
  expect(host.textContent).toContain("本地 BGE-M3");
  expect(host.textContent).not.toContain("fictional private memory");
});
it("v3 retrieval is explicit and the environment lock disables local-model controls", async () => {
  request.mockImplementation(async () => ({ ok: true, value: { enabled: true, configuredEnabled: true, sessions: [], paidBudgetUsd: 0, localModelsDisabled: true, localSemanticEnabled: true, retrievalV3Enabled: false } }));
  await act(async () => root.render(<MemoryBridgePanel />));
  const labels = [...host.querySelectorAll("label")];
  const local = labels.find(label => label.textContent?.includes("本地 BGE-M3"))?.querySelector("input");
  expect(local?.disabled).toBe(true); expect(local?.checked).toBe(false);
  expect(request.mock.calls.map(c => c[0])).toEqual(["status"]);
  const retrieval = labels.find(label => label.textContent?.includes("试用 CRP 3.0"))?.querySelector("input");
  expect(retrieval).toBeDefined(); await act(async () => retrieval!.click());
  expect(request).toHaveBeenCalledWith("retrieval-v3", { enabled: true });
  expect(request.mock.calls.some(c => c[0] === "local-semantic")).toBe(false);
});
it("does not dispatch a new retrieval command to an older running main process", async () => {
  await act(async () => root.render(<MemoryBridgePanel />));
  const retrieval = [...host.querySelectorAll("label")].find(label => label.textContent?.includes("试用 CRP 3.0"))?.querySelector("input");
  expect(retrieval?.disabled).toBe(true);
  expect(host.textContent).toContain("正常重启 Cyrene");
  expect(request.mock.calls.map(c => c[0])).toEqual(["status"]);
});
it("scope creation requires an explicit in-app confirmation; cancelling does not create a session", async () => {
  await act(async () => root.render(<MemoryBridgePanel />));
  await click("创建并打开隔离会话");
  expect(document.body.textContent).toContain("CRP 查询结果可能发送到");
  await click("取消");
  expect(request.mock.calls.some(c => c[0] === "new-session")).toBe(false);
});
it("import is an explicit command and cancel remains available while importing", async () => {
  let resolve!: (value: unknown) => void;
  request.mockImplementation(async command => command === "import" ? new Promise(done => { resolve = done; }) : ({ ok: true, value: { enabled: false, sessions: [], paidBudgetUsd: 0 } }));
  await act(async () => root.render(<MemoryBridgePanel />));
  await click("选择 CRP 本地副本并导入快照");
  await click("取消当前导入／查询");
  expect(request.mock.calls.filter(c => c[0] === "import")).toHaveLength(1); expect(request.mock.calls.some(c => c[0] === "cancel")).toBe(true);
  await act(async () => resolve({ ok: true, cancelled: true }));
});
