/**
 * The free plan's credits, granted ONCE per org by billing (FREE_PLAN_CREDITS).
 *
 * The free plan is a yearly plan, and a plan's own Credit Grant is issued again
 * at every renewal. So its grant is set to zero in the Chargebee catalogue and
 * billing allocates the credits itself the first time the org is linked —
 * once, whatever is retried, redelivered or renewed. An org the plan already
 * granted (put on it before the change) is recorded, never granted again.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig, resetConfig } from "@/config/config";
import { FREE_PLAN_GRANT } from "@/repositories/topup-grant.repository";
import { FREE_PLAN_CREDITS_YEARS } from "@/services/account.service";

import {
  gatewayAgreesWithDb,
  INR_FREE,
  lifecycleRig,
  PLAN_B,
  T0,
  TENANT,
  UNIT,
  USD_FREE,
  webhook,
  type LifecycleRig,
} from "./failure-matrix-lifecycle-webhooks-litellm.helpers";

const FREE = "5000";
const KEY = `free-plan-credits:${TENANT}`;
const rows = (r: LifecycleRig) => [...r.prisma._topUps.values()];

/** A new org on the free plan, whose Credit Grant in Chargebee is now zero. */
async function newFreeOrg(prepare?: (r: LifecycleRig) => void) {
  const r = lifecycleRig({ freePlanCredits: FREE });
  prepare?.(r);
  await r.subscribe("sub_1", { credits: 0 });
  return r;
}

describe("a new org on the free plan", () => {
  it("is granted FREE_PLAN_CREDITS once, and its team opens with them", async () => {
    const r = await newFreeOrg();

    expect(r.cb.allocations).toEqual([
      expect.objectContaining({ subscriptionId: "sub_1", unitId: UNIT, amount: FREE, idempotencyKey: KEY }),
    ]);
    expect(r.cb.liveCredits("sub_1")).toBe(5000);
    expect(rows(r)).toEqual([expect.objectContaining({ invoiceId: FREE_PLAN_GRANT, status: "APPLIED", source: "allocation" })]);
    expect(r.account().status).toBe("active");
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  it(`gives them an expiry ${FREE_PLAN_CREDITS_YEARS} years out — in effect, they last until used`, async () => {
    const r = await newFreeOrg();

    const tenYears = new Date(T0);
    tenYears.setUTCFullYear(tenYears.getUTCFullYear() + FREE_PLAN_CREDITS_YEARS);
    expect(r.cb.allocations[0]!.expiresAt).toBe(tenYears.getTime() / 1000);
  });

  it("grants nothing more on a redelivered webhook, the daily resync or a renewal", async () => {
    const r = await newFreeOrg();

    await r.deliver(webhook("subscription_created", r.cb.sub("sub_1"), "ev_again"));
    await r.at(60).accounts.resyncAll();
    const sub = r.cb.sub("sub_1");
    r.cb.renew("sub_1", { start: sub.current_term_end, credits: 0 });
    await r.deliver(webhook("subscription_renewed", r.cb.sub("sub_1")));

    expect(r.cb.allocateCalls).toHaveLength(1);
    expect(r.cb.liveCredits("sub_1")).toBe(5000); // still live after the renewal
  });

  it("is not granted again after a cancellation and a new free subscription", async () => {
    const r = await newFreeOrg();
    r.cb.cancel("sub_1");
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
    expect(r.account().status).toBe("cancelled");

    await r.at(10).subscribe("sub_2", { credits: 0 });

    expect(r.account().chargebeeSubscriptionId).toBe("sub_2");
    expect(r.cb.allocations).toHaveLength(1);
  });

  it("grants once when the webhook and the post-signup link run at the same time", async () => {
    const r = lifecycleRig({ freePlanCredits: FREE });
    const sub = r.cb.subscribe("sub_1", { credits: 0 });

    await Promise.all([r.deliver(webhook("subscription_created", sub)), r.accounts.syncFromChargebee(TENANT)]);
    await r.at(1).tick();

    expect(r.cb.allocations).toHaveLength(1);
    expect(r.account().status).toBe("active");
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });
});

describe("when the allocate does not go through", () => {
  it("a failed allocate holds the org activating with its team blocked; the next tick grants it and opens the team", async () => {
    const r = await newFreeOrg((rig) => rig.cb.allocateFaults.push("unreachable"));

    expect(r.cb.allocations).toHaveLength(0);
    expect(r.account().status).toBe("activating");
    expect(r.gateway.team_.blocked).toBe(true);
    expect(r.metrics()).toContain("billing.free_credits.failed");

    await r.at(1).tick();

    expect(r.cb.allocations).toHaveLength(1);
    expect(r.account().status).toBe("active");
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  it("a refused allocate keeps the org held, and is tried again every tick until it goes through", async () => {
    const r = await newFreeOrg((rig) => rig.cb.allocateFaults.push("refuse", "refuse"));
    expect(r.account().status).toBe("activating");

    await r.at(1).tick();
    expect(r.account().status).toBe("activating");
    expect(r.gateway.team_.blocked).toBe(true);

    await r.at(2).tick();
    expect(r.cb.allocations).toHaveLength(1);
    expect(r.account().status).toBe("active");
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  it("a grant whose answer was lost is replayed under the same key — granted once", async () => {
    const r = await newFreeOrg((rig) => rig.cb.allocateFaults.push("lose-response"));
    expect(rows(r)[0]).toMatchObject({ status: "PENDING" });

    await r.at(5).deliver(webhook("subscription_created", r.cb.sub("sub_1"), "ev_again"));

    expect(r.cb.allocateCalls.map((c) => c.idempotencyKey)).toEqual([KEY, KEY]);
    expect(r.cb.allocations).toHaveLength(1);
    expect(rows(r)[0]).toMatchObject({ status: "APPLIED" });
  });

  it("past the key's window, a lost grant is found among the grant blocks — nothing sent again", async () => {
    const r = await newFreeOrg((rig) => rig.cb.allocateFaults.push("lose-response"));

    await r.at(40).deliver(webhook("subscription_created", r.cb.sub("sub_1"), "ev_again"));

    expect(r.cb.allocateCalls).toHaveLength(1);
    expect(rows(r)[0]).toMatchObject({ status: "APPLIED", chargebeeRef: expect.stringMatching(/^grant_block:/) });
  });

  it("a grant block list cut short allocates nothing — it cannot tell the plan did not grant", async () => {
    const r = await newFreeOrg((rig) => {
      rig.cb.grantBlocksIncomplete = true;
    });

    expect(r.cb.allocateCalls).toHaveLength(0);
    expect(r.account().status).toBe("activating");
    expect(r.metrics()).toContain("billing.free_credits.unresolved");

    r.cb.grantBlocksIncomplete = false;
    await r.at(1).tick();

    expect(r.cb.allocations).toHaveLength(1);
    expect(r.account().status).toBe("active");
  });
});

describe("the credit wallet", () => {
  it("a plan that grants zero gets no wallet from Chargebee: the allocate makes one in FREE_PLAN_CREDIT_UNIT, and the account adopts it", async () => {
    const r = lifecycleRig({ freePlanCredits: FREE });
    const sub = r.cb.subscribe("sub_1", { credits: 0 });
    expect(r.cb.wallets.has("sub_1")).toBe(false);

    await r.deliver(webhook("subscription_created", sub));

    expect(r.cb.allocations).toEqual([expect.objectContaining({ unitId: UNIT, amount: FREE })]);
    expect(r.cb.wallets.has("sub_1")).toBe(true);
    expect(r.account()).toMatchObject({ ledgerUnitId: UNIT, status: "active" });
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  it("with no wallet and no FREE_PLAN_CREDIT_UNIT, nothing is granted — and the org is held, not opened on nothing", async () => {
    const r = lifecycleRig({ freePlanCredits: FREE, freePlanCreditUnit: "" });
    await r.subscribe("sub_1", { credits: 0 });

    expect(r.cb.allocateCalls).toHaveLength(0);
    expect(r.metrics()).toContain("billing.free_credits.no_credit_unit");
    expect(r.account().status).toBe("activating");
    expect(r.gateway.team_.blocked).toBe(true);
  });

  it("a failed allocate on a wallet-less org holds it until the retry creates the wallet", async () => {
    const r = await newFreeOrg((rig) => rig.cb.allocateFaults.push("unreachable"));
    expect(r.account()).toMatchObject({ ledgerUnitId: null, status: "activating" });

    await r.at(1).tick();

    expect(r.account()).toMatchObject({ ledgerUnitId: UNIT, status: "active" });
    expect(r.cb.allocations).toHaveLength(1);
  });
});

describe("what the plan's own grant already gave", () => {
  it("a plan that keeps a single token (so Chargebee opens a wallet) — billing adds the rest, FREE_PLAN_CREDITS in all", async () => {
    const r = lifecycleRig({ freePlanCredits: FREE });
    await r.subscribe("sub_1", { credits: 1 });

    expect(r.cb.allocations).toEqual([expect.objectContaining({ amount: "4999", unitId: UNIT })]);
    expect(r.cb.liveCredits("sub_1")).toBe(5000);
    expect(rows(r)).toEqual([expect.objectContaining({ status: "APPLIED", source: "allocation", credits: "4999" })]);
  });

  it("an org the plan gave less than FREE_PLAN_CREDITS is topped up to it", async () => {
    const r = lifecycleRig({ freePlanCredits: FREE });
    await r.subscribe("sub_1"); // the plan's old grant: 1,000

    expect(r.cb.allocations).toEqual([expect.objectContaining({ amount: "4000" })]);
    expect(r.cb.liveCredits("sub_1")).toBe(5000);
  });

  it("an org the plan already gave FREE_PLAN_CREDITS is recorded from its block — nothing allocated, now or later", async () => {
    const r = lifecycleRig({ freePlanCredits: FREE });
    await r.subscribe("sub_1", { credits: 5000 }); // put on the plan before its grant was cut

    await r.at(60).accounts.resyncAll();

    expect(r.cb.allocateCalls).toHaveLength(0);
    expect(rows(r)).toEqual([
      expect.objectContaining({ invoiceId: FREE_PLAN_GRANT, status: "APPLIED", source: "catalogue_grant", credits: "5000" }),
    ]);
    expect(r.account().status).toBe("active");
  });
});

describe("orgs that get nothing from it", () => {
  it("an org on a paid plan", async () => {
    const r = lifecycleRig({ freePlanCredits: FREE });
    await r.subscribe("sub_1", { plan: PLAN_B });

    expect(r.cb.allocateCalls).toHaveLength(0);
    expect(rows(r)).toEqual([]);
  });

  it("every org, when FREE_PLAN_CREDITS is not set", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 0 });

    expect(r.cb.allocateCalls).toHaveLength(0);
    expect(rows(r)).toEqual([]);
  });
});

describe("which unit syncSubscription links when FREE_PLAN_CREDITS is off", () => {
  it("a free plan that grants zero, with no wallet: linked to FREE_PLAN_CREDIT_UNIT on 0 credits, nothing allocated", async () => {
    const r = lifecycleRig({ freePlanCredits: "" });
    await r.subscribe("sub_1", { credits: 0 });

    expect(r.cb.wallets.has("sub_1")).toBe(false);
    expect(r.cb.allocateCalls).toHaveLength(0);
    expect(rows(r)).toEqual([]);
    expect(r.account()).toMatchObject({ chargebeeSubscriptionId: "sub_1", ledgerUnitId: UNIT, status: "active" });
  });

  it("a subscription that holds a wallet keeps its own unit, whatever FREE_PLAN_CREDIT_UNIT says", async () => {
    const r = lifecycleRig({ freePlanCredits: "", freePlanCreditUnit: "other-unit" });
    await r.subscribe("sub_1", { credits: 1 });

    expect(r.account()).toMatchObject({ ledgerUnitId: UNIT, status: "active" });
    expect(r.cb.allocateCalls).toHaveLength(0);
  });

  it("a paid plan that grants zero is not given the free plan's unit", async () => {
    const r = lifecycleRig({ freePlanCredits: "" });
    await r.subscribe("sub_1", { plan: PLAN_B, credits: 0 });

    expect(r.account()).toMatchObject({ chargebeeSubscriptionId: "sub_1", ledgerUnitId: null });
    expect(r.cb.allocateCalls).toHaveLength(0);
  });
});

describe("FREE_PLAN_CREDITS", () => {
  const KEYS = ["FREE_PLAN_CREDITS", "FREE_PLAN_CREDIT_UNIT", "CHARGEBEE_SITE", "CHARGEBEE_API_KEY", "CLICKHOUSE_PASSWORD"];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.CHARGEBEE_SITE = "site-test";
    process.env.CHARGEBEE_API_KEY = "test_key_123";
    process.env.CLICKHOUSE_PASSWORD = "pw";
    delete process.env.FREE_PLAN_CREDITS;
    delete process.env.FREE_PLAN_CREDIT_UNIT;
    resetConfig();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfig();
  });

  it("is off when not set", () => {
    expect(getConfig().freePlanCredits).toBe("");
  });

  it("reads a positive number, with the unit the credits go into", () => {
    process.env.FREE_PLAN_CREDITS = " 5000 ";
    process.env.FREE_PLAN_CREDIT_UNIT = "token-test";
    expect(getConfig()).toMatchObject({ freePlanCredits: "5000", freePlanCreditUnit: "token-test" });
  });

  it("refuses FREE_PLAN_CREDITS without FREE_PLAN_CREDIT_UNIT — a zero-grant plan has no wallet to take one from", () => {
    process.env.FREE_PLAN_CREDITS = "5000";
    expect(() => getConfig()).toThrow(/FREE_PLAN_CREDIT_UNIT is not set/);
  });

  // OBSERVED LIVE 2026-10-01: an operator turning the grant off wrote
  // FREE_PLAN_CREDITS=0, and the refusal took every billing route down.
  it.each(["0", "0.0", "00"])("takes %s as off, like empty — never a boot failure", (value) => {
    process.env.FREE_PLAN_CREDITS = value;
    expect(getConfig().freePlanCredits).toBe("");
  });

  it.each(["-10", "abc", "10k"])("refuses %s", (value) => {
    process.env.FREE_PLAN_CREDITS = value;
    expect(() => getConfig()).toThrow(/FREE_PLAN_CREDITS must be a number greater than zero/);
  });
});

describe("every currency's free plan is the free plan (FREE_PLAN_ITEM_PRICE_ID_<CUR>)", () => {
  // OBSERVED LIVE 2026-10-01: an org put on the USD free plan showed 2 credits
  // with FREE_PLAN_CREDITS=1 — the plan's own 1-credit block (MEASURED: the
  // USD free plan grants 1 token-test on creation) was not counted, because
  // only the INR plan was "the free plan", and billing allocated another 1.
  it("counts the USD plan's own grant: it grants 1, FREE_PLAN_CREDITS is 1 — nothing is allocated", async () => {
    const r = lifecycleRig({ freePlanCredits: "1", freeItemPriceIds: [USD_FREE, INR_FREE] });

    await r.subscribe("sub_1", { plan: USD_FREE });

    expect(r.cb.allocateCalls).toEqual([]);
    expect(r.cb.liveCredits("sub_1")).toBe(1);
    expect(rows(r)).toEqual([expect.objectContaining({ invoiceId: FREE_PLAN_GRANT, source: "catalogue_grant", status: "APPLIED", credits: "1" })]);
    expect(r.account()).toMatchObject({ status: "active", currency: "USD" });
  });

  it("tops the USD plan's grant up to FREE_PLAN_CREDITS, never past it", async () => {
    const r = lifecycleRig({ freePlanCredits: "5", freeItemPriceIds: [USD_FREE, INR_FREE] });

    await r.subscribe("sub_1", { plan: USD_FREE });

    expect(r.cb.allocateCalls).toEqual([expect.objectContaining({ subscriptionId: "sub_1", amount: "4" })]);
    expect(r.cb.liveCredits("sub_1")).toBe(5);
  });

  it("grants the INR plan, which grants nothing itself, the whole of FREE_PLAN_CREDITS — once, as before", async () => {
    const r = lifecycleRig({ freePlanCredits: "1", freeItemPriceIds: [USD_FREE, INR_FREE] });

    await r.subscribe("sub_1", { plan: INR_FREE });

    expect(r.cb.allocateCalls).toEqual([expect.objectContaining({ subscriptionId: "sub_1", amount: "1", unitId: UNIT })]);
    expect(r.cb.liveCredits("sub_1")).toBe(1);
    expect(r.account()).toMatchObject({ status: "active", currency: "INR" });
  });
});
