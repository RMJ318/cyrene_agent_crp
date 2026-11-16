import { expect, it, vi } from "vitest";
import { CrpModelRuntime, type ModelJob, type ModelAdapter } from "./model-runtime";
import { NO_MODEL_POLICY, type CrpModelPolicy } from "./contracts";

const route = { provider: "openai", model: "mock", identity: "mock-v1" } as const;
const policy: CrpModelPolicy = { ...NO_MODEL_POLICY, cloudAllowed: true, budgetUsd: 1, routes: { "query-rewrite": route } };
const job: ModelJob = { capability: "query-rewrite", input: "fictional question", routeIdentity: route.identity, allowCloudDisclosure: true, maxCostUsd: 0.6 };
it("does not load local or call cloud while disabled and never treats session as a background API", async () => {
  const adapter = vi.fn<ModelAdapter>(); const runtime = new CrpModelRuntime({ local: adapter, openai: adapter });
  await expect(runtime.execute(job)).rejects.toThrow("MODEL_ROUTE_UNAVAILABLE");
  runtime.configure({ ...policy, cloudAllowed: false });
  await expect(runtime.execute(job)).rejects.toThrow("MODEL_PROVIDER_DISABLED");
  runtime.configure({ ...policy, routes: { "query-rewrite": { ...route, provider: "session" } } });
  await expect(runtime.execute(job)).rejects.toThrow("REQUIRES_FOREGROUND");
  expect(adapter).not.toHaveBeenCalled();
});
it("reserves concurrent budgets and does not replenish them on configuration changes", async () => {
  let finish!: (value: { value: unknown; costUsd: number }) => void;
  const adapter = vi.fn<ModelAdapter>(async () => new Promise(resolve => { finish = resolve; }));
  const runtime = new CrpModelRuntime({ openai: adapter }); runtime.configure(policy);
  const pending = runtime.execute(job);
  await expect(runtime.execute(job)).rejects.toThrow("BUDGET_EXCEEDED");
  finish({ value: ["a"], costUsd: 0.5 }); expect(await pending).toEqual(["a"]);
  runtime.configure(policy);
  await expect(runtime.execute(job)).rejects.toThrow("BUDGET_EXCEEDED");
  expect(runtime.status()).toMatchObject({ spentUsd: 0.5, reservedUsd: 0 });
});
it("cancels in-flight disclosure when policy changes and accounts for a dispatched request", async () => {
  let finish!: (value: { value: unknown; costUsd: number }) => void;
  const runtime = new CrpModelRuntime({ openai: async () => new Promise(resolve => { finish = resolve; }) }); runtime.configure(policy);
  const pending = runtime.execute(job);
  runtime.configure({ ...policy, cloudAllowed: false }); finish({ value: "must not release", costUsd: 0.2 });
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(runtime.status()).toMatchObject({ spentUsd: 0.2, reservedUsd: 0 });
});
it("does not retry/fallback and never exposes raw provider errors", async () => {
  const other = vi.fn<ModelAdapter>(); const runtime = new CrpModelRuntime({ openai: async () => { throw new Error("secret-token private content"); }, openrouter: other }); runtime.configure(policy);
  await expect(runtime.execute(job)).rejects.toThrow("BRIDGE_MODEL_OPERATION_FAILED");
  expect(other).not.toHaveBeenCalled(); expect(runtime.status().spentUsd).toBe(0.6);
});
it("rejects changed route identity, absent disclosure permission and cancelled jobs before dispatch", async () => {
  const adapter = vi.fn<ModelAdapter>(); const runtime = new CrpModelRuntime({ openai: adapter }); runtime.configure(policy);
  await expect(runtime.execute({ ...job, routeIdentity: "another-space" })).rejects.toThrow("ROUTE_UNAVAILABLE");
  await expect(runtime.execute({ ...job, allowCloudDisclosure: false })).rejects.toThrow("PROVIDER_DISABLED");
  const abort = new AbortController(); abort.abort(); await expect(runtime.execute(job, abort.signal)).rejects.toThrow();
  expect(adapter).not.toHaveBeenCalled();
});
