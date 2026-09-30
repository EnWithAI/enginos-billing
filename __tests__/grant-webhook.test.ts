/**
 * `grant_blocks_created`: credits were added to a subscription — any credits:
 * a top-up's grant, a charge or grant made by hand in the Chargebee dashboard,
 * a renewal's grant, billing's own allocate. The org is re-read at once, so its
 * LiteLLM limit rises (and an exhausted team reopens) within seconds, where a
 * grant made by hand used to wait for the daily resync.
 *
 * The event names subscriptions and no customer (MEASURED 2026-09-30), so the
 * org is found by its CURRENT subscription.
 */

import { describe, expect, it } from "vitest";

import type { ChargebeeEvent } from "@/services/webhook.service";

import { gatewayAgreesWithDb, lifecycleRig, RATE, UNIT, webhook, type LifecycleRig } from "./failure-matrix-lifecycle-webhooks-litellm.helpers";

const grantEvent = (id: string, ...subscriptionIds: string[]): ChargebeeEvent => ({
  id,
  event_type: "grant_blocks_created",
  content: { grant_blocks: subscriptionIds.map((subscription_id) => ({ subscription_id })) },
});

/** Someone grants credits by hand in the Chargebee dashboard: a live block, made by a person, and the balance up. */
function grantByHand(r: LifecycleRig, subscriptionId: string, credits: number) {
  r.cb.blocks.push({
    id: `gb_by_hand_${r.cb.blocks.length}`,
    subscription_id: subscriptionId,
    unit_id: UNIT,
    granted_amount: credits,
    status: "available",
    kind: "topup",
    created_at_ms: r.now(),
    doneBy: "someone@example.com",
  });
  r.cb.ledger.balance += credits;
}

describe("credits added in Chargebee reach the org's LiteLLM limit on grant_blocks_created", () => {
  it("a grant made by hand raises the limit at once — not at the daily resync", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1"); // the plan's 1,000
    const capBefore = r.gateway.team_.maxBudget!;

    grantByHand(r, "sub_1", 500);
    await r.deliver(grantEvent("ev_grant_1", "sub_1"));

    expect(r.gateway.team_.maxBudget).toBeCloseTo(capBefore + 500 * Number(RATE), 6);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  it("an org that ran out is reopened by the grant", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.cb.expireGrants("sub_1"); // nothing left to spend
    await r.deliver(webhook("subscription_changed", r.cb.sub("sub_1"), "ev_changed"));
    expect(r.account().status).toBe("exhausted");
    expect(r.gateway.team_.blocked).toBe(true);

    grantByHand(r, "sub_1", 500);
    await r.deliver(grantEvent("ev_grant_2", "sub_1"));

    expect(r.account().status).toBe("active");
    expect(r.gateway.team_.blocked).toBe(false);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  it("a redelivered grant event changes nothing further", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    grantByHand(r, "sub_1", 500);
    await r.deliver(grantEvent("ev_grant_3", "sub_1"));
    const cap = r.gateway.team_.maxBudget;

    await r.deliver(grantEvent("ev_grant_3", "sub_1"));
    await r.deliver(grantEvent("ev_grant_3", "sub_1"));

    expect(r.gateway.team_.maxBudget).toBe(cap);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });
});

describe("grant events billing has nothing to move for — acknowledged, never retried", () => {
  it("a subscription that is no org's current one", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    const cap = r.gateway.team_.maxBudget;

    await expect(r.deliver(grantEvent("ev_other", "sub_someone_elses"))).resolves.toBeUndefined();

    expect(r.gateway.team_.maxBudget).toBe(cap);
    expect(r.metrics()).toContain("billing.webhook.grant_unlinked_subscription");
  });

  it("Chargebee's sample data (a cbdemo_ subscription)", async () => {
    const r = lifecycleRig();
    await expect(r.deliver(grantEvent("ev_sample", "cbdemo__XpbKpmKUbu8jffPy"))).resolves.toBeUndefined();
  });

  it("an event naming no subscription at all", async () => {
    const r = lifecycleRig();
    await expect(r.deliver({ id: "ev_empty", event_type: "grant_blocks_created", content: {} })).resolves.toBeUndefined();
  });
});
