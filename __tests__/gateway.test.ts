/**
 * The LiteLLM team cap — the gate that stops spend once prepaid credits run out.
 *
 * The questions, same as everywhere else in this suite: can a tenant spend more
 * than they bought (a cap too high, or a spend counter that resets), or less (a
 * cap that forgot a grant)?
 */

import { describe, expect, it, vi } from "vitest";

import { createAccounts } from "@/lib/account";
import { ENTRY } from "@/lib/db";
import {
  BILLING_MANAGED,
  BLOCK_REASON,
  SPEND_BASELINE,
  createGatewayBudget,
  createGatewayClient,
  type GatewayClient,
  type GatewayTeam,
} from "@/lib/gateway";
import { RATE, TENANT, makeFakePrisma, quietLogger } from "./harness";

const TEAM = "org_acme_com";

/** Applies updates the way LiteLLM does: only the fields sent. */
class FakeGateway implements GatewayClient {
  team_: GatewayTeam = { spend: 0, maxBudget: 5, budgetDuration: "30d", blocked: false, metadata: { plan: "free" } };
  updates: Array<Record<string, unknown>> = [];
  /** Every write in order: "block" (blocked: true), "cap" (a max_budget write), "meta". */
  calls: string[] = [];
  /** Whole gateway unreachable. */
  down = false;
  /** Only budget writes fail — a block (no max_budget) still lands. */
  pushFails = false;

  async team(teamId: string) {
    if (this.down) throw new Error("LiteLLM /team/info failed (503)");
    return teamId === TEAM ? { ...this.team_, metadata: { ...this.team_.metadata } } : null;
  }

  async updateTeam(body: Record<string, unknown>) {
    if (this.down || (this.pushFails && "max_budget" in body)) throw new Error("LiteLLM /team/update failed (503)");
    this.updates.push(body);
    this.calls.push(body.blocked === true ? "block" : "max_budget" in body ? "cap" : "meta");
    if ("max_budget" in body) this.team_.maxBudget = body.max_budget as number;
    if ("budget_duration" in body) this.team_.budgetDuration = body.budget_duration as string | null;
    if ("metadata" in body) this.team_.metadata = body.metadata as Record<string, unknown>;
    if ("blocked" in body) this.team_.blocked = body.blocked as boolean;
  }
}

function grant(prisma: ReturnType<typeof makeFakePrisma>, credits: string, sourceRef: string) {
  prisma._entries.push({ tenantId: TENANT, entryType: ENTRY.GRANT, deltaCredits: credits, sourceRef } as never);
}

function rig() {
  const prisma = makeFakePrisma();
  const gateway = new FakeGateway();
  const budget = createGatewayBudget({
    gateway,
    usdPerCredit: RATE,
    prisma: prisma as never,
    teamIdFor: async () => TEAM,
  });
  return { prisma, gateway, budget };
}

describe("gateway budget", () => {
  it("caps the team at its spend so far plus the credits bought, and stops the rolling reset", async () => {
    const r = rig();
    r.gateway.team_.spend = 0.4; // free-plan usage before subscribing — not the customer's credits
    grant(r.prisma, "1000", "sub:1"); // $1.00 at 0.001/credit

    const result = await r.budget.push(TENANT);

    expect(result).toEqual({ teamId: TEAM, maxBudget: 1.4, changed: true });
    expect(r.gateway.updates).toEqual([
      {
        team_id: TEAM,
        max_budget: 1.4,
        budget_duration: null,
        metadata: { plan: "free", [BILLING_MANAGED]: true, [SPEND_BASELINE]: 0.4 },
      },
    ]);
  });

  it("keeps the first baseline, so later pushes do not forgive spend", async () => {
    const r = rig();
    r.gateway.team_.spend = 0.4;
    grant(r.prisma, "1000", "sub:1");
    await r.budget.push(TENANT);

    r.gateway.team_.spend = 0.9; // $0.50 of the credits used
    grant(r.prisma, "1000", "invoice:topup-1");
    const result = await r.budget.push(TENANT);

    expect(result.maxBudget).toBe(2.4); // 0.4 baseline + $2.00 bought, not 0.9 + 2.00
  });

  it("removes expired credits at renewal, so leftovers are not spendable twice", async () => {
    const r = rig();
    grant(r.prisma, "1000", "sub:term-1");
    r.prisma._entries.push({ tenantId: TENANT, entryType: ENTRY.CONSUME, deltaCredits: "-300", sourceRef: "b1" } as never);
    r.prisma._entries.push({ tenantId: TENANT, entryType: ENTRY.EXPIRY, deltaCredits: "-700", sourceRef: "renew:expiry" } as never);
    grant(r.prisma, "1000", "sub:term-2");

    const result = await r.budget.push(TENANT);

    // 2000 granted − 700 expired = 1300 spendable over the team's life; 300
    // were used in term 1, leaving exactly the new term's 1000.
    expect(result.maxBudget).toBe(1.3);
  });

  it("does not write when the gateway already holds the cap", async () => {
    const r = rig();
    grant(r.prisma, "1000", "sub:1");
    await r.budget.push(TENANT);

    const again = await r.budget.push(TENANT);

    expect(again.changed).toBe(false);
    expect(r.gateway.updates).toHaveLength(1);
  });

  it("hands the team back to its plan on release, keeping LiteLLM's own metadata", async () => {
    const r = rig();
    r.gateway.team_.metadata = { plan: "free", guardrails: ["pii"] };
    grant(r.prisma, "1000", "sub:1");
    await r.budget.push(TENANT);

    expect(await r.budget.release(TENANT)).toEqual({ released: true });
    expect(r.gateway.team_.metadata).toEqual({ plan: "free", guardrails: ["pii"] });
    expect(await r.budget.release(TENANT)).toEqual({ released: false });
  });

  it("fails loudly when the tenant has no LiteLLM team", async () => {
    const r = rig();
    const budget = createGatewayBudget({
      gateway: r.gateway,
      usdPerCredit: RATE,
      prisma: r.prisma as never,
      teamIdFor: async () => null,
    });

    await expect(budget.push(TENANT)).rejects.toThrow(/no LiteLLM team/);
  });
});

describe("gateway block", () => {
  it("records why the team is blocked, and a push reopens it only when told to", async () => {
    const r = rig();
    grant(r.prisma, "1000", "sub:1");
    await r.budget.push(TENANT);

    await r.budget.block(TENANT, "exhausted");
    expect(r.gateway.team_).toMatchObject({ blocked: true, metadata: { [BLOCK_REASON]: "exhausted" } });

    // A cap change while credits are still gone must not open the team.
    grant(r.prisma, "500", "adjust:1");
    await r.budget.push(TENANT, { unblock: false });
    expect(r.gateway.team_).toMatchObject({ blocked: true, maxBudget: 1.5, metadata: { [BLOCK_REASON]: "exhausted" } });

    await r.budget.push(TENANT);
    expect(r.gateway.team_.blocked).toBe(false);
    expect(r.gateway.team_.metadata[BLOCK_REASON]).toBeUndefined();
  });
});

describe("account lifecycle drives the cap", () => {
  let usable = "1000";
  const chargebee = {
    createCustomer: async ({ id }: { id: string }) => ({ id }),
    balance: async () => ({ unitId: "token-test", unitName: "token-test", usable, onHold: "0" }),
    grantedCredits: async () => ({ credits: "1000", blocks: 1 }),
    activeSubscriptions: async () => [
      { id: "sub_1", current_term_start: 1789731843, current_term_end: 1792410243, subscription_items: [{ item_price_id: "plan" }] },
    ],
  };

  function accountsRig() {
    usable = "1000";
    const r = rig();
    r.prisma._accounts.get(TENANT)!.chargebeeCustomerId = TENANT;
    const errors: Array<{ metric?: string }> = [];
    const accounts = createAccounts({
      prisma: r.prisma as never,
      chargebee: chargebee as never,
      usdPerCredit: RATE,
      logger: { ...quietLogger, error: (obj: unknown) => errors.push(obj as { metric?: string }) },
      pushBudget: async (tenantId, opts) => void (await r.budget.push(tenantId, opts)),
      blockBudget: (tenantId, reason) => r.budget.block(tenantId, reason),
      releaseBudget: async (tenantId) => void (await r.budget.release(tenantId)),
    });
    return { ...r, accounts, errors };
  }

  const grantsOf = (r: ReturnType<typeof accountsRig>) =>
    r.prisma._entries.filter((e: { entryType: string }) => e.entryType === ENTRY.GRANT);

  const status = (r: ReturnType<typeof accountsRig>) => r.prisma._accounts.get(TENANT)!.status;

  it("subscribe → renew → cancel moves the cap, then hands it back", async () => {
    const r = accountsRig();

    const account = await r.accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "evt_1" });
    expect(account.status).toBe("active");
    expect(r.gateway.team_).toMatchObject({ maxBudget: 1, budgetDuration: null, blocked: false });

    // Nothing spent, so renewal expires all 1000 and grants 1000: cap unchanged.
    await r.accounts.renew({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "evt_renew" });
    expect(r.gateway.team_.maxBudget).toBe(1);

    await r.accounts.cancel(TENANT);
    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBeUndefined();
  });

  it("fails closed when the budget push fails: held activating, team blocked, credits kept", async () => {
    // The gateway would otherwise keep the free plan's $5 cap on a 30d reset —
    // a budget nobody computed for what the customer bought.
    const r = accountsRig();
    r.gateway.down = true;
    const blocked: string[] = [];
    const accounts = createAccounts({
      prisma: r.prisma as never,
      chargebee: chargebee as never,
      usdPerCredit: RATE,
      logger: quietLogger,
      pushBudget: async (tenantId) => void (await r.budget.push(tenantId)),
      blockBudget: async (tenantId) => void blocked.push(tenantId),
    });

    const account = await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "evt_1" });

    expect(account.status).toBe("activating");
    expect(blocked).toEqual([TENANT]);
    // Paid for, so recorded — paused, not lost.
    expect(r.prisma._entries.filter((e: { entryType: string }) => e.entryType === ENTRY.GRANT)).toHaveLength(1);
  });

  it("activates a held account once the gateway answers: cap and unblock in one update", async () => {
    const r = accountsRig();
    r.gateway.pushFails = true;
    await r.accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "evt_1" });
    expect(status(r)).toBe("activating");
    expect(r.errors.map((e) => e.metric)).toContain("billing.budget.push_failed");
    expect(r.gateway.team_).toMatchObject({ blocked: true, metadata: { [BLOCK_REASON]: "activating" } });

    // Still failing on the next tick: stays held.
    expect(await r.accounts.activatePending()).toEqual({ pending: 1, activated: 0 });
    expect(status(r)).toBe("activating");

    r.gateway.pushFails = false;
    expect(await r.accounts.activatePending()).toEqual({ pending: 1, activated: 1 });

    expect(status(r)).toBe("active");
    expect(r.gateway.team_).toMatchObject({ maxBudget: 1, budgetDuration: null, blocked: false });
    expect(r.gateway.team_.metadata[BLOCK_REASON]).toBeUndefined();
    // Blocked on each failed attempt; on success the cap and the unblock land
    // in ONE update, so the team never opens under a stale budget.
    expect(r.gateway.calls).toEqual(["block", "block", "cap"]);
    expect(r.gateway.updates.at(-1)).toMatchObject({ max_budget: 1, budget_duration: null, blocked: false });
  });

  it("keeps the team blocked and the account exhausted when Chargebee credits are used up", async () => {
    const r = accountsRig();
    usable = "0";

    const account = await r.accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "evt_1" });

    expect(account.status).toBe("exhausted");
    expect(r.gateway.team_).toMatchObject({ blocked: true, maxBudget: 1, metadata: { [BLOCK_REASON]: "exhausted" } });
  });

  it("new credits after exhaustion reopen the team and requeue the window Chargebee refused", async () => {
    const r = accountsRig();
    await r.accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "sub:sub_1:1" });
    // The sweep hit an empty balance: window held as failed, team blocked.
    r.prisma._batches.set("held", {
      id: "held", tenantId: TENANT, kind: "window", status: "failed", attempts: 1,
      lastError: "insufficient credits: Not enough balance exists in the account.",
      windowStart: new Date(0), windowEnd: new Date(60_000), consumeCredits: "5", billedUsd: "0.005",
    } as never);
    r.prisma._accounts.get(TENANT)!.status = "exhausted";
    await r.budget.block(TENANT, "exhausted");

    // Renewal lands with a fresh balance.
    usable = "1000";
    const account = await r.accounts.renew({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "sub:sub_1:2" });

    expect(account.status).toBe("active");
    expect(r.gateway.team_.blocked).toBe(false);
    expect(r.gateway.team_.metadata[BLOCK_REASON]).toBeUndefined();
    expect(r.prisma._batches.get("held")).toMatchObject({ status: "pending", attempts: 0, lastError: null });
  });

  it("grants a term ONCE when the webhook and the post-checkout sync both fire", async () => {
    // Measured end to end: keyed on the event id vs the term, the two paths
    // recorded the same term twice — a $4 cap for $2 of credits.
    const r = accountsRig();
    const { termGrantRef } = await import("@/lib/account");

    await r.accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: termGrantRef("sub_1", 1789731843) });
    await r.accounts.syncFromChargebee(TENANT);

    expect(grantsOf(r)).toHaveLength(1);
    expect(r.gateway.team_.maxBudget).toBe(1);
  });

  it("renewal does not expire a new term that a repair sync already granted", async () => {
    const r = accountsRig();
    await r.accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "sub:sub_1:1" });
    // A repair sync ran after the term rolled over, before the renewal webhook.
    await r.accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "sub:sub_1:2" });

    await r.accounts.renew({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "sub:sub_1:2" });

    const expiry = r.prisma._entries.find((e: { entryType: string }) => e.entryType === ENTRY.EXPIRY);
    expect(Number(expiry?.deltaCredits)).toBe(-1000); // term 1's leftover only
    expect(r.gateway.team_.maxBudget).toBe(1); // 2000 granted − 1000 expired
  });

  it("makes no gateway call when nothing is held", async () => {
    const r = accountsRig();
    await r.accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "evt_1" });
    const before = r.gateway.calls.length;

    expect(await r.accounts.activatePending()).toEqual({ pending: 0, activated: 0 });
    expect(r.gateway.calls).toHaveLength(before);
  });

  it("goes straight to active when no gateway is configured", async () => {
    const r = rig();
    const accounts = createAccounts({
      prisma: r.prisma as never,
      chargebee: chargebee as never,
      usdPerCredit: RATE,
      logger: quietLogger,
    });

    const account = await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "evt_1" });

    expect(account.status).toBe("active");
  });
});

describe("LiteLLM client", () => {
  it("sends budget_duration as an explicit null, which is what clears the reset", async () => {
    // LiteLLM applies only the fields present. Dropping the key instead of
    // sending null would leave the plan's 30d reset in place.
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createGatewayClient({ baseUrl: "http://gw.test:4000/", masterKey: "sk-master", fetchImpl });

    await client.updateTeam({ team_id: TEAM, max_budget: 1, budget_duration: null });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gw.test:4000/team/update");
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-master" });
    expect(JSON.parse(init.body as string)).toEqual({ team_id: TEAM, max_budget: 1, budget_duration: null });
  });

  it("reads a missing team as null rather than an error", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 404 }));
    const client = createGatewayClient({ baseUrl: "http://gw.test:4000", masterKey: "k", fetchImpl });

    expect(await client.team("nope")).toBeNull();
  });
});
