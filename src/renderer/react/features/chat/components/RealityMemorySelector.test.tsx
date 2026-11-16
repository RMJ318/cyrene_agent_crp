// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RealityMemorySelector } from "./RealityMemorySelector";

let root: Root, host: HTMLDivElement, request: ReturnType<typeof vi.fn>;
let selected: Record<string, string[]>;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false, media: "", onchange: null }));
  selected = { a: [], b: ["512"], draft: [] };
  request = vi.fn(async (command, input) => {
    const key = input.sessionId ?? "draft";
    if (command === "set-recall") selected[key] = [...input.realities];
    return { ok: true, value: { available: ["0", "42", "512"], realities: [...selected[key]], enabled: true, dedicated: false } };
  });
  window.memoryBridge = { request }; host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; delete window.memoryBridge; vi.unstubAllGlobals(); });
async function render(sessionId: string | undefined = "a", busy = false) { await act(async () => root.render(<RealityMemorySelector sessionId={sessionId} busy={busy} />)); }
async function open() { await act(async () => (host.querySelector("button") as HTMLButtonElement).click()); }
async function toggle(reality: string) {
  const label = [...document.querySelectorAll("label")].find(node => node.textContent?.includes(`现实 #${reality}`));
  expect(label).toBeDefined(); await act(async () => (label!.querySelector("input") as HTMLInputElement).click());
}
it("keeps the dropdown open while selecting multiple realities and deselecting independently", async () => {
  await render(); await open(); await toggle("42"); await toggle("0");
  expect(selected.a).toEqual(["42", "0"]); expect(host.textContent).toContain("现实记忆 · 2");
  expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
  await toggle("42"); expect(selected.a).toEqual(["0"]);
  expect(request.mock.calls.filter(call => call[0] === "set-recall").at(-1)?.[1]).toEqual({ sessionId: "a", realities: ["0"] });
});
it("loads each conversation's selection and stages choices on the welcome screen", async () => {
  await render(); await open(); await toggle("42");
  await render("b"); expect(host.querySelector("button")?.title).toContain("#512"); expect(host.querySelector("button")?.title).not.toContain("#42");
  await act(async () => root.render(<RealityMemorySelector />)); await open(); await toggle("0"); expect(selected.draft).toEqual(["0"]);
});
it("retains saved selection on failure and disables toggles while a model is running", async () => {
  await render(); await open(); await toggle("42");
  request.mockImplementationOnce(async () => ({ ok: false, error: "failed" }));
  await toggle("0"); expect(selected.a).toEqual(["42"]); expect(document.querySelector('[role="alert"]')?.textContent).toContain("保存失败");
  await render("a", true); expect([...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(input => input.disabled)).toBe(true);
});
