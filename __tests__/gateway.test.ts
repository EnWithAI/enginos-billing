/**
 * The LiteLLM team cap — the gate that stops spend once prepaid credits run out.
 *
 * The questions, same as everywhere else in this suite: can a tenant spend more
 * than they bought (a cap too high, or a spend counter that resets), or less (a
 * cap that forgot a grant)?
 *
 * The cap used to be computed from a local ledger. It is now computed from
 * Chargebee's live grant blocks, so the number that drives enforcement and the
 * number the customer bought cannot disagree — which is what the ledger, with
 * its hand-written expiry entries, existed to keep in step.
 */

import { describe, expect, it, vi } from "vitest";

import { createAccountService } from "@/services/account.service";
import {
  BASELINE_TERM,
  BILLING_MANAGED,
  BLOCK_REASON,
  SPEND_BASELINE,
  createGatewayBudget,
} from "@/services/gateway-budget.service";
import { createGatewayClient, type GatewayClient, type GatewayTeam } from "@/integrations/litellm/client";
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

/**
 * Chargebee as the cap sees it: `granted` is the sum of the subscription's LIVE
 * grant blocks, which is what `grantedCredits()` returns. A renewal changes it
 * by expiring one block and issuing another — here, by assignment.
 */
function rig() {
  const prisma = makeFakePrisma();
  const gateway = new FakeGateway();
  const state = { granted: "1000" };
  const budget = createGatewayBudget({
    gateway,
    usdPerCredit: RATE,
    grantedCreditsFor: async () => state.granted,
    teamIdFor: async () => TEAM,
  });
  return { prisma, gateway, budget, state };
}

describe("gateway budget", () => {
  it("caps the team at its spend so far plus the credits bought, and stops the rolling reset", async () => {
    const r = rig();
    r.gateway.team_.spend = 0.4; // free-plan usage before subscribing — not the customer's credits
    r.state.granted = "1000"; // $1.00 at 0.001/credit

    const result = await r.budget.push(TENANT);

    expect(result).toEqual({ teamId: TEAM, maxBudget: 1.4, changed: true });
    expect(r.gateway.updates).toEqual([
      {
        team_id: TEAM,
        max_budget: 1.4,
        budget_duration: null,
        metadata: { plan: "free", [BILLING_MANAGED]: true, [SPEND_BASELINE]: 0.4 },
        // Sent whenever a push is meant to open the team — see the race below.
        blocked: false,
      },
    ]);
  });

  it("opens the team even when its own read saw it open — a block that lands after the read is overridden", async () => {
    // C50: two activations run after every checkout. One's push reads the team
    // (open), the other's failed push blocks it, then the first writes its cap.
    // A write that sent `blocked` only when ITS read had seen a block left the
    // team blocked under an account the first one then marked active.
    const r = rig();
    const read = r.gateway.team.bind(r.gateway);
    r.gateway.team = async (teamId: string) => {
      const team = await read(teamId);
      r.gateway.team_.blocked = true; // the other activation's block lands now
      return team;
    };

    await r.budget.push(TENANT);

    expect(r.gateway.team_.blocked).toBe(false);
  });

  it("keeps the first baseline, so later pushes do not forgive spend", async () => {
    const r = rig();
    r.gateway.team_.spend = 0.4;
    await r.budget.push(TENANT);

    r.gateway.team_.spend = 0.9; // $0.50 of the credits used
    r.state.granted = "2000"; // a top-up block
    const result = await r.budget.push(TENANT);

    expect(result.maxBudget).toBe(2.4); // 0.4 baseline + $2.00 bought, not 0.9 + 2.00
  });

  it("drops the old term's credits at renewal, because Chargebee no longer reports them", async () => {
    const r = rig();
    r.state.granted = "1000";
    await r.budget.push(TENANT);
    expect(r.gateway.team_.maxBudget).toBe(1);

    // The renewal expires last term's block and issues a new one. The live
    // total is one term's worth, not two — which is the whole reason
    // grantedCredits() excludes expired blocks. Summing every block ever issued
    // would leave the customer spendable credit they no longer own.
    r.state.granted = "1000";
    const result = await r.budget.push(TENANT);

    expect(result.maxBudget).toBe(1);
  });

  it("moves the baseline up to the spend so far when the term moves on, so a renewal opens with the whole new grant", async () => {
    // C37: the expired block drops out of the live sum, but what it paid for
    // stays in the team's cumulative spend. With the first baseline kept for
    // ever, a customer who used term 1 up renewed into a team with no room.
    const r = rig();
    const term1 = new Date("2026-09-16T12:00:00Z");
    const term2 = new Date("2026-10-16T12:00:00Z");
    r.gateway.team_.spend = 0.4; // free-plan spend before the subscription
    await r.budget.push(TENANT, { termStart: term1 });
    expect(r.gateway.team_.metadata).toMatchObject({ [SPEND_BASELINE]: 0.4, [BASELINE_TERM]: term1.toISOString() });

    r.gateway.team_.spend = 1.4; // term 1's 1000 credits, all used
    r.state.granted = "1000"; // Chargebee: term 1's block expired, term 2's issued

    const renewed = await r.budget.push(TENANT, { termStart: term2 });
    expect(renewed.maxBudget).toBe(2.4); // 1.4 already spent + term 2's $1.00
    expect(r.gateway.team_.metadata).toMatchObject({ [SPEND_BASELINE]: 1.4, [BASELINE_TERM]: term2.toISOString() });

    // The same renewal seen again — redelivery, pull, daily repair — moves nothing.
    r.gateway.team_.spend = 1.7;
    const again = await r.budget.push(TENANT, { termStart: term2 });
    expect(again).toMatchObject({ maxBudget: 2.4, changed: false });

    // Nor does a push that names no term, or a stale read of the OLD term.
    expect((await r.budget.push(TENANT)).maxBudget).toBe(2.4);
    expect((await r.budget.push(TENANT, { termStart: term1 })).maxBudget).toBe(2.4);
    expect(r.gateway.team_.metadata[BASELINE_TERM]).toBe(term2.toISOString());
  });

  it("a team billing already manages, from before terms were recorded, keeps its baseline and starts recording the term", async () => {
    const r = rig();
    r.gateway.team_.spend = 0.3;
    await r.budget.push(TENANT); // no term: the pre-existing shape
    r.gateway.team_.spend = 0.8;

    const result = await r.budget.push(TENANT, { termStart: new Date("2026-09-16T12:00:00Z") });

    expect(result.maxBudget).toBe(1.3); // the stored 0.3, not the current 0.8
    expect(r.gateway.team_.metadata[BASELINE_TERM]).toBe("2026-09-16T12:00:00.000Z");
  });

  it("does not write when the gateway already holds the cap", async () => {
    const r = rig();
    await r.budget.push(TENANT);

    const again = await r.budget.push(TENANT);

    expect(again.changed).toBe(false);
    expect(r.gateway.updates).toHaveLength(1);
  });

  it("hands the team back to its plan on release, keeping LiteLLM's own metadata", async () => {
    const r = rig();
    r.gateway.team_.metadata = { plan: "free", guardrails: ["pii"] };
    await r.budget.push(TENANT, { termStart: new Date("2026-09-16T12:00:00Z") });

    expect(await r.budget.release(TENANT)).toEqual({ released: true });
    expect(r.gateway.team_.metadata).toEqual({ plan: "free", guardrails: ["pii"] });
    expect(await r.budget.release(TENANT)).toEqual({ released: false });
  });

  it("fails loudly when the tenant has no LiteLLM team", async () => {
    const r = rig();
    const budget = createGatewayBudget({
      gateway: r.gateway,
      usdPerCredit: RATE,
      grantedCreditsFor: async () => "1000",
      teamIdFor: async () => null,
    });

    await expect(budget.push(TENANT)).rejects.toThrow(/no LiteLLM team/);
  });

  it("refuses to set a cap it could not read the credits for", async () => {
    // A Chargebee outage must not quietly become a cap of zero, which would cut
    // off a paying customer and look like a deliberate decision. The throw is
    // caught by activate(), which holds the account and blocks the team instead.
    const r = rig();
    const budget = createGatewayBudget({
      gateway: r.gateway,
      usdPerCredit: RATE,
      grantedCreditsFor: async () => {
        throw new Error("Chargebee unreachable");
      },
      teamIdFor: async () => TEAM,
    });

    await expect(budget.push(TENANT)).rejects.toThrow("Chargebee unreachable");
    expect(r.gateway.updates).toHaveLength(0);
  });
});

describe("gateway block", () => {
  it("records why the team is blocked, and a push reopens it only when told to", async () => {
    const r = rig();
    await r.budget.push(TENANT);

    await r.budget.block(TENANT, "exhausted");
    expect(r.gateway.team_).toMatchObject({ blocked: true, metadata: { [BLOCK_REASON]: "exhausted" } });

    // A cap change while credits are still gone must not open the team.
    r.state.granted = "1500";
    await r.budget.push(TENANT, { unblock: false });
    expect(r.gateway.team_).toMatchObject({ blocked: true, maxBudget: 1.5, metadata: { [BLOCK_REASON]: "exhausted" } });

    await r.budget.push(TENANT);
    expect(r.gateway.team_.blocked).toBe(false);
    expect(r.gateway.team_.metadata[BLOCK_REASON]).toBeUndefined();
  });
});

describe("account lifecycle drives the cap", () => {
  let usable = "1000";
  let granted = "1000";
  /** What Chargebee currently says the term is. Moved to simulate a renewal. */
  let termStart = 1789731843;

  const chargebee = {
    createCustomer: async ({ id }: { id: string }) => ({ id }),
    balance: async () => ({ unitId: "token-test", unitName: "token-test", usable, onHold: "0" }),
    grantedCredits: async () => ({ credits: granted, blocks: 1 }),
    ledgerOperations: async () => [],
    paidInvoicesFor: async () => [],
    subscriptionIdsOf: async () => ["sub_1"],
    activeSubscriptions: async () => [
      { id: "sub_1", current_term_start: termStart, current_term_end: termStart + 2678400, subscription_items: [{ item_price_id: "plan" }] },
    ],
  };

  function accountsRig() {
    usable = "1000";
    granted = "1000";
    termStart = 1789731843;
    const prisma = makeFakePrisma({ chargebeeSubscriptionId: null, ledgerUnitId: null });
    const gateway = new FakeGateway();
    const budget = createGatewayBudget({
      gateway,
      usdPerCredit: RATE,
      grantedCreditsFor: async () => granted,
      teamIdFor: async () => TEAM,
    });
    prisma._accounts.get(TENANT)!.chargebeeCustomerId = TENANT;
    const errors: Array<{ metric?: string }> = [];
    const accounts = createAccountService({
      prisma: prisma as never,
      chargebee: chargebee as never,
      usdPerCredit: RATE,
      logger: { ...quietLogger, error: (obj: unknown) => errors.push(obj as { metric?: string }) },
      pushBudget: async (tenantId, opts) => void (await budget.push(tenantId, opts)),
      blockBudget: (tenantId, reason) => budget.block(tenantId, reason),
      releaseBudget: async (tenantId) => void (await budget.release(tenantId)),
    });
    return { prisma, gateway, budget, accounts, errors };
  }

  const status = (r: ReturnType<typeof accountsRig>) => r.prisma._accounts.get(TENANT)!.status;

  it("subscribe → renew → cancel moves the cap, then hands it back", async () => {
    const r = accountsRig();

    const account = await r.accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1" });
    expect(account.status).toBe("active");
    expect(r.gateway.team_).toMatchObject({ maxBudget: 1, budgetDuration: null, blocked: false });

    // Nothing spent; Chargebee expires 1000 and grants 1000, so the cap holds.
    await r.accounts.renew({ tenantId: TENANT, subscriptionId: "sub_1" });
    expect(r.gateway.team_.maxBudget).toBe(1);

    await r.accounts.cancel(TENANT);
    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBeUndefined();
  });

  it("fails closed when the budget push fails: held activating, team blocked, cursor kept", async () => {
    // The gateway would otherwise keep the free plan's $5 cap on a 30d reset —
    // a budget nobody computed for what the customer bought.
    const r = accountsRig();
    r.gateway.down = true;
    const blocked: string[] = [];
    const accounts = createAccountService({
      prisma: r.prisma as never,
      chargebee: chargebee as never,
      usdPerCredit: RATE,
      logger: quietLogger,
      pushBudget: async (tenantId) => void (await r.budget.push(tenantId)),
      blockBudget: async (tenantId) => void blocked.push(tenantId),
    });

    const account = await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1" });

    expect(account.status).toBe("activating");
    expect(blocked).toEqual([TENANT]);
    // Paused, not lost: the credits are in Chargebee, and the cursor exists so
    // usage incurred while held is still billed once the push lands.
    expect(r.prisma._cursor).toBeDefined();
  });

  it("activates a held account once the gateway answers: cap and unblock in one update", async () => {
    const r = accountsRig();
    r.gateway.pushFails = true;
    await r.accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1" });
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

    const account = await r.accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1" });

    expect(account.status).toBe("exhausted");
    expect(r.gateway.team_).toMatchObject({ blocked: true, maxBudget: 1, metadata: { [BLOCK_REASON]: "exhausted" } });
  });

  it("new credits reopen the team, and the held usage needs no requeueing", async () => {
    const r = accountsRig();
    await r.accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1" });
    // The sweep hit an empty balance: the cursor stayed put and the team was
    // blocked. Nothing local records the refused usage — it is still in
    // ClickHouse, in front of a cursor that never moved past it.
    const stuckCursor = r.prisma._cursor!.at;
    r.prisma._accounts.get(TENANT)!.status = "exhausted";
    await r.budget.block(TENANT, "exhausted");

    // Renewal lands with a fresh balance.
    usable = "1000";
    const account = await r.accounts.renew({ tenantId: TENANT, subscriptionId: "sub_1" });

    expect(account.status).toBe("active");
    expect(r.gateway.team_.blocked).toBe(false);
    expect(r.gateway.team_.metadata[BLOCK_REASON]).toBeUndefined();
    // And the cursor is untouched, so the next tick re-reads and bills exactly
    // the usage the refused capture covered.
    expect(r.prisma._cursor!.at).toBe(stuckCursor);
  });

  it("the webhook and the post-checkout sync together set one cap, not two", async () => {
    // Measured end to end under the old design: keyed on the event id vs the
    // term, the two paths recorded the same term twice — a $4 cap for $2 of
    // credits. Both now read Chargebee, so neither can add to the other.
    const r = accountsRig();

    await r.accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1" });
    await r.accounts.syncFromChargebee(TENANT);

    expect(r.gateway.team_.maxBudget).toBe(1);
  });

  /**
   * The daily reconcile sweep calls syncFromChargebee() on every subscription.
   * It exists because a missed `subscription_renewed` leaves the gateway
   * enforcing the previous term's cap.
   */
  describe("repairing a renewal the webhook never delivered", () => {
    it("moves the cap to the new term's credits when the term has rolled over", async () => {
      const r = accountsRig();
      await r.accounts.syncSubscription({
        tenantId: TENANT,
        subscriptionId: "sub_1",
        termStart: new Date(1789731843 * 1000),
      });
      expect(r.gateway.team_.maxBudget).toBe(1);

      // Chargebee renewed on a bigger plan; no webhook arrived. The sweep is
      // the only witness, and the cap must follow what Chargebee now says.
      termStart = 1792410243;
      granted = "2500";
      usable = "2500"; // a fresh grant, nothing captured from it yet — as Chargebee reports it
      await r.accounts.syncFromChargebee(TENANT);

      expect(r.prisma._accounts.get(TENANT)!.currentTermStart).toEqual(new Date(termStart * 1000));
      expect(r.gateway.team_.maxBudget).toBe(2.5);
    });

    it("is a no-op when the term has not moved, however often it runs", async () => {
      const r = accountsRig();
      await r.accounts.syncFromChargebee(TENANT);
      const writes = r.gateway.updates.length;

      await r.accounts.syncFromChargebee(TENANT);
      await r.accounts.syncFromChargebee(TENANT);

      expect(r.gateway.updates).toHaveLength(writes);
      expect(r.gateway.team_.maxBudget).toBe(1);
    });

    it("does not treat a term start that went backwards as a renewal", async () => {
      const r = accountsRig();
      await r.accounts.syncSubscription({
        tenantId: TENANT,
        subscriptionId: "sub_1",
        termStart: new Date(1789731843 * 1000),
      });

      // A stale read, or a clock that went backwards, is not a renewal.
      termStart = 1789731843 - 86400;
      await r.accounts.syncFromChargebee(TENANT);

      expect(r.gateway.team_.maxBudget).toBe(1);
    });
  });

  it("makes no gateway call when nothing is held", async () => {
    const r = accountsRig();
    await r.accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1" });
    const before = r.gateway.calls.length;

    expect(await r.accounts.activatePending()).toEqual({ pending: 0, activated: 0 });
    expect(r.gateway.calls).toHaveLength(before);
  });

  it("goes straight to active when no gateway is configured", async () => {
    const prisma = makeFakePrisma({ chargebeeSubscriptionId: null, ledgerUnitId: null });
    const accounts = createAccountService({
      prisma: prisma as never,
      chargebee: chargebee as never,
      usdPerCredit: RATE,
      logger: quietLogger,
    });

    const account = await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1" });

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
