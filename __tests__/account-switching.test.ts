/**
 * What the currency switch asks of the account service and the gateway cap —
 * and what every other writer must leave alone while it runs.
 *
 *   A SWITCHING ACCOUNT IS THE SWITCH'S. An activation (the minute's retries,
 *   a top-up, the gate check) and a subscription sync (a webhook, the daily
 *   resync, a page's pull) leave it exactly as it is: no push, no status
 *   write, no block, not one Chargebee call.
 *
 *   THE CAP DOES NOT MOVE (A17). activateAfterSwitch pushes the cap onto the
 *   new subscription with its own plan grant netted out of the baseline —
 *   never the renewal rebase, which with an unread balance moved the cap by
 *   every credit already used. A push that fails, or will not guess, leaves
 *   the account `switching` for the switch to try again; a repeat after it
 *   worked moves nothing twice.
 *
 *   ALLOCATE ONCE (A12). A carry is decided by the guard row as it stands
 *   after the attempt — applied, or pending — never by what the attempt
 *   returned; a lost answer is resumed under the same key, a dead key is
 *   searched for first and re-issued with the carried block's OWN expiry, and
 *   two equal-amount carries are told apart by their expiries.
 */

import { describe, expect, it, vi } from "vitest";

import type { ChargebeeClient } from "@/integrations/chargebee";
import { ACCOUNT } from "@/models/account-status";
import { carryInvoiceId } from "@/repositories/currency-switch.repository";
import { TOPUP_KEY_REPLAY_MS, TOPUP_MIN_EXPIRY_LEAD_MS, createAccountService } from "@/services/account.service";
import {
  BASELINE_TERM,
  BILLING_MANAGED,
  BLOCK_REASON,
  SPEND_BASELINE,
  SwitchPushRefused,
  budgetHooksFor,
  createGatewayBudget,
} from "@/services/gateway-budget.service";

import { FakeGateway, TEAM, UNIT, lifecycleRig, type LifecycleRig } from "./failure-matrix-lifecycle-webhooks-litellm.helpers";
import { MINUTE, RATE, T0, TENANT, makeFakePrisma, quietLogger } from "./harness";

/** A's term, which the cap's baseline was taken for, and B's — the new subscription's, later. */
const A_TERM = new Date("2026-09-01T00:00:00.000Z");
const B_TERM = new Date("2026-10-01T10:00:00.000Z");

/**
 * The moment after a currency switch LINKED the account to B: `switching`,
 * on B, B's term. The team still holds A's cap: baseline $0.20 (its spend
 * when billing took it over), A's 1,000 credits ($1.00 at RATE) — $1.20 —
 * and $0.80 spent, 800 credits.
 */
function linkedToB(opts: { usable?: string | null; granted?: string; termStart?: Date | null; managed?: boolean } = {}) {
  const prisma = makeFakePrisma({
    chargebeeCustomerId: TENANT,
    chargebeeSubscriptionId: "sub_b",
    chargebeeItemPriceId: "free-usd",
    ledgerUnitId: UNIT,
    currency: "USD",
    status: ACCOUNT.SWITCHING,
    currentTermStart: opts.termStart === undefined ? B_TERM : opts.termStart,
  } as never);
  const gateway = new FakeGateway();
  gateway.team_ = {
    spend: 0.8,
    maxBudget: 1.2,
    budgetDuration: null,
    blocked: false,
    metadata:
      opts.managed === false ? { plan: "free" } : { [BILLING_MANAGED]: true, [SPEND_BASELINE]: 0.2, [BASELINE_TERM]: A_TERM.toISOString() },
  };
  // B carries A's 1,000 credits, plus the 1 its own plan granted on creation (the USD free plan, MEASURED).
  const granted = opts.granted ?? "1001";
  const budget = createGatewayBudget({ gateway, usdPerCredit: RATE, teamIdFor: async () => TEAM, grantedCreditsFor: async () => granted });
  const hooks = budgetHooksFor(budget);
  const warns: Array<Record<string, unknown>> = [];
  const usable = opts.usable === undefined ? "200" : opts.usable;
  const accounts = createAccountService({
    prisma,
    chargebee: {
      balance: async () => (usable == null ? null : { unitId: UNIT, unitName: UNIT, usable, onHold: "0" }),
    } as unknown as ChargebeeClient,
    usdPerCredit: RATE,
    logger: { ...quietLogger, warn: (o: unknown) => void warns.push(o as Record<string, unknown>) },
    ...hooks,
  });
  return { prisma, gateway, accounts, warns, account: () => prisma._accounts.get(TENANT)! };
}

describe("activateAfterSwitch: the cap moves onto the new subscription and does not move (A17)", () => {
  it("nets B's own plan grant out of the baseline: max_budget after is max_budget before, and B's term is adopted", async () => {
    const r = linkedToB();

    const after = await r.accounts.activateAfterSwitch(TENANT, { ownGrant: "1" });

    expect(after.status).toBe(ACCOUNT.ACTIVE);
    expect(r.gateway.team_.maxBudget).toBe(1.2);
    expect(r.gateway.team_.metadata).toMatchObject({ [SPEND_BASELINE]: 0.199, [BASELINE_TERM]: B_TERM.toISOString() });
    // Headroom is what A had left: $1.20 − $0.80 = 400 credits — B's usable 200 plus usage not yet captured, as before the switch.
    expect(r.gateway.team_.blocked).toBe(false);
  });

  it("keeps the cap where it was even when no balance could be read — where the renewal rebase would have moved it by every credit used", async () => {
    const r = linkedToB({ usable: null });

    await r.accounts.activateAfterSwitch(TENANT, { ownGrant: "1" });
    expect(r.gateway.team_.maxBudget).toBe(1.2);

    // The same account activated the ordinary way: B's later term reads as a
    // renewal, and with no balance the baseline jumps to the team's spend.
    const ordinary = linkedToB({ usable: null });
    ordinary.account().status = ACCOUNT.ACTIVE;
    await ordinary.accounts.activate(TENANT);
    expect(ordinary.gateway.team_.maxBudget).toBe(1.801); // $0.80 spent + 1,001 credits: 600 credits never bought
  });

  it("is safe to repeat once it worked — the switch re-run after a crash: the baseline moves once", async () => {
    const r = linkedToB();
    await r.accounts.activateAfterSwitch(TENANT, { ownGrant: "1" });

    await r.accounts.activateAfterSwitch(TENANT, { ownGrant: "1" });

    expect(r.gateway.team_.metadata[SPEND_BASELINE]).toBe(0.199);
    expect(r.gateway.team_.maxBudget).toBe(1.2);
    expect(r.account().status).toBe(ACCOUNT.ACTIVE);
  });

  it("a push that fails leaves the account switching — not activating, not blocked — for the switch to try again", async () => {
    const r = linkedToB();
    r.gateway.pushFails = true;

    const after = await r.accounts.activateAfterSwitch(TENANT, { ownGrant: "1" });

    expect(after.status).toBe(ACCOUNT.SWITCHING);
    expect(r.account().status).toBe(ACCOUNT.SWITCHING);
    expect(r.gateway.team_).toMatchObject({ blocked: false, maxBudget: 1.2 }); // the org keeps working on the cap it had
    expect(r.warns).toContainEqual(expect.objectContaining({ metric: "billing.currency_switch.activation_waiting" }));
  });

  it("will not guess: no stored baseline and no balance read, or no term to adopt — the account stays switching", async () => {
    const unmanaged = linkedToB({ managed: false, usable: null });
    expect((await unmanaged.accounts.activateAfterSwitch(TENANT, { ownGrant: "1" })).status).toBe(ACCOUNT.SWITCHING);
    expect(unmanaged.warns).toContainEqual(expect.objectContaining({ reason: expect.stringMatching(/no stored spend baseline/) }));

    const termless = linkedToB({ termStart: null });
    expect((await termless.accounts.activateAfterSwitch(TENANT, { ownGrant: "1" })).status).toBe(ACCOUNT.SWITCHING);
    expect(termless.gateway.updates).toEqual([]);
  });

  it("a team with no stored baseline is built the renewal way, against the balance read: headroom is the usable balance", async () => {
    const r = linkedToB({ managed: false, usable: "400" });

    await r.accounts.activateAfterSwitch(TENANT, { ownGrant: "1" });

    // Consumed on B = 1,001 − 400 = 601: baseline 0.8 − 0.601 = 0.199; max 0.199 + 1.001 = 1.2; headroom 400 credits.
    expect(r.gateway.team_.maxBudget).toBe(1.2);
    expect(r.gateway.team_.metadata).toMatchObject({ [BILLING_MANAGED]: true, [SPEND_BASELINE]: 0.199, [BASELINE_TERM]: B_TERM.toISOString() });
  });

  it("carried credits that are all used up: exhausted, and its team blocked as such", async () => {
    const r = linkedToB({ usable: "0" });

    expect((await r.accounts.activateAfterSwitch(TENANT, { ownGrant: "1" })).status).toBe(ACCOUNT.EXHAUSTED);
    expect(r.gateway.team_).toMatchObject({ blocked: true, maxBudget: 1.2 });
    expect(r.gateway.team_.metadata[BLOCK_REASON]).toBe("exhausted");
  });

  it("a switch abandoned before it moved anything puts the account back on A as any activation would — a failed push holds it activating", async () => {
    const r = linkedToB();
    r.gateway.pushFails = true;

    const after = await r.accounts.activate(TENANT, ACCOUNT.ACTIVE, { fromSwitching: true });

    // Out of `switching`, so the minute's activatePending takes it from here.
    expect(after.status).toBe(ACCOUNT.ACTIVATING);
    expect(r.gateway.team_.blocked).toBe(true);
  });
});

describe("the gateway's switch push, on its own", () => {
  it("refuses — writes nothing — rather than build a cap from nothing", async () => {
    const gateway = new FakeGateway();
    const budget = createGatewayBudget({ gateway, usdPerCredit: RATE, teamIdFor: async () => TEAM, grantedCreditsFor: async () => "1000" });

    await expect(budget.push(TENANT, { termStart: B_TERM, switchAdjustCredits: "0" })).rejects.toBeInstanceOf(SwitchPushRefused);
    await expect(budget.push(TENANT, { termStart: null, switchAdjustCredits: "0" })).rejects.toMatchObject({ reason: "no_term" });
    expect(gateway.updates).toEqual([]);
  });
});

describe("a switching account is the switch's alone", () => {
  function switchingAccount() {
    const prisma = makeFakePrisma({ chargebeeCustomerId: TENANT, chargebeeSubscriptionId: "sub_1", ledgerUnitId: UNIT, status: ACCOUNT.SWITCHING } as never);
    const chargebee = {
      activeSubscriptions: vi.fn(async () => []),
      balance: vi.fn(async () => ({ unitId: UNIT, unitName: UNIT, usable: "0", onHold: "0" })),
      subscription: vi.fn(async () => null),
    };
    const pushBudget = vi.fn(async () => {});
    const blockBudget = vi.fn(async () => {});
    const releaseBudget = vi.fn(async () => {});
    const accounts = createAccountService({
      prisma,
      chargebee: chargebee as unknown as ChargebeeClient,
      usdPerCredit: RATE,
      pushBudget,
      blockBudget,
      releaseBudget,
      logger: quietLogger,
    });
    return { prisma, chargebee, accounts, gateway: { pushBudget, blockBudget, releaseBudget } };
  }

  it("an activation returns it untouched: no balance read, no push, no status, no block", async () => {
    const r = switchingAccount();
    const before = { ...r.prisma._accounts.get(TENANT) };

    expect(await r.accounts.activate(TENANT)).toEqual(before);

    expect(r.prisma._accounts.get(TENANT)).toEqual(before);
    expect(r.chargebee.balance).not.toHaveBeenCalled();
    expect(r.gateway.pushBudget).not.toHaveBeenCalled();
    expect(r.gateway.blockBudget).not.toHaveBeenCalled();
    expect(r.gateway.releaseBudget).not.toHaveBeenCalled();
  });

  it("a subscription sync — a webhook, the daily resync — returns it untouched, and asks Chargebee nothing", async () => {
    const r = switchingAccount();
    const before = { ...r.prisma._accounts.get(TENANT) };

    expect(await r.accounts.syncFromChargebee(TENANT)).toEqual(before);
    // Nothing active would otherwise have CANCELLED it — the switch's own old subscription, mid-move.
    expect(r.chargebee.activeSubscriptions).not.toHaveBeenCalled();
    expect(r.chargebee.subscription).not.toHaveBeenCalled();
    expect(r.prisma._accounts.get(TENANT)).toEqual(before);
  });

  it("the minute's retries pass it by: activatePending and the gate check list neither it nor its team", async () => {
    const r = switchingAccount();

    expect(await r.accounts.activatePending()).toEqual({ pending: 0, activated: 0 });
    expect(r.gateway.pushBudget).not.toHaveBeenCalled();
    expect(r.prisma._accounts.get(TENANT)!.status).toBe(ACCOUNT.SWITCHING);
  });
});

/** A switch id and a block of A, for a carry guard id. */
const SWITCH_ID = "5b6c9f0e-1d2a-4c3b-9e8f-7a6b5c4d3e2f";
const EXPIRY = new Date(T0 + 365 * 24 * 60 * MINUTE + 999); // a pack's far expiry — with milliseconds, which allocate cannot take

function carryRig() {
  const r = lifecycleRig();
  // B: the new subscription the carry copies onto. Not linked — nothing else touches it.
  r.cb.subscribe("sub_b", { credits: 0 });
  const carry = (block: string, over: Partial<Parameters<LifecycleRig["accounts"]["allocateOnce"]>[0]> = {}) =>
    r.accounts.allocateOnce({
      tenantId: TENANT,
      guardId: carryInvoiceId(SWITCH_ID, block),
      subscriptionId: "sub_b",
      unitId: UNIT,
      credits: "600",
      expiresAt: EXPIRY,
      ...over,
    });
  const row = (block: string) => [...r.prisma._topUps.values()].find((t: { invoiceId: string }) => t.invoiceId === carryInvoiceId(SWITCH_ID, block));
  return { ...r, r, carry, row };
}

describe("allocateOnce: one carry, exactly once, decided by its guard row (A12)", () => {
  it("allocates once — under the guard id as its key, with the block's expiry to the second — and a repeat sends nothing", async () => {
    const { r, carry, row } = carryRig();

    expect(await carry("gb_1")).toEqual({ kind: "applied", credits: "600" });
    expect(await carry("gb_1")).toEqual({ kind: "applied", credits: "600" });

    expect(r.cb.allocateCalls).toEqual([
      {
        subscriptionId: "sub_b",
        unitId: UNIT,
        amount: "600",
        expiresAt: Math.floor(EXPIRY.getTime() / 1000),
        idempotencyKey: carryInvoiceId(SWITCH_ID, "gb_1"),
        metadata: { invoice_id: carryInvoiceId(SWITCH_ID, "gb_1"), tenant_id: TENANT },
      },
    ]);
    expect(row("gb_1")).toMatchObject({ status: "APPLIED", source: "allocation", chargebeeSubscriptionId: "sub_b" });
    // A move, not a top-up: no cap pushed, the account not activated.
    expect(r.gateway.updates).toEqual([]);
  });

  it("an answer lost on the way back is pending — the row says may-have-landed — and the next attempt replays it: one grant", async () => {
    const { r, carry, row } = carryRig();
    r.cb.allocateFaults.push("lose-response");

    expect(await carry("gb_1")).toEqual({ kind: "pending", reason: "unknown_outcome" });
    expect(row("gb_1")).toMatchObject({ status: "PENDING" });

    expect(await carry("gb_1")).toEqual({ kind: "applied", credits: "600" });
    expect(r.cb.allocations).toHaveLength(1);
    expect(r.cb.allocateCalls).toHaveLength(2);
  });

  it("another caller sending it right now is pending too — never taken for 'already granted'", async () => {
    const { r, carry, row } = carryRig();
    r.cb.allocateFaults.push("unreachable");
    await carry("gb_1");
    // The row is PENDING; make it another caller's send, inside its lease.
    row("gb_1")!.status = "SENDING";
    row("gb_1")!.updatedAt = new Date(r.now());

    expect(await carry("gb_1")).toEqual({ kind: "pending", reason: "sending" });
    expect(r.cb.allocateCalls).toHaveLength(1);
  });

  it("a definite refusal is pending, and says so — the switch may give up while nothing has moved", async () => {
    const { r, carry, row } = carryRig();
    r.cb.allocateFaults.push("refuse");

    expect(await carry("gb_1")).toEqual({ kind: "pending", reason: "refused", refused: true });
    expect(row("gb_1")).toMatchObject({ status: "PENDING" });
  });

  it("a guard row holding another request is never sent for this one", async () => {
    const { r, carry } = carryRig();
    await carry("gb_1");

    expect(await carry("gb_1", { credits: "700" })).toEqual({ kind: "pending", reason: "guard_mismatch" });
    expect(r.cb.allocateCalls).toHaveLength(1);
    expect(r.metrics()).toContain("billing.topup.guard_mismatch");
  });

  it("past its key's window, a carry that never landed is re-sent under a new key with the BLOCK'S expiry — not the new term's end", async () => {
    const { r, carry, row } = carryRig();
    r.cb.allocateFaults.push("unreachable");
    expect((await carry("gb_1")).kind).toBe("pending");

    r.at(TOPUP_KEY_REPLAY_MS / MINUTE + 1);
    expect(await carry("gb_1")).toEqual({ kind: "applied", credits: "600" });

    expect(r.cb.allocateCalls[1]).toMatchObject({
      idempotencyKey: `${carryInvoiceId(SWITCH_ID, "gb_1")}:2`,
      expiresAt: Math.floor(EXPIRY.getTime() / 1000),
    });
    expect(row("gb_1")).toMatchObject({ status: "APPLIED", attemptCount: 2 });
  });

  it("…and a stored expiry that has come too close is moved out to the least lead a stored request needs", async () => {
    const { r, carry } = carryRig();
    r.cb.allocateFaults.push("unreachable");
    // A plan block ending soon after the switch started.
    await carry("gb_1", { expiresAt: new Date(T0 + TOPUP_MIN_EXPIRY_LEAD_MS + MINUTE) });

    const minutes = TOPUP_KEY_REPLAY_MS / MINUTE + 1;
    r.at(minutes);
    await carry("gb_1", { expiresAt: new Date(T0 + TOPUP_MIN_EXPIRY_LEAD_MS + MINUTE) });

    expect(r.cb.allocateCalls[1]!.expiresAt).toBe(Math.floor((T0 + minutes * MINUTE + TOPUP_MIN_EXPIRY_LEAD_MS) / 1000));
  });

  it("two carries of the same size are told apart by their expiries — the one that never landed is re-sent, not credited with the other's block", async () => {
    const { r, carry, row } = carryRig();
    const packExpiry = new Date(Date.UTC(2149, 11, 31));
    const planExpiry = new Date(T0 + 30 * 24 * 60 * MINUTE);
    r.cb.allocateFaults.push("lose-response", "unreachable");
    expect((await carry("gb_pack", { expiresAt: packExpiry })).kind).toBe("pending"); // landed, answer lost
    expect((await carry("gb_plan", { expiresAt: planExpiry })).kind).toBe("pending"); // never landed

    // Both keys dead. The one that never landed is looked for first — matched
    // on size and time alone, it found the pack's block.
    r.at(TOPUP_KEY_REPLAY_MS / MINUTE + 1);
    expect(await carry("gb_plan", { expiresAt: planExpiry })).toEqual({ kind: "applied", credits: "600" });
    expect(await carry("gb_pack", { expiresAt: packExpiry })).toEqual({ kind: "applied", credits: "600" });

    expect(row("gb_plan")).toMatchObject({ attemptCount: 2, chargebeeRef: expect.stringMatching(/^ledger_operation:/) });
    expect(row("gb_pack")).toMatchObject({ chargebeeRef: expect.stringMatching(/^grant_block:/) });
    const granted = r.cb.allocations.map((a) => a.expiresAt).sort();
    expect(granted).toEqual([Math.floor(planExpiry.getTime() / 1000), Math.floor(packExpiry.getTime() / 1000)].sort());
  });
});
