/**
 * Failure matrix — lifecycle, webhooks and LiteLLM (C34–C43, C47–C54, C57).
 *
 * Drives the REAL account, gateway-budget, webhook and usage-sync services
 * together (see failure-matrix-lifecycle-webhooks-litellm.helpers.ts), so one
 * test can follow a subscription from a Chargebee webhook, through the LiteLLM
 * team cap, to the usage that is captured against it.
 *
 * Every test asserts the CORRECT behaviour. Where the product does not do it,
 * the test is `it.fails` with a `// DEFECT:` note, so the suite stays green and
 * the defect stays documented — the day it is fixed, the `it.fails` turns red
 * and must be flipped back to `it`.
 *
 * Already covered elsewhere (each case still gets a focused test here):
 *   C34  usage-sync "bills the window and moves the cursor to its end";
 *        webhook "links the subscription and lays down the billing cursor";
 *        gateway "caps the team at its spend so far plus the credits bought…"
 *   C35  usage-sync "does not bill a cancelled subscription";
 *        compound-flows "a full incident … → cancelled"
 *   C37  account-lifecycle "a renewal re-reads Chargebee without rewinding or skipping the cursor"
 *   C38  gateway "drops the old term's credits at renewal, because Chargebee no longer reports them"
 *   C39/C42  webhook "converges rather than doubling when the same event is delivered twice";
 *        account-lifecycle "converges rather than compounding when the webhook and the pull both fire"
 *   C40  gateway "repairing a renewal the webhook never delivered" (renewal only)
 *   C41  gateway "the webhook and the post-checkout sync together set one cap, not two"
 *   C47  gateway "subscribe → renew → cancel moves the cap, then hands it back"
 *   C48  gateway "activates a held account once the gateway answers…"; account-lifecycle
 *        "holds the account activating and blocks the team when the budget push fails"
 *   C49  gateway "does not write when the gateway already holds the cap"
 *   C52  failures "marks the account exhausted and keeps the usage when Chargebee refuses"
 *   C53  compound-flows "settles the owed window against the subscription that incurred the usage"
 *   C54  webhook "does not rewind the billing cursor on a replay, however late it arrives"
 *   C57  compound-flows "credits run out, usage keeps arriving, then a top-up";
 *        gateway "new credits reopen the team, and the held usage needs no requeueing"
 *   Not covered anywhere before this file: C36, C43, C50, C51, and the reactivation
 *   half of C35.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { windowQuery } from "@/integrations/clickhouse/usage-source";
import { OUTCOME } from "@/services/usage-sync.service";

import {
  BASELINE_TERM,
  BILLING_MANAGED,
  BLOCK_REASON,
  DAY_S,
  MINUTE,
  PACK,
  PLAN,
  PLAN_B,
  PLAN_BUDGET,
  SLUG,
  SPEND_BASELINE,
  T0,
  T0_S,
  TEAM,
  TENANT,
  UNIT,
  gatewayAgreesWithDb,
  lifecycleRig,
  round6,
  webhook,
} from "./failure-matrix-lifecycle-webhooks-litellm.helpers";

const schema = readFileSync(fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)), "utf8");

// ── C34 ────────────────────────────────────────────────────────────────────

describe("C34 subscription active", () => {
  it("C34 active subscription: usage is billed against the linked subscription, its ledger unit and USD_PER_CREDIT", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { plan: PLAN, credits: 1000 });

    expect(r.account()).toMatchObject({
      status: "active",
      chargebeeSubscriptionId: "sub_1",
      chargebeeItemPriceId: PLAN,
      ledgerUnitId: UNIT,
    });
    expect(r.prisma._cursor).toBe(T0); // billing starts at activation, not at ClickHouse retention
    expect(r.gateway.team_).toMatchObject({ maxBudget: 1, budgetDuration: null, blocked: false });
    expect(r.gateway.team_.metadata).toMatchObject({ [BILLING_MANAGED]: true, [SPEND_BASELINE]: 0 });

    expect(r.llmCall("a:1", T0 + 30_000, 0.25)).toBe(true);
    r.at(2);
    const { summary } = await r.tick();

    expect(summary.synced).toBe(1);
    expect(r.cb.sent).toHaveLength(1);
    // The capture names the linked subscription and its ledger unit; the amount
    // is USD / USD_PER_CREDIT — the plan's price never enters it.
    expect(r.cb.sent[0]).toMatchObject({ subscriptionId: "sub_1", unitId: UNIT, amount: "250" });
    expect(r.cb.ledger.balance).toBe(750);
    expect(r.cursorMin()).toBe(1);
    // LiteLLM and Chargebee agree on what is left: $0.75 == 750 credits × 0.001.
    expect(r.gateway.headroomUsd()).toBe(0.75);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });
});

// ── C35 ────────────────────────────────────────────────────────────────────

describe("C35 subscription cancelled", () => {
  it("C35 cancelled: usage after cancellation is not billed, the cursor holds and the team is handed back to its plan", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.llmCall("a:1", T0 + 30_000, 0.1);
    r.at(2);
    await r.tick();
    expect(r.cb.ledger.taken).toBe(100);

    r.cb.cancel("sub_1");
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
    expect(r.account().status).toBe("cancelled");
    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBeUndefined();
    r.gateway.platformReconcile();
    expect(r.gateway.team_).toMatchObject({ maxBudget: PLAN_BUDGET, budgetDuration: "30d" });

    // Free-plan usage after the cancellation.
    expect(r.llmCall("b:1", T0 + 3 * MINUTE + 10_000, 0.3)).toBe(true);
    for (const m of [5, 6, 7]) {
      r.at(m);
      await r.tick();
    }
    expect((await r.usageSync.runTenant(SLUG)).outcome).toBe(OUTCOME.NOT_BILLABLE);

    expect(r.cb.ledger.appliedCount).toBe(1);
    expect(r.cb.ledger.taken).toBe(100);
    expect(r.cursorMin()).toBe(1); // frozen at the cancellation, never advanced past the free-plan usage
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  // FIXED (was DEFECT): a cancelled account's cursor is frozen where the cancellation
  // found it, and a re-subscription did not move it (ensureBillingCursor is create-only),
  // so the first tick after re-activation billed every span ingested while the tenant was
  // cancelled — free-plan usage — against the NEW subscription's grant, while the LiteLLM
  // cap (re-baselined at the current spend) did not count it. A resubscription after a
  // cancellation now restarts the cursor at the moment it is linked (forward only).
  it("C35 re-subscribing after a cancellation must not bill usage incurred while cancelled", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.llmCall("a:1", T0 + 30_000, 0.1);
    r.at(2);
    await r.tick();

    r.cb.cancel("sub_1");
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
    r.gateway.platformReconcile();

    // Free-plan usage while no subscription exists.
    expect(r.llmCall("free:1", T0 + 5 * MINUTE + 30_000, 0.3)).toBe(true);

    // Ten minutes later the customer buys a new subscription.
    r.at(10);
    r.cb.ledger.balance = 0; // sub_1's leftover went with it
    await r.subscribe("sub_2", { credits: 1000 });
    expect(r.account()).toMatchObject({ status: "active", chargebeeSubscriptionId: "sub_2" });

    r.at(13);
    await r.tick();

    // Nothing was used under sub_2, so nothing may be taken from it.
    expect(r.cb.takenFor("sub_2")).toBe(0);
    expect(r.cb.ledger.balance).toBe(1000);
    // And LiteLLM and Chargebee must agree on what is left.
    expect(round6(r.gateway.headroomUsd() * 1000)).toBe(r.cb.ledger.balance);
    expect(r.cursorMin()).toBe(12); // restarted at 10, then two empty minutes up to the lag

    // Usage under sub_2 bills normally, once.
    expect(r.llmCall("paid:1", T0 + 12.5 * MINUTE, 0.2)).toBe(true);
    r.at(14);
    await r.tick();
    expect(r.cb.takenFor("sub_2")).toBe(200);
    expect(round6(r.gateway.headroomUsd() * 1000)).toBe(r.cb.ledger.balance);
  });

  it("C35 the same subscription reactivated after a cancellation also starts billing afresh", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.cb.cancel("sub_1");
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
    r.gateway.platformReconcile();
    expect(r.llmCall("free:1", T0 + 2 * MINUTE + 30_000, 0.3)).toBe(true);

    r.at(6);
    r.cb.sub("sub_1").status = "active"; // reactivated in Chargebee: same id
    await r.deliver(webhook("subscription_reactivated", r.cb.sub("sub_1")));
    expect(r.account()).toMatchObject({ status: "active", chargebeeSubscriptionId: "sub_1" });

    r.at(9);
    await r.tick();
    expect(r.cb.ledger.appliedCount).toBe(0); // the free-plan call was not billed
    expect(r.cursorMin()).toBe(8);
  });
});

// ── C36 ────────────────────────────────────────────────────────────────────

describe("C36 subscription expires", () => {
  it("C36 grant expiry with no event: the first capture after it is refused, the account goes exhausted, the team is blocked, and LiteLLM and billing agree", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.llmCall("a:1", T0 + 30_000, 0.2);
    r.at(2);
    await r.tick();
    expect(r.cb.ledger.balance).toBe(800);

    // Chargebee: every block passes its expiry. No webhook fires for that.
    r.cb.expireGrants("sub_1");
    // The cap is stale until something re-reads the blocks, so LiteLLM still admits.
    expect(r.llmCall("b:1", T0 + 2.5 * MINUTE, 0.1)).toBe(true);

    r.at(4);
    const { summary } = await r.tick();

    expect(summary.outOfCredits).toBe(1);
    expect(r.account().status).toBe("exhausted");
    expect(r.gateway.team_).toMatchObject({ blocked: true, metadata: { [BLOCK_REASON]: "exhausted" } });
    expect(r.llmCall("c:1", T0 + 4 * MINUTE, 0.1)).toBe(false);
    // The overshoot is held, not lost and not driven negative.
    expect(r.cb.ledger.balance).toBe(0);
    expect(r.prisma._stuck).toMatchObject({ status: "OUT_OF_CREDITS", amount: "100" });
    expect(gatewayAgreesWithDb(r).ok).toBe(true);

    // The daily repair agrees with the minute loop instead of reopening the team.
    await r.accounts.resyncAll();
    expect(r.account().status).toBe("exhausted");
    expect(r.gateway.team_).toMatchObject({ blocked: true, maxBudget: 0 });
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  it("C36 non-renewing subscription reaches term end: the cancel releases the team, usage stops being billed, and the daily repair keeps it that way", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.cb.sub("sub_1").status = "non_renewing";
    // Chargebee announces the scheduled end; nothing here acts on it.
    await r.deliver(webhook("subscription_cancellation_scheduled", r.cb.sub("sub_1")));
    expect(r.account().status).toBe("active");

    // Term end: the subscription ends and its credits expire with it.
    r.at(1);
    r.cb.cancel("sub_1");
    r.cb.expireGrants("sub_1");
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
    r.gateway.platformReconcile();

    expect(r.account().status).toBe("cancelled");
    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBeUndefined();
    expect(r.gateway.team_).toMatchObject({ maxBudget: PLAN_BUDGET, budgetDuration: "30d", blocked: false });

    r.llmCall("free:1", T0 + 90_000, 0.2); // on the plan budget now
    r.at(4);
    await r.tick();
    await r.accounts.resyncAll();

    expect(r.cb.ledger.appliedCount).toBe(0);
    expect(r.account().status).toBe("cancelled");
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });
});

// ── C37 ────────────────────────────────────────────────────────────────────

describe("C37 subscription renewal", () => {
  it("C37 renewal: the new term is recorded, old-term usage is not billed again, new usage bills exactly once", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });
    r.llmCall("t1:a", T0 + 30_000, 0.3);
    r.at(2);
    await r.tick();
    expect(r.cb.ledger.taken).toBe(300);

    r.cb.renew("sub_1", { start: T0_S + 30 * DAY_S, credits: 1000 });
    await r.deliver(webhook("subscription_renewed", r.cb.sub("sub_1")));

    expect(r.account().currentTermStart).toEqual(new Date((T0_S + 30 * DAY_S) * 1000));
    expect(r.cursorMin()).toBe(1); // not rewound to the renewal, not reset to now

    r.llmCall("t2:a", T0 + 90_000, 0.2);
    for (const m of [3, 4, 5]) {
      r.at(m);
      await r.tick();
    }
    await r.accounts.resyncAll();
    r.at(6);
    await r.tick();

    expect(r.cb.ledger.appliedCount).toBe(2);
    expect(r.cb.ledger.taken).toBe(500);
    expect(r.billedRanges()).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(r.cb.ledger.balance).toBe(800); // the new term's 1000, less only the new term's usage
  });

  // FIXED (was DEFECT): after a renewal the LiteLLM headroom was the new grant MINUS
  // every earlier term's spend — push() kept the first spend baseline forever while
  // grantedCredits() drops the expired block, whose spend stays in the team's
  // cumulative total. The baseline now moves up to the team's spend when the term
  // does, recorded with the term so a second delivery does not move it again.
  it("C37 renewal: the new term's whole grant is spendable at the gateway, whatever was spent last term", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });

    // Term 1 is used up: 600 + 400 credits.
    expect(r.llmCall("t1:a", T0 + 30_000, 0.6)).toBe(true);
    r.at(2);
    await r.tick();
    expect(r.llmCall("t1:b", T0 + 90_000, 0.4)).toBe(true);
    r.at(3);
    await r.tick();
    expect(r.cb.ledger.balance).toBe(0);
    expect(r.account().status).toBe("exhausted");

    // Renewal: the old block expires, a new 1000-credit block is issued.
    r.cb.renew("sub_1", { start: T0_S + 30 * DAY_S, credits: 1000 });
    await r.deliver(webhook("subscription_renewed", r.cb.sub("sub_1")));
    expect(r.account().status).toBe("active");
    expect(r.gateway.team_.blocked).toBe(false);

    // The gateway must let the customer spend the new term's 1000 credits.
    expect(r.gateway.headroomUsd()).toBe(1);
    expect(r.llmCall("t2:a", T0 + 3.5 * MINUTE, 0.1)).toBe(true);
    expect(r.gateway.team_.metadata[BASELINE_TERM]).toBe(new Date((T0_S + 30 * DAY_S) * 1000).toISOString());

    // …and LiteLLM and Chargebee agree on what is left once it is billed.
    r.at(5);
    await r.tick();
    expect(r.cb.ledger.balance).toBe(900);
    expect(round6(r.gateway.headroomUsd() * 1000)).toBe(900);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });
});

// ── C38 ────────────────────────────────────────────────────────────────────

describe("C38 renewal grant", () => {
  it("C38 renewal with a new grant: the cap counts the new block once and the expired one not at all, on every path that re-reads it", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });
    expect(r.gateway.team_.maxBudget).toBe(1);

    r.cb.renew("sub_1", { start: T0_S + 30 * DAY_S, credits: 1500 });
    await r.deliver(webhook("subscription_renewed", r.cb.sub("sub_1")));
    expect(r.gateway.team_.maxBudget).toBe(1.5); // not 2.5
    expect(r.cb.blocks.filter((b) => b.status === "available")).toHaveLength(1);

    // The same grant, seen again by the redelivery, the pull and the daily repair.
    await r.deliver(webhook("subscription_renewed", r.cb.sub("sub_1")));
    await r.accounts.syncFromChargebee(TENANT);
    await r.accounts.resyncAll();

    expect(r.gateway.team_.maxBudget).toBe(1.5);
    expect(r.cb.ledger.balance).toBe(1500);
    // The grant is Chargebee's (Credit Grant on the item price): no path here allocates it.
    expect(r.cb.allocations).toHaveLength(0);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });
});

// ── C39 ────────────────────────────────────────────────────────────────────

describe("C39 duplicate renewal webhook", () => {
  it("C39 the same subscription_renewed delivered twice: grant applied once, no second gateway write, cursor and term unchanged", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });
    r.llmCall("a:1", T0 + 30_000, 0.2);
    r.at(2);
    await r.tick();

    r.cb.renew("sub_1", { start: T0_S + 30 * DAY_S, credits: 1000 });
    const renewed = webhook("subscription_renewed", r.cb.sub("sub_1"), "ev_renew_1");
    await r.deliver(renewed);
    const snapshot = () => ({
      account: { ...r.account() },
      team: structuredClone(r.gateway.team_),
      writes: r.gateway.updates.length,
      balance: r.cb.ledger.balance,
      blocks: r.cb.blocks.length,
      captures: r.cb.ledger.appliedCount,
    });
    const first = snapshot();

    await r.deliver(renewed);

    expect(snapshot()).toEqual(first);
    // One term's grant, not two — on top of term 1's $0.20 spend, which the
    // renewal moved into the baseline (C37).
    expect(first.team.maxBudget).toBe(1.2);
    expect(first.team.metadata[SPEND_BASELINE]).toBe(0.2);
    expect(r.cb.allocations).toHaveLength(0);
  });
});

// ── C40 ────────────────────────────────────────────────────────────────────

describe("C40 webhook missing", () => {
  it("C40 missed subscription_renewed: the daily resyncAll re-reads Chargebee and moves term, plan and cap", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });

    r.cb.renew("sub_1", { start: T0_S + 30 * DAY_S, credits: 2500, plan: PLAN_B }); // no webhook
    expect(r.account().currentTermStart).toEqual(new Date(T0_S * 1000));

    expect(await r.accounts.resyncAll()).toEqual({ scanned: 1, repaired: 1, errors: [] });

    expect(r.account()).toMatchObject({
      status: "active",
      chargebeeItemPriceId: PLAN_B,
      currentTermStart: new Date((T0_S + 30 * DAY_S) * 1000),
    });
    expect(r.gateway.team_.maxBudget).toBe(2.5);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  // FIXED (was a documented gap — "no pull path for lifecycle events"): a lost
  // subscription_cancelled / subscription_deleted was never repaired, because
  // syncFromChargebee lists only active/in_trial/non_renewing subscriptions and
  // returned null when none was left. It now reads the linked subscription by id
  // and cancels the account when that subscription has ended (or is gone).
  it("C40 missed subscription_cancelled: the daily resyncAll brings the account to cancelled and hands the team back", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");

    r.cb.cancel("sub_1"); // no webhook
    await r.accounts.resyncAll();

    expect(r.account().status).toBe("cancelled");
    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBeUndefined();

    // A paused subscription is not a cancellation, and is left alone.
    const p = lifecycleRig();
    await p.subscribe("sub_1");
    p.cb.sub("sub_1").status = "paused";
    await p.accounts.resyncAll();
    expect(p.account().status).toBe("active");
  });

  // FIXED (was a gap): resyncAll only visited tenants that ALREADY had a
  // subscription id, so a customer whose subscription_created was lost and whose
  // one post-checkout pull never ran was paid up in Chargebee and never linked. It
  // now visits every tenant with a Chargebee customer.
  it("C40 missed subscription_created and no post-checkout pull: the daily resyncAll links the paid subscription", async () => {
    const r = lifecycleRig();
    r.cb.subscribe("sub_1"); // paid in Chargebee; nothing reached us

    await r.accounts.resyncAll();

    expect(r.account()).toMatchObject({ chargebeeSubscriptionId: "sub_1", status: "active" });
    expect(r.gateway.team_.maxBudget).toBe(1);
  });
});

// ── C41 ────────────────────────────────────────────────────────────────────

describe("C41 webhook delayed", () => {
  it("C41 delayed subscription_created: the post-checkout pull links it first, the late webhook converges (one cap, cursor kept, nothing re-billed)", async () => {
    const r = lifecycleRig();
    const sub = r.cb.subscribe("sub_1");
    const delayed = webhook("subscription_created", sub, "ev_created_late");

    // The checkout success callback pulls before any webhook arrives.
    await r.accounts.syncFromChargebee(TENANT);
    expect(r.account().status).toBe("active");
    expect(r.gateway.team_.maxBudget).toBe(1);

    r.llmCall("a:1", T0 + 30_000, 0.2);
    r.at(2);
    await r.tick();
    const writes = r.gateway.updates.length;

    r.at(3);
    await r.deliver(delayed);
    r.at(4);
    await r.tick();

    expect(r.account().status).toBe("active");
    expect(r.gateway.team_.maxBudget).toBe(1);
    expect(r.gateway.updates).toHaveLength(writes);
    expect(r.cursorMin()).toBe(3);
    expect(r.cb.ledger.appliedCount).toBe(1);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  it("C41 delayed subscription_renewed while exhausted: state is stale-but-safe until the webhook, then correct", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.llmCall("a:1", T0 + 30_000, 0.2);
    r.at(2);
    await r.tick();

    // End of term 1: the credits expire and the next capture is refused.
    r.cb.expireGrants("sub_1");
    r.llmCall("b:1", T0 + 2.5 * MINUTE, 0.1);
    r.at(4);
    await r.tick();
    expect(r.account().status).toBe("exhausted");

    // Chargebee renews; the webhook is delayed.
    r.cb.renew("sub_1", { start: T0_S + 30 * DAY_S, credits: 1000 });
    const renewed = webhook("subscription_renewed", r.cb.sub("sub_1"));

    r.at(5);
    await r.tick();
    // The held window now clears against the new grant — once — but nothing on
    // this path reopens the team: the stale state is "blocked", never "open".
    expect(r.cb.ledger.appliedCount).toBe(2);
    expect(r.prisma._stuck).toBeUndefined();
    expect(r.account().status).toBe("exhausted");
    expect(r.gateway.team_.blocked).toBe(true);

    r.at(6);
    await r.deliver(renewed);

    expect(r.account()).toMatchObject({ status: "active", currentTermStart: new Date((T0_S + 30 * DAY_S) * 1000) });
    expect(r.gateway.team_.blocked).toBe(false);
    expect(r.cb.ledger.appliedCount).toBe(2);
    expect(r.cb.ledger.taken).toBe(300);
    expect(r.cb.ledger.balance).toBe(900);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });
});

// ── C42 ────────────────────────────────────────────────────────────────────

describe("C42 webhook arrives twice", () => {
  it("C42 identical webhooks twice: the second changes nothing — convergent handlers stand in for the removed processed_billing_event", async () => {
    // The table the matrix names is gone by design (migration
    // 20260922150000_drop_processed_billing_event); what replaces it is a property.
    // TopUpGrant is the top-up guard (C57a, migration 20260924190000) — not a webhook table.
    expect(schema.match(/^model \w+/gm)).toEqual(["model BillingAccount", "model ChargebeeSync", "model TopUpGrant"]);
    expect(schema).not.toMatch(/@@map\("processed_billing_event"\)/);

    const r = lifecycleRig();
    const sub = r.cb.subscribe("sub_1");
    const created = webhook("subscription_created", sub, "ev_1");
    await r.deliver(created);
    const afterFirst = { account: { ...r.account() }, team: structuredClone(r.gateway.team_), writes: r.gateway.updates.length };

    await r.deliver(created);
    expect({ account: { ...r.account() }, team: structuredClone(r.gateway.team_), writes: r.gateway.updates.length }).toEqual(afterFirst);

    r.cb.cancel("sub_1");
    const cancelled = webhook("subscription_cancelled", r.cb.sub("sub_1"), "ev_2");
    await r.deliver(cancelled);
    const afterCancel = { status: r.account().status, team: structuredClone(r.gateway.team_), writes: r.gateway.updates.length };
    await r.deliver(cancelled);

    expect({ status: r.account().status, team: structuredClone(r.gateway.team_), writes: r.gateway.updates.length }).toEqual(afterCancel);
    expect(afterCancel.status).toBe("cancelled");
  });
});

// ── C43 ────────────────────────────────────────────────────────────────────

describe("C43 webhook out of order", () => {
  // FIXED (was BILLING-ARCHITECTURE.md §10 known defect 3): a subscription_created /
  // _activated / _changed body was applied verbatim, so a stale or redelivered created
  // event after a cancellation RE-ACTIVATED the account. Every subscription event is
  // now only a trigger for syncFromChargebee, which applies what Chargebee says now.
  it("C43 a stale subscription_created after subscription_cancelled must not re-activate the account", async () => {
    const r = lifecycleRig();
    const sub = r.cb.subscribe("sub_1");
    const created = webhook("subscription_created", sub, "ev_created");
    await r.deliver(created);

    r.at(1);
    r.cb.cancel("sub_1");
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1"), "ev_cancelled"));
    expect(r.account().status).toBe("cancelled");

    // Chargebee retries the older event (it got a 500 once), after the cancel.
    r.at(2);
    await r.deliver(created);

    expect(r.account().status).toBe("cancelled");
    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBeUndefined();
  });

  // FIXED (was DEFECT): same root cause, via subscription_renewed → renew().
  it("C43 a delayed subscription_renewed that arrives after subscription_cancelled must not re-activate the account", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");

    // Renewal happens in Chargebee; its webhook is delayed. Then the customer cancels.
    r.cb.renew("sub_1", { start: T0_S + 30 * DAY_S });
    const renewed = webhook("subscription_renewed", r.cb.sub("sub_1"), "ev_renewed");
    r.at(1);
    r.cb.cancel("sub_1");
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1"), "ev_cancelled"));

    r.at(2);
    await r.deliver(renewed);

    expect(r.account().status).toBe("cancelled");
    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBeUndefined();
  });

  // FIXED (was DEFECT): a stale body rewound current_term_start/_end, and
  // applyPaidTopUps then used the stale currentTermEnd as the allocation's
  // expires_at, so a top-up bought now was allocated already expired. The body's
  // dates are no longer read at all.
  it("C43 a stale subscription_created (old term) after subscription_renewed must not rewind the term", async () => {
    const r = lifecycleRig();
    const sub = r.cb.subscribe("sub_1", { start: T0_S - 30 * DAY_S, end: T0_S });
    const created = webhook("subscription_created", sub, "ev_created");
    await r.deliver(created);

    r.at(1);
    r.cb.renew("sub_1", { start: T0_S, end: T0_S + 30 * DAY_S });
    await r.deliver(webhook("subscription_renewed", r.cb.sub("sub_1"), "ev_renewed"));
    expect(r.account().currentTermStart).toEqual(new Date(T0_S * 1000));

    r.at(2);
    await r.deliver(created); // late redelivery of the term-1 event

    expect(r.account().currentTermStart).toEqual(new Date(T0_S * 1000));
    expect(r.account().currentTermEnd).toEqual(new Date((T0_S + 30 * DAY_S) * 1000));

    r.cb.paidInvoices.push({ id: "inv_1" });
    await r.accounts.applyPaidTopUps(TENANT, PACK, "1000");
    expect(r.cb.allocations[0]!.expiresAt * 1000).toBeGreaterThan(r.now());
  });
});

// ── C47 ────────────────────────────────────────────────────────────────────

describe("C47 LiteLLM update succeeds", () => {
  it("C47 subscription_changed (upgrade): LiteLLM receives the cap, ownership and open state the billing DB and Chargebee say", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { plan: PLAN, credits: 1000 });
    r.llmCall("a:1", T0 + 30_000, 0.2);

    // Upgrade in place: the item price changes and its Credit Grant issues a block.
    r.cb.sub("sub_1").subscription_items = [{ item_price_id: PLAN_B }];
    r.cb.grantPlan("sub_1", 1500);
    await r.deliver(webhook("subscription_changed", r.cb.sub("sub_1")));

    expect(r.account()).toMatchObject({ status: "active", chargebeeItemPriceId: PLAN_B });
    expect(r.gateway.updates.at(-1)).toEqual({
      team_id: TEAM,
      max_budget: 2.5,
      budget_duration: null,
      // The term the baseline belongs to: a plan change in place is not a renewal.
      metadata: {
        plan: "free",
        [BILLING_MANAGED]: true,
        [SPEND_BASELINE]: 0,
        [BASELINE_TERM]: new Date(T0_S * 1000).toISOString(),
      },
      blocked: false,
    });
    expect(r.gateway.team_.blocked).toBe(false);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);

    r.at(2);
    await r.tick();
    // After the capture the two sides still agree: $2.30 of headroom == 2300 credits.
    expect(r.cb.ledger.balance).toBe(2300);
    expect(round6(r.gateway.headroomUsd() * 1000)).toBe(2300);
  });
});

// ── C48 ────────────────────────────────────────────────────────────────────

describe("C48 LiteLLM update fails", () => {
  it("C48 LiteLLM unreachable at activation: billing state is persisted, the account is held activating and retried each tick until LiteLLM matches", async () => {
    const r = lifecycleRig();
    r.gateway.down = true;

    await r.subscribe("sub_1"); // the webhook handler does not throw: a 200 to Chargebee

    expect(r.account()).toMatchObject({ status: "activating", chargebeeSubscriptionId: "sub_1", ledgerUnitId: UNIT });
    expect(r.prisma._cursor).toBe(T0);
    expect(r.metrics()).toEqual(expect.arrayContaining(["billing.budget.push_failed", "billing.budget.block_failed"]));

    r.at(1);
    expect((await r.tick()).activation).toEqual({ pending: 1, activated: 0 });
    expect(r.account().status).toBe("activating");

    r.gateway.down = false;
    r.at(2);
    expect((await r.tick()).activation).toEqual({ pending: 1, activated: 1 });

    expect(r.account().status).toBe("active");
    expect(r.gateway.team_).toMatchObject({ maxBudget: 1, budgetDuration: null, blocked: false });
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  it("C48 only the budget write fails: the team is blocked (fail closed) and opened by the retry in one update", async () => {
    const r = lifecycleRig();
    r.gateway.pushFails = true;
    await r.subscribe("sub_1");
    expect(r.account().status).toBe("activating");
    expect(r.gateway.team_).toMatchObject({ blocked: true, metadata: { [BLOCK_REASON]: "activating" } });
    expect(gatewayAgreesWithDb(r).ok).toBe(true);

    r.gateway.pushFails = false;
    r.at(1);
    await r.tick();
    expect(r.gateway.updates.at(-1)).toMatchObject({ max_budget: 1, budget_duration: null, blocked: false });
    expect(r.account().status).toBe("active");
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });
});

// ── C49 ────────────────────────────────────────────────────────────────────

describe("C49 LiteLLM update duplicated", () => {
  it("C49 the same push, block and release sent twice: one write each, same final state", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    const writes = r.gateway.updates.length;
    const team = structuredClone(r.gateway.team_);

    expect((await r.budget.push(TENANT)).changed).toBe(false);
    expect((await r.budget.push(TENANT)).changed).toBe(false);
    await r.accounts.syncFromChargebee(TENANT);
    await r.accounts.syncFromChargebee(TENANT);
    expect(r.gateway.updates).toHaveLength(writes);
    expect(r.gateway.team_).toEqual(team);

    await r.budget.block(TENANT, "exhausted");
    const blocked = structuredClone(r.gateway.team_);
    await r.budget.block(TENANT, "exhausted");
    expect(r.gateway.team_).toEqual(blocked);

    await r.budget.push(TENANT);
    expect(await r.budget.release(TENANT)).toEqual({ released: true });
    const released = { team: structuredClone(r.gateway.team_), writes: r.gateway.updates.length };
    expect(await r.budget.release(TENANT)).toEqual({ released: false });
    expect({ team: structuredClone(r.gateway.team_), writes: r.gateway.updates.length }).toEqual(released);
  });
});

// ── C50 ────────────────────────────────────────────────────────────────────

describe("C50 DB active, LiteLLM blocked", () => {
  it("C50 forced active-but-blocked: the daily resyncAll unblocks the team", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    await r.budget.block(TENANT, "exhausted"); // a stale block landing after the account went active
    expect(r.account().status).toBe("active");

    await r.accounts.resyncAll();

    expect(r.gateway.team_.blocked).toBe(false);
    expect(r.gateway.team_.metadata[BLOCK_REASON]).toBeUndefined();
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  // FIXED (was DEFECT): nothing in the per-minute tick noticed an ACTIVE account
  // whose team was blocked, so a paying customer stayed refused until the daily
  // resync (up to ~24h). The tick now runs reopenBlockedActive() after the
  // usage sync, exactly as hatchet-worker.ts does.
  it("C50 forced active-but-blocked: the next minute tick repairs it", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    await r.budget.block(TENANT, "exhausted");

    r.at(1);
    const { gates } = await r.tick();

    expect(gates).toEqual({ checked: 1, reopened: 1 });
    expect(r.gateway.team_.blocked).toBe(false);
    expect(r.account().status).toBe("active");
    expect(r.metrics()).toContain("billing.budget.active_but_blocked");
    expect(gatewayAgreesWithDb(r).ok).toBe(true);

    // An open active account costs one read and no write.
    const writes = r.gateway.updates.length;
    r.at(2);
    expect((await r.tick()).gates).toEqual({ checked: 1, reopened: 0 });
    expect(r.gateway.updates).toHaveLength(writes);
  });

  it("C50 an active account whose team is blocked because its credits really are gone becomes exhausted, not reopened", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.cb.ledger.balance = 0; // used up, and no capture has said so yet
    await r.budget.block(TENANT, "exhausted");

    r.at(1);
    const { gates } = await r.tick();

    expect(gates).toEqual({ checked: 1, reopened: 0 });
    expect(r.account().status).toBe("exhausted");
    expect(r.gateway.team_.blocked).toBe(true);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  // FIXED (was DEFECT): the state above is reachable without forcing it — when the
  // webhook's activation fails its push while the post-checkout pull's activation
  // succeeds, the failed one's block (a read-modify-write of the team, whose stale
  // metadata also drops billing_managed) can land last: DB `active`, team blocked.
  // The race itself cannot be ruled out without serialising two activations; what
  // is guaranteed now is that the next minute's tick finds and repairs it.
  it("C50 race: a failed activation interleaved with a successful one must not leave the account active with its team blocked", async () => {
    const r = lifecycleRig();
    const sub = r.cb.subscribe("sub_1");

    // The webhook's budget write fails once (a LiteLLM blip) and its block write is slow.
    r.gateway.failNextCapWrites = 1;
    let releaseBlock!: () => void;
    r.gateway.holdBlockWrites = new Promise<void>((resolve) => (releaseBlock = resolve));
    const viaWebhook = r.deliver(webhook("subscription_created", sub));
    await r.gateway.blockHeld;
    expect(r.account().status).toBe("activating");

    // Meanwhile the post-checkout pull lands and activates.
    await r.accounts.syncFromChargebee(TENANT);
    expect(r.account().status).toBe("active");

    releaseBlock();
    await viaWebhook;
    r.at(1);
    await r.tick();

    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });
});

// ── C51 ────────────────────────────────────────────────────────────────────

describe("C51 DB says expired/cancelled, LiteLLM allowed", () => {
  // FIXED (was DEFECT): cancel() wrote `cancelled` and tried release() once; a failure
  // was only logged, the webhook answered 200, and nothing ever retried it — the team
  // kept `billing_managed` and its prepaid cap for ever, serving calls nobody billed.
  // A failed release now fails the handler (500, so Chargebee redelivers), and the
  // daily resync re-runs cancel() for every account whose subscription has ended.
  it("C51 cancelled but the release failed: the daily resync retries the release until the team is handed back", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");

    r.gateway.releaseFails = true;
    r.cb.cancel("sub_1");
    await expect(r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")))).rejects.toThrow(/team\/update failed/);
    expect(r.account().status).toBe("cancelled"); // written before the release was tried
    expect(r.metrics()).toContain("billing.budget.release_failed");

    // Still failing at the next daily resync: counted, logged, and tried again the day after.
    expect((await r.accounts.resyncAll()).errors).toHaveLength(1);
    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBe(true);

    r.gateway.releaseFails = false;
    for (const m of [1, 2, 3]) {
      r.at(m);
      await r.tick();
    }
    await r.accounts.resyncAll();

    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBeUndefined();
    r.gateway.platformReconcile();
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  it("C51 cancelled but the release failed: Chargebee's redelivery of the 500'd webhook hands the team back", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");

    r.gateway.releaseFails = true;
    r.cb.cancel("sub_1");
    const cancelled = webhook("subscription_cancelled", r.cb.sub("sub_1"));
    await expect(r.deliver(cancelled)).rejects.toThrow();

    r.gateway.releaseFails = false;
    await r.deliver(cancelled);

    expect(r.account().status).toBe("cancelled");
    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBeUndefined();
  });

  it("C51 exhausted but the LiteLLM block failed: the next refused capture re-blocks the team once LiteLLM answers", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.cb.expireGrants("sub_1");
    r.llmCall("a:1", T0 + 30_000, 0.1);

    r.gateway.blockFails = true;
    r.at(2);
    await r.tick();
    expect(r.account().status).toBe("exhausted");
    expect(r.metrics()).toContain("billing.budget.block_failed");
    expect(r.gateway.team_.blocked).toBe(false); // the window of unauthorised access

    r.gateway.blockFails = false;
    r.at(3);
    await r.tick(); // OUT_OF_CREDITS is retried every tick, and so is the block

    expect(r.gateway.team_).toMatchObject({ blocked: true, metadata: { [BLOCK_REASON]: "exhausted" } });
    expect(r.llmCall("b:1", T0 + 3 * MINUTE, 0.1)).toBe(false);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
    expect(r.cb.ledger.balance).toBe(0);
  });
});

// ── C52 ────────────────────────────────────────────────────────────────────

describe("C52 concurrent LLM requests", () => {
  /**
   * LiteLLM's admission for N calls arriving together, in its two modes:
   *
   *   read-time   no reservation (unknown model cost, budget_reservation.py:189-194;
   *               counter write failed without fail_closed, :209-218): each call
   *               checks spend > max_budget (auth_checks.py:4285) before ANY of
   *               them has recorded spend, so all N pass.
   *   reserve     1.98's atomic counter: each call reserves its max cost; the one
   *               that straddles the cap is admitted with its reservation resized
   *               to what is left (:124-131), everything after it is refused.
   */
  function admit(headroomUsd: number, costs: number[], mode: "read-time" | "reserve"): number[] {
    if (mode === "read-time") return headroomUsd > 1e-12 ? costs : [];
    const admitted: number[] = [];
    let left = headroomUsd;
    for (const c of costs) {
      if (left <= 1e-12) break;
      admitted.push(c);
      left -= Math.min(c, left);
    }
    return admitted;
  }

  it("C52 concurrent calls past the cap: overshoot is bounded by LiteLLM's admission, the Chargebee balance never goes negative, and billing holds the overshoot OUT_OF_CREDITS", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });
    r.llmCall("a:1", T0 + 30_000, 0.9);
    r.at(2);
    await r.tick();
    expect(r.cb.ledger.balance).toBe(100);

    const burst = Array.from({ length: 10 }, () => 0.05); // $0.50 of calls, $0.10 of headroom
    const headroom = r.gateway.headroomUsd();
    expect(admit(headroom, burst, "reserve")).toHaveLength(2); // bound: headroom + one straddling call
    const admitted = admit(headroom, burst, "read-time"); // worst case: all ten
    expect(admitted).toHaveLength(10);
    admitted.forEach((usd, i) => {
      r.gateway.team_.spend = round6(r.gateway.team_.spend + usd);
      r.usage.add(`burst:${i}`, T0 + 90_000, usd);
    });
    expect(r.gateway.team_.spend).toBe(1.4); // $0.40 past a $1.00 cap

    const balances: number[] = [];
    for (const m of [3, 4, 5]) {
      r.at(m);
      await r.tick();
      balances.push(r.cb.ledger.balance);
    }

    // Chargebee refuses the whole 500-credit window rather than going negative.
    expect(Math.min(...balances)).toBeGreaterThanOrEqual(0);
    expect(balances).toEqual([100, 100, 100]);
    expect(r.prisma._stuck).toMatchObject({ status: "OUT_OF_CREDITS", amount: "500" });
    expect(r.account().status).toBe("exhausted");
    expect(r.gateway.team_.blocked).toBe(true);
    expect(r.llmCall("after:1", T0 + 5 * MINUTE, 0.01)).toBe(false);

    // A top-up settles the overshoot in full; the two sides agree again.
    r.cb.paidInvoices.push({ id: "inv_1" });
    await r.accounts.applyPaidTopUps(TENANT, PACK, "1000");
    r.at(6);
    await r.tick();
    expect(r.cb.ledger.taken).toBe(1400);
    expect(r.cb.ledger.balance).toBe(600);
    expect(round6(r.gateway.headroomUsd() * 1000)).toBe(600);
  });
});

// ── C53 ────────────────────────────────────────────────────────────────────

describe("C53 usage during subscription transition", () => {
  it("C53 plan change on the same subscription mid-usage: each window is billed once, at the one global rate, against the linked subscription", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { plan: PLAN, credits: 1000 });
    r.llmCall("a:1", T0 + 30_000, 0.1); // under PLAN

    r.at(1);
    r.cb.sub("sub_1").subscription_items = [{ item_price_id: PLAN_B }];
    r.cb.grantPlan("sub_1", 1500);
    await r.deliver(webhook("subscription_changed", r.cb.sub("sub_1")));
    r.llmCall("b:1", T0 + 90_000, 0.2); // under PLAN_B

    r.at(3);
    await r.tick();

    expect(r.cb.sent.map((a) => [a.subscriptionId, a.amount])).toEqual([
      ["sub_1", "100"],
      ["sub_1", "200"],
    ]);
    expect(r.billedRanges()).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(r.account().chargebeeItemPriceId).toBe(PLAN_B);
    expect(round6(r.gateway.headroomUsd() * 1000)).toBe(r.cb.ledger.balance);
  });

  // KNOWN LIMITATION, kept by design (decision recorded for the owner): a window is
  // attributed to whatever subscription/term is live when it is PROCESSED, not when
  // its usage was incurred. The capture API has no effective time — it rejects a
  // ledger_operation_timestamp older than ten minutes — and by the time the last
  // lag + window (≈2-3 min) of term 1 is captured, Chargebee has expired term 1's
  // block, so it can only draw on term 2's. Bounded by the lag, or by a held backlog.
  it("C53 (known limitation) usage incurred in term 1 but billed after the renewal is paid from term 2's grant", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });
    r.llmCall("t1:a", T0 + 30_000, 0.1); // term 1

    r.at(1); // renewal before that window is billed
    r.cb.renew("sub_1", { start: T0_S + 60, credits: 1000 });
    await r.deliver(webhook("subscription_renewed", r.cb.sub("sub_1")));
    r.llmCall("t2:a", T0 + 90_000, 0.2); // term 2

    r.at(3);
    await r.tick();

    // 1000 − the 200 term 2 used − the 100 term 1 used in its last minute.
    expect(r.cb.ledger.balance).toBe(700);
    expect(r.cb.ledger.taken).toBe(300); // every call billed exactly once
  });

  // FIXED (was DEFECT): subscription_cancelled cancelled the TENANT whichever
  // subscription it named, so cancelling the old subscription after moving to a new
  // one — or cancelling an add-on — cancelled the account linked to the live one.
  // The event is now a trigger for syncFromChargebee, which cancels only when no
  // subscription is active and the linked one has ended.
  //
  // Note the middle step: while BOTH are active the account stays on sub_1. Which
  // subscription collects usage is models/subscription.ts's rule ("stickiness is
  // the point"), which the body-trusting created handler used to bypass by linking
  // whatever the newest event named.
  it("C53 switching to a new subscription then cancelling the old one keeps the account active and bills the new one", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { plan: PLAN, credits: 1000 });

    r.at(1);
    r.cb.ledger.balance = 0;
    await r.subscribe("sub_2", { plan: PLAN_B, credits: 2500 });
    expect(r.account()).toMatchObject({ chargebeeSubscriptionId: "sub_1", status: "active" });
    r.cb.cancel("sub_1");
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
    expect(r.account()).toMatchObject({ chargebeeSubscriptionId: "sub_2", status: "active" });

    r.llmCall("b:1", T0 + 2.5 * MINUTE, 0.2);
    r.at(4);
    await r.tick();

    expect(r.account()).toMatchObject({ chargebeeSubscriptionId: "sub_2", status: "active" });
    expect(r.cb.takenFor("sub_2")).toBe(200);
  });

  it("C53 a cancellation of a subscription the account is not linked to leaves the account alone", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    // An old subscription, long since replaced, is deleted in Chargebee.
    r.cb.subscribe("sub_old");
    r.cb.cancel("sub_old");
    await r.deliver(webhook("subscription_deleted", r.cb.sub("sub_old")));

    expect(r.account()).toMatchObject({ chargebeeSubscriptionId: "sub_1", status: "active" });
    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBe(true);
  });
});

// ── C54 ────────────────────────────────────────────────────────────────────

describe("C54 old usage after renewal", () => {
  it("C54 renewal with the old spans still in ClickHouse bills none of them again — the ingestion cursor (not sync_from) is the guard", async () => {
    // The column the matrix names is gone by design; the cursor replaces it.
    expect(schema).not.toMatch(/@map\("sync_from"\)/);
    expect(schema).toMatch(/lastProcessedIngestedAt\s+DateTime\?\s+@map\("last_processed_ingested_at"\)/);
    expect(windowQuery(SLUG)).not.toContain("sync_from");

    const r = lifecycleRig();
    await r.subscribe("sub_1");
    for (let m = 0; m < 3; m += 1) r.llmCall(`t${m}:s1`, T0 + m * MINUTE + 30_000, 0.1);
    r.at(4);
    await r.tick();
    expect(r.cb.ledger.appliedCount).toBe(3);
    const cursor = r.prisma._cursor;

    // Every path a renewal can take: the webhook, the pull, the daily repair.
    r.cb.renew("sub_1", { start: T0_S + 30 * DAY_S });
    await r.deliver(webhook("subscription_renewed", r.cb.sub("sub_1")));
    await r.accounts.syncFromChargebee(TENANT);
    await r.accounts.resyncAll();
    expect(r.prisma._cursor).toBe(cursor);

    for (const m of [5, 6, 7]) {
      r.at(m);
      await r.tick();
    }

    expect(r.cb.ledger.appliedCount).toBe(3);
    expect(r.cb.ledger.taken).toBe(300);
    expect(r.billedRanges()).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(r.cb.ledger.balance).toBe(1000); // the new term untouched by the old spans
  });
});

// ── top-up after cancellation ──────────────────────────────────────────────

describe("top-up on a cancelled account", () => {
  it("a paid pack is not granted to a cancelled account: no allocation, the team stays with its plan, nothing is billed", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.cb.cancel("sub_1");
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
    r.gateway.platformReconcile();
    const writes = r.gateway.updates.length;

    r.cb.paidInvoices.push({ id: "inv_1" });
    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "1000")).toEqual({ applied: 0, credits: "0" });

    expect(r.cb.allocations).toHaveLength(0);
    expect(r.account().status).toBe("cancelled");
    expect(r.gateway.updates).toHaveLength(writes); // activate() never reopened the team
    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBeUndefined();
    expect(r.metrics()).toContain("billing.topup.refused_cancelled");

    // Subscribing again is what makes the paid pack count, against the NEW subscription.
    r.at(2);
    await r.subscribe("sub_2");
    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "1000")).toEqual({ applied: 1, credits: "1000" });
    expect(r.cb.allocations[0]).toMatchObject({ subscriptionId: "sub_2", metadata: { invoice_id: "inv_1" } });
  });
});

// ── C57 ────────────────────────────────────────────────────────────────────

describe("C57 top-up after exhaustion", () => {
  it("C57 top-up after exhaustion: balance, LiteLLM team and the held OUT_OF_CREDITS window all recover, once", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });
    r.llmCall("a:1", T0 + 30_000, 0.6);
    r.at(2);
    await r.tick();
    r.llmCall("b:1", T0 + 90_000, 0.6); // admitted with $0.40 left: the straddling call
    r.at(3);
    await r.tick();

    expect(r.prisma._stuck).toMatchObject({ status: "OUT_OF_CREDITS", amount: "600" });
    expect(r.account().status).toBe("exhausted");
    expect(r.gateway.team_.blocked).toBe(true);
    expect(r.cb.ledger.balance).toBe(400);

    r.cb.paidInvoices.push({ id: "inv_1" });
    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "1000")).toEqual({ applied: 1, credits: "1000" });

    expect(r.account().status).toBe("active");
    expect(r.gateway.team_).toMatchObject({ blocked: false, maxBudget: 2 });
    expect(r.gateway.team_.metadata[BLOCK_REASON]).toBeUndefined();

    r.at(4);
    const { summary } = await r.tick();
    expect(summary.synced + summary.replayed).toBe(1);
    expect(r.prisma._stuck).toBeUndefined();
    expect(r.cb.ledger.appliedCount).toBe(2);
    expect(r.cb.ledger.balance).toBe(800);
    expect(r.cursorMin()).toBe(3);
    // Both sides agree on what is left: $0.80 == 800 credits.
    expect(round6(r.gateway.headroomUsd() * 1000)).toBe(800);
    expect(r.llmCall("c:1", T0 + 4 * MINUTE, 0.1)).toBe(true);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);

    // The same paid invoice is not granted twice.
    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "1000")).toEqual({ applied: 0, credits: "0" });
    expect(r.cb.allocations).toHaveLength(1);
  });
});
