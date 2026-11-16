import { assertNotAborted, fail } from "../memory-bridge/safety";
import { NO_MODEL_POLICY, type CrpModelPolicy, type ModelCapability, type ModelRoute } from "./contracts";
import type { CrpBudgetLedger } from "./budget-ledger";

export interface ModelJob {
  capability: ModelCapability;
  /** Only host-authorized payloads enter this API. Adapters cannot read files or widen scope. */
  input: unknown;
  routeIdentity: string;
  allowCloudDisclosure: boolean;
  maxCostUsd: number;
}
export interface ModelReply { value: unknown; costUsd: number }
export type ModelAdapter = (route: ModelRoute, job: ModelJob, signal: AbortSignal) => Promise<ModelReply>;

/** No default network adapter and no implicit provider fallback. A session is not a background API. */
export class CrpModelRuntime {
  private policy: CrpModelPolicy = structuredClone(NO_MODEL_POLICY);
  private controller = new AbortController();
  private spent = 0;
  private reserved = 0;
  constructor(private adapters: Partial<Record<"local" | "openai" | "openrouter", ModelAdapter>> = {}, private ledger?: { store: CrpBudgetLedger; account: string }) {}
  configure(policy: CrpModelPolicy): void {
    if (!Number.isFinite(policy.budgetUsd) || policy.budgetUsd < 0
      || [policy.localAllowed, policy.cloudAllowed, policy.sessionAllowed].some(v => typeof v !== "boolean")) fail("INVALID_MODEL_POLICY");
    for (const route of Object.values(policy.routes)) {
      if (!route || !["local", "openai", "openrouter", "session"].includes(route.provider)
        || typeof route.model !== "string" || !route.model || typeof route.identity !== "string" || !route.identity) fail("INVALID_MODEL_ROUTE");
    }
    this.controller.abort(); this.controller = new AbortController();
    this.policy = structuredClone(policy);
    // Reconfiguration does not replenish the process budget or discard in-flight reservations.
  }
  status() { return { spentUsd: this.spent, reservedUsd: this.reserved, policy: structuredClone(this.policy) }; }
  async execute(job: ModelJob, external?: AbortSignal): Promise<unknown> {
    const signal = external ? AbortSignal.any([external, this.controller.signal]) : this.controller.signal;
    assertNotAborted(signal);
    const route = this.policy.routes[job.capability];
    if (!route || route.identity !== job.routeIdentity) fail("MODEL_ROUTE_UNAVAILABLE");
    if (route.provider === "session") fail("SESSION_MODEL_REQUIRES_FOREGROUND");
    if (route.provider === "local" ? !this.policy.localAllowed : !this.policy.cloudAllowed || !job.allowCloudDisclosure) fail("MODEL_PROVIDER_DISABLED");
    const cloud = route.provider !== "local";
    if (!Number.isFinite(job.maxCostUsd) || job.maxCostUsd < 0 || cloud && job.maxCostUsd <= 0) fail("INVALID_MODEL_BUDGET");
    const reservation = cloud ? job.maxCostUsd : 0;
    if (cloud && this.spent + this.reserved + reservation > this.policy.budgetUsd) fail("MODEL_BUDGET_EXCEEDED");
    const adapter = this.adapters[route.provider];
    if (!adapter) fail("MODEL_ADAPTER_UNAVAILABLE");
    const ticket = cloud ? this.ledger?.store.reserve(this.ledger.account, this.policy.budgetUsd, reservation) : undefined;
    this.reserved += reservation;
    let accounted = false;
    try {
      const reply = await adapter(structuredClone(route), structuredClone(job), signal);
      if (!Number.isFinite(reply.costUsd) || reply.costUsd < 0 || reply.costUsd > job.maxCostUsd || !cloud && reply.costUsd !== 0) fail("MODEL_COST_INVALID");
      if (ticket) this.ledger!.store.settle(ticket, reply.costUsd);
      this.spent += reply.costUsd;
      accounted = true;
      assertNotAborted(signal);
      return reply.value;
    } catch (error) {
      // A dispatched request may be billed even when cancelled or its response is lost.
      // Keep its full reservation charged unless a valid reply already accounted for it.
      if (cloud && !accounted) this.spent += reservation;
      assertNotAborted(signal);
      throw new Error(error instanceof Error && /^BRIDGE_[A-Z_]+$/.test(error.message) ? error.message : "BRIDGE_MODEL_OPERATION_FAILED");
    } finally { this.reserved -= reservation; }
  }
}
