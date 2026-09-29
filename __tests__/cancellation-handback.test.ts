/**
 * What happens to an account, its LiteLLM team and its held usage when
 * Chargebee ends the subscription — by an admin or by dunning; customers
 * cannot cancel themselves — and the writers that race the cancellation.
 *
 * Drives the same REAL services as failure-matrix-lifecycle.test.ts, over its
 * rig. Each test pins one defect found in review; the probe it reproduces is
 * named in its title.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createChargebee } from "@/integrations/chargebee";
import { SYNC } from "@/models/sync-status";

import {
  BILLING_MANAGED,
  BLOCK_REASON,
  DAY_S,
  MINUTE,
  PACK,
  T0,
  T0_S,
  TENANT,
  gatewayAgreesWithDb,
  lifecycleRig,
  round6,
  webhook,
  type LifecycleRig,
} from "./failure-matrix-lifecycle-webhooks-litellm.helpers";

/** Subscribe, then let Chargebee end the subscription (and its credits) with no webhook yet. */
async function endedInChargebee() {
  const r = lifecycleRig();
  await r.subscribe("sub_1");
  r.cb.cancel("sub_1");
  r.cb.expireGrants("sub_1");
  return r;
}

/** A call served on the stale cap, refused by Chargebee at the next tick: account exhausted, team blocked. */
async function refusedBeforeTheWebhook(r: LifecycleRig) {
  expect(r.llmCall("late:1", T0 + 30_000, 0.1)).toBe(true);
  r.at(2);
  const { summary } = await r.tick();
  expect(summary.outOfCredits).toBe(1);
  expect(r.account().status).toBe("exhausted");
  expect(r.gateway.team_).toMatchObject({ blocked: true, metadata: { [BLOCK_REASON]: "exhausted" } });
}

// ── the hand-back ──────────────────────────────────────────────────────────

describe("a cancellation hands the team back whole", () => {
  it("P1: a team blocked (exhausted) when the cancellation arrives is unblocked, not left blocked with ownership gone", async () => {
    const r = await endedInChargebee();
    await refusedBeforeTheWebhook(r);

    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
    r.gateway.platformReconcile();

    expect(r.account().status).toBe("cancelled");
    expect(r.gateway.team_.blocked).toBe(false);
    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBeUndefined();
    expect(r.gateway.team_.metadata[BLOCK_REASON]).toBeUndefined();
    expect(r.llmCall("free:1", T0 + 3 * MINUTE, 0.1)).toBe(true); // back on the free plan
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  it("a team blocked BY HAND (no billing reason) stays blocked when it is handed back", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.gateway.team_.blocked = true; // an operator blocked it in LiteLLM

    r.cb.cancel("sub_1");
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));

    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBeUndefined();
    expect(r.gateway.team_.blocked).toBe(true);
  });

  it("P4: a tenant whose LiteLLM team is gone is cancelled cleanly — no 500 on every redelivery, no daily tenant error", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.gateway.team = async () => null; // the team was deleted (or never provisioned)

    r.cb.cancel("sub_1");
    const cancelled = webhook("subscription_cancelled", r.cb.sub("sub_1"));
    await expect(r.deliver(cancelled)).resolves.toBeUndefined();
    await expect(r.deliver(cancelled)).resolves.toBeUndefined();

    expect(r.account().status).toBe("cancelled");
    expect(await r.accounts.resyncAll()).toMatchObject({ errors: [] });
    expect(r.metrics()).toContain("billing.budget.release_no_team");
  });

  it("a LiteLLM that cannot be reached still fails the release, so it is retried", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.gateway.down = true;
    r.cb.cancel("sub_1");
    await expect(r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")))).rejects.toThrow(/team\/info failed/);
  });
});

// ── held usage on an ended subscription ────────────────────────────────────

describe("a refused window on an ended subscription is written off, once", () => {
  it("P1 + 8 days: nothing is re-sent, the handed-back team is not blocked again, no behind alarm — one write-off error", async () => {
    const r = await endedInChargebee();
    await refusedBeforeTheWebhook(r);
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
    const sent = r.cb.sent.length;

    r.at(3);
    const { summary } = await r.tick();
    expect(summary.writtenOff).toBe(1);

    for (const day of [1, 2, 8]) {
      r.at(day * 24 * 60);
      await r.tick();
      await r.tick();
    }

    expect(r.cb.sent.length).toBe(sent); // not one capture after the cancellation
    expect(r.prisma._stuck).toBeUndefined();
    expect(r.prisma._log).toEqual([expect.objectContaining({ status: SYNC.WRITTEN_OFF, amount: "100", settledAt: null })]);
    expect(r.gateway.team_.blocked).toBe(false);
    expect(r.account().status).toBe("cancelled");
    expect(r.metrics().filter((m) => m === "billing.sync.written_off")).toHaveLength(1);
    expect(r.metrics()).not.toContain("billing.sync.behind");
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
    expect(r.cb.ledger.appliedCount).toBe(0);
  });

  it("a row still UNKNOWN when the account is cancelled is looked up, not written off blind", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    expect(r.llmCall("a:1", T0 + 30_000, 0.1)).toBe(true);
    r.cb.ledger.loseResponseNext = true; // the charge lands, the answer is lost
    r.at(2);
    await r.tick();
    expect(r.prisma._stuck).toMatchObject({ status: SYNC.UNKNOWN });

    r.cb.cancel("sub_1");
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
    r.at(3);
    await r.tick();

    expect(r.prisma._log).toEqual([expect.objectContaining({ status: SYNC.SUCCESS })]);
    expect(r.cb.ledger.appliedCount).toBe(1);
    expect(r.metrics()).not.toContain("billing.sync.written_off");
  });

  it("a row that is refused only AFTER the cancellation neither blocks the handed-back team nor stays held", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.cb.expireGrants("sub_1");
    expect(r.llmCall("a:1", T0 + 30_000, 0.1)).toBe(true);
    // The first send's answer is lost before Chargebee applied anything: UNKNOWN.
    r.cb.ledger.failNext = { kind: "retryable", error: Object.assign(new Error("Chargebee timeout"), { retryable: true }) };
    r.at(2);
    await r.tick();
    expect(r.prisma._stuck).toMatchObject({ status: SYNC.UNKNOWN });

    r.cb.cancel("sub_1");
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
    expect(r.gateway.team_.blocked).toBe(false);

    // The recovery looks it up (not there), sends it, and Chargebee refuses it.
    r.at(3);
    await r.tick();

    expect(r.account().status).toBe("cancelled");
    expect(r.gateway.team_.blocked).toBe(false);
    expect(r.metrics()).not.toContain("billing.budget.exhausted_blocked");
    expect(r.prisma._log).toEqual([expect.objectContaining({ status: SYNC.WRITTEN_OFF })]);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  // Found alongside the finding above: the account moves to a new subscription
  // (the old one's cancellation webhook lost), and the refused row pinned to the
  // old one held the tenant for ever — the new subscription's usage was never
  // billed, and every minute the refusal marked the NEW account exhausted and
  // blocked its team.
  it("a refusal pinned to a subscription the account has left no longer holds the new subscription's billing", async () => {
    const r = await endedInChargebee();
    await refusedBeforeTheWebhook(r);

    // No subscription_cancelled for sub_1. The customer buys sub_2.
    r.at(3);
    await r.subscribe("sub_2", { credits: 1000 });
    expect(r.account()).toMatchObject({ chargebeeSubscriptionId: "sub_2", status: "active" });

    r.at(4);
    await r.tick();
    expect(r.prisma._stuck).toBeUndefined();
    expect(r.account().status).toBe("active");
    expect(r.gateway.team_.blocked).toBe(false);

    expect(r.llmCall("new:1", T0 + 4.5 * MINUTE, 0.2)).toBe(true);
    r.at(6);
    await r.tick();
    expect(r.cb.takenFor("sub_2")).toBe(200);
    expect(r.cb.takenFor("sub_1")).toBe(0);
    expect(r.account().status).toBe("active");
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  it("an old row refused on recovery does not mark the NEW subscription's account exhausted", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    expect(r.llmCall("a:1", T0 + 30_000, 0.1)).toBe(true);
    r.cb.ledger.failNext = { kind: "retryable", error: Object.assign(new Error("Chargebee timeout"), { retryable: true }) };
    r.at(2);
    await r.tick();
    expect(r.prisma._stuck).toMatchObject({ status: SYNC.UNKNOWN, chargebeeSubscriptionId: "sub_1" });

    // sub_1 ends with no webhook; the customer is on sub_2 before the row is recovered.
    r.cb.cancel("sub_1");
    r.cb.expireGrants("sub_1");
    r.at(3);
    await r.subscribe("sub_2", { credits: 1000 });

    // Chargebee refuses the old row against sub_1 (the fake keeps one ledger, so say so for this tick).
    r.cb.ledger.insufficient = true;
    r.at(4);
    await r.tick();
    r.cb.ledger.insufficient = false;

    expect(r.account()).toMatchObject({ chargebeeSubscriptionId: "sub_2", status: "active" });
    expect(r.gateway.team_.blocked).toBe(false);
    expect(r.prisma._log).toEqual([expect.objectContaining({ status: SYNC.WRITTEN_OFF, chargebeeSubscriptionId: "sub_1" })]);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });
});

// ── activations racing a cancellation ──────────────────────────────────────

describe("an activation in flight never brings a cancelled account back", () => {
  /** Deliver the cancellation from INSIDE the next call to `method`, once. */
  function cancelDuring(r: LifecycleRig, method: "balance" | "grantBlocks" | "allocate") {
    const client = r.cb.client as unknown as Record<string, (...args: never[]) => Promise<unknown>>;
    const original = client[method]!;
    let fired = false;
    client[method] = async (...args: never[]) => {
      const out = await original(...args);
      if (!fired) {
        fired = true;
        r.cb.cancel("sub_1");
        await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
      }
      return out;
    };
  }

  it("P2: the minute's gate check re-opening a blocked active team while the cancellation lands", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    await r.budget.block(TENANT, "exhausted"); // active, team blocked by billing: the gate check will reopen it

    cancelDuring(r, "balance");
    r.at(1);
    await r.tick();

    expect(r.account().status).toBe("cancelled");
    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBeUndefined();
    expect(r.gateway.team_.blocked).toBe(false);
    expect(r.metrics()).toContain("billing.account.cancelled_during_activation");
    expect(gatewayAgreesWithDb(r).ok).toBe(true);

    // And the usage sync does not bill it.
    r.llmCall("free:1", T0 + 90_000, 0.1);
    r.at(4);
    await r.tick();
    expect(r.cb.ledger.appliedCount).toBe(0);
  });

  it("P3: a top-up being applied when the cancellation lands allocates nothing and raises the paid invoice", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.cb.payPack("inv_1");

    cancelDuring(r, "grantBlocks"); // the last read before anything is granted
    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "1000")).toEqual({ applied: 0, credits: "0" });

    expect(r.cb.allocations).toHaveLength(0);
    expect(r.account().status).toBe("cancelled");
    expect(r.errors).toContainEqual(expect.objectContaining({ metric: "billing.topup.refused_cancelled", invoiceIds: ["inv_1"] }));
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  it("P3: a cancellation landing just after the allocation leaves the account cancelled and the team handed back", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.cb.payPack("inv_1");

    cancelDuring(r, "allocate");
    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "1000")).toEqual({ applied: 1, credits: "1000" });

    expect(r.account().status).toBe("cancelled");
    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBeUndefined();
    expect(r.metrics()).toContain("billing.topup.allocated_to_cancelled");
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  it("an exhausted block that lands after the cancellation's release is handed back again", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.cb.expireGrants("sub_1");
    r.llmCall("a:1", T0 + 30_000, 0.1);

    // The refused capture's block is slow; the cancellation lands (and releases) while it is on the wire.
    let releaseBlock!: () => void;
    r.gateway.holdBlockWrites = new Promise<void>((resolve) => (releaseBlock = resolve));
    r.at(2);
    const ticking = r.tick();
    await r.gateway.blockHeld;
    r.cb.cancel("sub_1");
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
    releaseBlock();
    await ticking;

    expect(r.account().status).toBe("cancelled");
    expect(r.gateway.team_.blocked).toBe(false);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });
});

// ── what counts as "ended" ─────────────────────────────────────────────────

describe("only a definite answer ends a subscription", () => {
  it("P5: a wrong site or key (nothing found) cancels nobody — it is logged and the account is left as it is", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.cb.wrongSite = true;

    expect(await r.accounts.resyncAll()).toMatchObject({ errors: [] });

    expect(r.account().status).toBe("active");
    expect(r.gateway.team_.metadata[BILLING_MANAGED]).toBe(true);
    expect(r.metrics()).toContain("billing.subscription.gone");
  });

  it("a subscription deleted in Chargebee (its customer still there) does cancel the account", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.cb.subscriptions = r.cb.subscriptions.filter((s) => s.id !== "sub_1");

    await r.accounts.resyncAll();

    expect(r.account().status).toBe("cancelled");
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });

  it("P5 (real client): only a 404 resource_not_found is 'no such subscription'; invalid_request and an empty 200 throw", async () => {
    const answers: Record<string, () => Response> = {
      gone: () => json(404, { api_error_code: "resource_not_found", message: "Sorry, we couldn't find that resource" }),
      bad: () => json(400, { api_error_code: "invalid_request", message: "The site is not valid" }),
      empty: () => json(200, {}),
      live: () => json(200, { subscription: { id: "live", status: "active" } }),
    };
    const fetchImpl = (async (url: URL) => answers[String(url).split("/").pop()!]!()) as unknown as typeof fetch;
    const cb = createChargebee({ site: "s", apiKey: "k", fetchImpl, maxAttempts: 1, sleep: async () => {} });

    expect(await cb.subscription("gone")).toBeNull();
    await expect(cb.subscription("bad")).rejects.toThrow(/not valid/);
    await expect(cb.subscription("empty")).rejects.toThrow(/no subscription/);
    expect(await cb.subscription("live")).toMatchObject({ status: "active" });
    expect(await cb.customer("gone")).toBeNull();
    await expect(cb.customer("bad")).rejects.toThrow();
  });
});

// ── the renewal baseline ───────────────────────────────────────────────────

describe("a renewal pushed late still leaves LiteLLM agreeing with Chargebee", () => {
  it("P6: usage between the renewal and the push is not spendable twice at the gateway", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });
    expect(r.llmCall("t1:a", T0 + 30_000, 0.3)).toBe(true);
    r.at(2);
    await r.tick();

    // Renewal at minute 5; the webhook is lost.
    r.at(5);
    r.cb.renew("sub_1", { start: T0_S + 5 * 60, credits: 1000 });
    // 0.5 spent in the new term on the old cap, captured from the new grant.
    expect(r.llmCall("t2:a", T0 + 5.5 * MINUTE, 0.5)).toBe(true);
    r.at(7);
    await r.tick();
    expect(r.cb.ledger.balance).toBe(500);

    await r.accounts.resyncAll(); // the daily repair finds the renewal

    expect(r.account().currentTermStart).toEqual(new Date((T0_S + 5 * 60) * 1000));
    expect(round6(r.gateway.headroomUsd() * 1000)).toBe(r.cb.ledger.balance);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);

    // And a second delivery of the same renewal moves nothing.
    const cap = r.gateway.team_.maxBudget;
    await r.deliver(webhook("subscription_renewed", r.cb.sub("sub_1")));
    expect(r.gateway.team_.maxBudget).toBe(cap);
  });

  it("a renewal pushed straight away still opens the whole new grant", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });
    expect(r.llmCall("t1:a", T0 + 30_000, 0.7)).toBe(true);
    r.at(2);
    await r.tick();

    r.cb.renew("sub_1", { start: T0_S + 30 * DAY_S, credits: 1000 });
    await r.deliver(webhook("subscription_renewed", r.cb.sub("sub_1")));

    expect(r.gateway.headroomUsd()).toBe(1);
    expect(gatewayAgreesWithDb(r).ok).toBe(true);
  });
});

// ── the minute's gate check ────────────────────────────────────────────────

describe("the gate check reopens only what billing blocked, within its time", () => {
  it("a team blocked by hand on an active account is left blocked", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.gateway.team_.blocked = true; // no billing reason on it

    r.at(1);
    const { gates } = await r.tick();

    expect(gates).toEqual({ checked: 1, reopened: 0 });
    expect(r.gateway.team_.blocked).toBe(true);
  });

  it("stops at its deadline, and leaves the rest for the next minute", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    await r.budget.block(TENANT, "exhausted");

    expect(await r.accounts.reopenBlockedActive({ deadline: r.now() })).toEqual({ checked: 0, reopened: 0 });
    expect(r.gateway.team_.blocked).toBe(true);
    expect(r.metrics()).toContain("billing.budget.gate_check_deadline");

    expect(await r.accounts.reopenBlockedActive({ deadline: r.now() + MINUTE })).toEqual({ checked: 1, reopened: 1 });
  });

  it("runs after the usage sync in the worker, so a hung LiteLLM cannot starve billing", () => {
    const worker = readFileSync(fileURLToPath(new URL("../worker/hatchet-worker.ts", import.meta.url)), "utf8");
    const sweep = worker.slice(worker.indexOf('name: "sweep"'));
    expect(sweep.indexOf(".runOnce()")).toBeGreaterThan(0);
    expect(sweep.indexOf(".reopenBlockedActive(")).toBeGreaterThan(sweep.indexOf(".runOnce()"));
    expect(sweep).toMatch(/reopenBlockedActive\(\{ deadline:/);
  });
});

// ── top-ups across subscriptions ───────────────────────────────────────────

describe("a paid pack is granted once, whichever subscription it went to", () => {
  // Found alongside the top-up finding: the guard scanned only the LINKED
  // subscription's ledger, so after a resubscription every pack already
  // granted to the old subscription looked unapplied and was granted again.
  it("a pack granted to the old subscription is not granted again after resubscribing", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1");
    r.cb.payPack("inv_0");
    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "1000")).toEqual({ applied: 1, credits: "1000" });

    r.cb.cancel("sub_1");
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
    r.at(2);
    await r.subscribe("sub_2");

    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "1000")).toEqual({ applied: 0, credits: "0" });
    expect(r.cb.allocations).toHaveLength(1);

    // A pack paid for now still goes to the new subscription.
    r.cb.payPack("inv_2");
    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "1000")).toEqual({ applied: 1, credits: "1000" });
    expect(r.cb.allocations[1]).toMatchObject({ subscriptionId: "sub_2", metadata: { invoice_id: "inv_2" } });
  });
});

// ── the Chargebee request timer ────────────────────────────────────────────

describe("a Chargebee response body that stalls", () => {
  /** Headers arrive at once; the body never finishes until the request is aborted. */
  function stallingBody(status = 200) {
    return (async (_url: URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ledger_operation":'));
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  }

  it("is cut off by the request timeout, and an accepted capture whose body never arrived is an unknown", async () => {
    const cb = createChargebee({ site: "s", apiKey: "k", fetchImpl: stallingBody(), timeoutMs: 30, maxAttempts: 1 });
    const started = Date.now();
    const result = await cb.capture({ id: "b1", subscriptionId: "sub_1", unitId: "u", amount: "1" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.kind).toBe("retryable"); // never `captured` on a body we did not read, never `{}`
  });

  it("an unreadable 200 is never read as 'no such subscription'", async () => {
    const cb = createChargebee({ site: "s", apiKey: "k", fetchImpl: stallingBody(), timeoutMs: 30, maxAttempts: 1 });
    await expect(cb.subscription("sub_1")).rejects.toThrow(/unreadable/);
  });
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
