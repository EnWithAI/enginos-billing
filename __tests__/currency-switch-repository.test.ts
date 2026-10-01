/**
 * `currency_switch` — the stored request for each money movement of a
 * currency switch (currency-switch.repository.ts). Every write is a
 * compare-and-set, and each is pinned here for what it compares:
 *
 *   create            one open switch per tenant
 *   the lease         one advancer at a time; a dead one's runs out; and every
 *                     write is FENCED by it — an advancer whose lease was taken
 *                     over writes nothing more
 *   abandonIfRequested
 *                     the address changed before the switch started (no lease)
 *   start             under the account row's lock: still REQUESTED; live on A
 *                     with no top-up charge on the wire; the billing country
 *                     still wants this currency (else ABANDONED); nothing that
 *                     may have landed — then MOVING and `switching`, together
 *   carry inputs      held back and B's own grant, each recorded once
 *   drain / mirror    stored before sent; settled once, by the stored amount
 *   link              under the lock: `switching` on A, MOVING to THIS B with
 *                     nothing in flight — then on B, re-pinned, LINKED
 *   activation, done, abort
 */

import { describe, expect, it } from "vitest";

import { ACCOUNT } from "@/models/account-status";
import type { CurrencyRules } from "@/models/currency";
import { SYNC } from "@/models/sync-status";
import { createChargebeeSyncRepository } from "@/repositories/chargebee-sync.repository";
import {
  SWITCH,
  SWITCH_LEASE_MS,
  carryInvoiceId,
  createCurrencySwitchRepository,
  type CurrencySwitch,
  type SwitchLease,
} from "@/repositories/currency-switch.repository";

import { Gate } from "./failure-matrix-crash-and-concurrency.helpers";
import { MINUTE, T0, TENANT, makeFakePrisma } from "./harness";

const RULES: CurrencyRules = { defaultCurrency: "USD", byCountry: { IN: "INR" } };
const AT = new Date(T0);
const later = (minutes: number) => new Date(T0 + minutes * MINUTE);

/** An org billed in INR on sub_A that has just confirmed a US address: its switch is to USD. */
function rig(account: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma(
    {
      chargebeeCustomerId: TENANT,
      chargebeeSubscriptionId: "sub_A",
      ledgerUnitId: "token-test",
      status: ACCOUNT.ACTIVE,
      currency: "INR",
      billingCountry: "US",
      ...account,
    } as never,
    T0,
  );
  return { prisma, switches: createCurrencySwitchRepository(prisma), syncs: createChargebeeSyncRepository(prisma) };
}

type Rig = ReturnType<typeof rig>;

async function requested(r: Rig): Promise<CurrencySwitch> {
  const sw = await r.switches.create({
    tenantId: TENANT,
    fromSubscriptionId: "sub_A",
    fromCurrency: "INR",
    toCurrency: "USD",
    toItemPriceId: "pre-paid-test-v1-USD-Yearly",
    at: AT,
  });
  return sw!;
}

/** A REQUESTED switch, and this advancer's lease on it. */
async function leased(r: Rig): Promise<{ sw: CurrencySwitch; lease: SwitchLease }> {
  const sw = await requested(r);
  return { sw, lease: (await r.switches.takeLease(sw.id, AT))! };
}

/** A switch started (MOVING), with B recorded, under this advancer's lease. */
async function moving(r: Rig): Promise<{ sw: CurrencySwitch; lease: SwitchLease }> {
  const { lease } = await leased(r);
  await r.switches.setToSubscription(lease, "sub_B", AT);
  const started = await r.switches.start(lease, { at: AT, rules: RULES });
  if (!started.started) throw new Error(`not started: ${started.reason}`);
  return { sw: started.switch, lease };
}

async function window(r: Rig, status: string, fromMin: number, subscriptionId = "sub_A") {
  return r.syncs.create({
    tenantId: TENANT,
    chargebeeSubscriptionId: subscriptionId,
    ledgerUnitId: "token-test",
    fromIngestedAt: later(fromMin),
    toIngestedAt: later(fromMin + 1),
    eventCount: 1,
    amount: "2",
    billedUsd: "0.002",
    status,
    error: null,
    settledAt: status === SYNC.SUCCESS ? AT : null,
    hatchetRunId: null,
  });
}

/** A carry allocate's guard row, as the switch's carry step writes one. */
function carryRow(r: Rig, switchId: string, status: "SENDING" | "PENDING" | "APPLIED") {
  const id = `tg_${r.prisma._topUps.size}`;
  r.prisma._topUps.set(id, {
    id,
    tenantId: TENANT,
    invoiceId: carryInvoiceId(switchId, `gb_${id}`),
    chargebeeSubscriptionId: "sub_B",
    ledgerUnitId: "token-test",
    credits: "100",
    expiresAt: later(60 * 24 * 365),
    idempotencyKey: `carry-key-${id}`,
    keyIssuedAt: AT,
    status,
    source: "allocation",
    chargebeeRef: status === "APPLIED" ? "ledger_operation:op" : null,
    attemptCount: 1,
    error: null,
    createdAt: AT,
    updatedAt: AT,
    appliedAt: status === "APPLIED" ? AT : null,
  });
}

const account = (r: Rig) => r.prisma._accounts.get(TENANT)!;
const stored = (r: Rig, id: string) => r.prisma._switches.get(id)!;

describe("create, find, list", () => {
  it("records the request — and nothing else: the account is untouched", async () => {
    const r = rig();

    expect(await requested(r)).toMatchObject({
      fromSubscriptionId: "sub_A",
      fromCurrency: "INR",
      toCurrency: "USD",
      toSubscriptionId: null,
      status: SWITCH.REQUESTED,
      drained: "0",
      heldBack: "0",
      ownGrant: "0",
      leaseOwner: null,
      attemptCount: 0,
    });
    expect(account(r)).toMatchObject({ status: ACCOUNT.ACTIVE, chargebeeSubscriptionId: "sub_A" });
  });

  it("allows one open switch per tenant: a second ask answers null, and the first is the switch", async () => {
    const r = rig();
    const first = await requested(r);

    expect(
      await r.switches.create({ tenantId: TENANT, fromSubscriptionId: "sub_A", fromCurrency: "INR", toCurrency: "EUR", toItemPriceId: "x", at: AT }),
    ).toBeNull();
    expect((await r.switches.findOpen(TENANT))?.id).toBe(first.id);
  });

  it("allows a new one once the last has ended; lists the open only, oldest first; the latest is the newest of all", async () => {
    const r = rig();
    const first = await requested(r);
    await r.switches.abandonIfRequested(first.id, "country_changed", AT);
    const second = (await r.switches.create({
      tenantId: TENANT,
      fromSubscriptionId: "sub_A",
      fromCurrency: "INR",
      toCurrency: "USD",
      toItemPriceId: "x",
      at: later(1),
    }))!;

    expect((await r.switches.listOpen()).map((s) => s.id)).toEqual([second.id]);
    expect((await r.switches.latestFor(TENANT))?.id).toBe(second.id);
    await r.switches.abandonIfRequested(second.id, "timed_out", later(2));
    expect(await r.switches.latestFor(TENANT)).toMatchObject({ id: second.id, status: SWITCH.ABANDONED, error: "timed_out" });
    expect(await r.switches.findOpen(TENANT)).toBeNull();
  });
});

describe("the lease: one advancer at a time, and every write fenced by it", () => {
  it("is taken by one with a fresh owner, for SWITCH_LEASE_MS unless said, refused to another while it runs, and counts the attempt", async () => {
    const r = rig();
    const sw = await requested(r);

    const lease = (await r.switches.takeLease(sw.id, AT))!;
    expect(lease).toEqual({ id: sw.id, owner: expect.stringMatching(/^[0-9a-f-]{36}$/), until: new Date(T0 + SWITCH_LEASE_MS) });
    expect(SWITCH_LEASE_MS).toBeGreaterThanOrEqual(5 * MINUTE);
    expect(await r.switches.takeLease(sw.id, new Date(T0 + SWITCH_LEASE_MS - 1))).toBeNull();
    expect(stored(r, sw.id)).toMatchObject({ leaseOwner: lease.owner, attemptCount: 1 });
  });

  it("runs out: a dead advancer's lease is taken over, under a new owner", async () => {
    const r = rig();
    const { sw, lease } = await leased(r);

    const next = (await r.switches.takeLease(sw.id, lease.until))!;
    expect(next.owner).not.toBe(lease.owner);
    expect(stored(r, sw.id).attemptCount).toBe(2);
  });

  it("is released only by its holder: a stale one cannot clear the lease that replaced it", async () => {
    const r = rig();
    const { sw, lease: stale } = await leased(r);
    const current = (await r.switches.takeLease(sw.id, stale.until))!;

    expect(await r.switches.releaseLease(stale)).toBe(false);
    expect(stored(r, sw.id).leaseOwner).toBe(current.owner);
    expect(await r.switches.releaseLease(current)).toBe(true);
    expect(stored(r, sw.id)).toMatchObject({ leaseOwner: null, leaseUntil: null });
  });

  it("fences: an advancer whose lease was taken over writes nothing more, whatever it does", async () => {
    const r = rig();
    const { sw, lease: stale } = await leased(r);
    await r.switches.takeLease(sw.id, stale.until); // another advancer, now

    expect(await r.switches.setToSubscription(stale, "sub_B", AT)).toBe(false);
    expect(await r.switches.start(stale, { at: AT, rules: RULES })).toEqual({ started: false, reason: "switch" });
    expect(await r.switches.abandonRequested(stale, "stale", AT)).toBe(false);
    expect(stored(r, sw.id)).toMatchObject({ status: SWITCH.REQUESTED, toSubscriptionId: null });
    expect(account(r).status).toBe(ACCOUNT.ACTIVE);
  });

  it("fences MOVING writes too: drains, mirrors and the link", async () => {
    const r = rig();
    const { sw, lease: stale } = await moving(r);
    const current = (await r.switches.takeLease(sw.id, stale.until))!;
    const drain = (await r.switches.recordDrain(current, "10", AT))!;

    expect(await r.switches.recordDrain(stale, "10", AT)).toBeNull();
    expect(await r.switches.settleDrain(stale, drain.operationId, AT)).toBe(false);
    expect(await r.switches.dropDrain(stale, drain.operationId, AT)).toBe(false);
    expect(await r.switches.recordMirror(stale, "5", AT)).toBeNull();
    expect(await r.switches.link(stale, { subscriptionId: "sub_B", ledgerUnitId: "token-test", at: AT })).toEqual({ linked: false, reason: "switch" });
    expect(stored(r, sw.id)).toMatchObject({ drainOperationId: drain.operationId, drained: "0", status: SWITCH.MOVING });
  });

  it("is never taken on a switch that has ended", async () => {
    const r = rig();
    const sw = await requested(r);
    await r.switches.abandonIfRequested(sw.id, "country_changed", AT);

    expect(await r.switches.takeLease(sw.id, AT)).toBeNull();
  });
});

describe("abandonIfRequested: the address changed before the switch started", () => {
  it("gives up a REQUESTED switch with the reason — no lease needed — and leaves completed_at for DONE", async () => {
    const r = rig();
    const { sw } = await leased(r); // even while an advancer holds it

    expect(await r.switches.abandonIfRequested(sw.id, "country_changed", later(1))).toBe(true);
    expect(stored(r, sw.id)).toMatchObject({ status: SWITCH.ABANDONED, error: "country_changed", completedAt: null, updatedAt: later(1) });
  });

  it("does nothing to a switch that has started: it is no longer the address change's to stop", async () => {
    const r = rig();
    const { sw } = await moving(r);

    expect(await r.switches.abandonIfRequested(sw.id, "country_changed", AT)).toBe(false);
    expect(stored(r, sw.id).status).toBe(SWITCH.MOVING);
  });
});

describe("B, recorded once with when it was made — before the switch starts or after", () => {
  it("is recorded while REQUESTED: an unlinked B is harmless, and the account is untouched", async () => {
    const r = rig();
    const { sw, lease } = await leased(r);

    expect(await r.switches.setToSubscription(lease, "sub_B", later(1))).toBe(true);
    expect(await r.switches.setToSubscription(lease, "sub_C", later(2))).toBe(false);
    expect(stored(r, sw.id)).toMatchObject({ toSubscriptionId: "sub_B", toSubscriptionAt: later(1), status: SWITCH.REQUESTED });
    expect(account(r).chargebeeSubscriptionId).toBe("sub_A");
  });

  it("is recorded while MOVING, when it was not before", async () => {
    const r = rig();
    const { lease } = await leased(r);
    await r.switches.start(lease, { at: AT, rules: RULES });

    expect(await r.switches.setToSubscription(lease, "sub_B", later(1))).toBe(true);
  });
});

describe("start: REQUESTED → MOVING, the account `switching`, together — or nothing", () => {
  it("starts, recording the unit every movement will be in, and quiesces the account", async () => {
    const r = rig();
    const { lease } = await leased(r);

    const started = await r.switches.start(lease, { at: later(1), rules: RULES });

    expect(started).toMatchObject({ started: true, switch: { status: SWITCH.MOVING, movingAt: later(1), ledgerUnitId: "token-test" } });
    expect(account(r).status).toBe(ACCOUNT.SWITCHING);
    expect(r.prisma._rowLocked(TENANT)).toBe(false);
  });

  it("starts an exhausted account's, and records no unit for one with no wallet", async () => {
    const exhausted = rig({ status: ACCOUNT.EXHAUSTED });
    expect((await exhausted.switches.start((await leased(exhausted)).lease, { at: AT, rules: RULES })).started).toBe(true);

    const walletless = rig({ ledgerUnitId: null });
    expect(await walletless.switches.start((await leased(walletless)).lease, { at: AT, rules: RULES })).toMatchObject({
      switch: { ledgerUnitId: null },
    });
  });

  it.each([
    ["activating", { status: ACCOUNT.ACTIVATING }],
    ["cancelled", { status: ACCOUNT.CANCELLED }],
    ["already switching", { status: ACCOUNT.SWITCHING }],
    ["linked to another subscription", { chargebeeSubscriptionId: "sub_Z" }],
  ])("refuses an account that is %s — and writes nothing", async (_label, over) => {
    const r = rig(over);
    const { sw, lease } = await leased(r);
    const before = { ...account(r) };

    expect(await r.switches.start(lease, { at: AT, rules: RULES })).toEqual({ started: false, reason: "account" });
    expect(account(r)).toMatchObject({ status: before.status, chargebeeSubscriptionId: before.chargebeeSubscriptionId });
    expect(stored(r, sw.id).status).toBe(SWITCH.REQUESTED);
  });

  it("waits for a top-up charge on the wire, and starts once its lease has run out", async () => {
    const r = rig({ topupChargingUntil: later(2) });
    const { sw, lease } = await leased(r);

    expect(await r.switches.start(lease, { at: later(1), rules: RULES })).toEqual({ started: false, reason: "topup-charging" });
    expect(stored(r, sw.id).status).toBe(SWITCH.REQUESTED);
    expect((await r.switches.start(lease, { at: later(2), rules: RULES })).started).toBe(true);
  });

  it("abandons the switch when the billing country no longer wants its currency — read under the lock — and leaves the account alone", async () => {
    const r = rig();
    const { sw, lease } = await leased(r);
    // The org saved an Indian address again before the switch started.
    await createBillingCountry(r, "IN");

    expect(await r.switches.start(lease, { at: AT, rules: RULES })).toEqual({ started: false, reason: "country-changed" });
    expect(stored(r, sw.id)).toMatchObject({ status: SWITCH.ABANDONED, error: "country_changed" });
    expect(account(r)).toMatchObject({ status: ACCOUNT.ACTIVE, chargebeeSubscriptionId: "sub_A" });
  });

  it.each([SYNC.PROCESSING, SYNC.UNKNOWN, SYNC.RATE_LIMITING])("waits while a capture is %s — it may have landed on A — and writes nothing", async (status) => {
    const r = rig();
    await window(r, status, 0);
    const { sw, lease } = await leased(r);

    expect(await r.switches.start(lease, { at: AT, rules: RULES })).toEqual({ started: false, reason: "in-flight" });
    expect(account(r).status).toBe(ACCOUNT.ACTIVE);
    expect(stored(r, sw.id)).toMatchObject({ status: SWITCH.REQUESTED, movingAt: null });
  });

  it("is not held up by windows never sent, refused, or settled", async () => {
    const r = rig();
    await window(r, SYNC.PENDING, 0);
    await window(r, SYNC.OUT_OF_CREDITS, 1);
    await window(r, SYNC.SUCCESS, 2);

    expect((await r.switches.start((await leased(r)).lease, { at: AT, rules: RULES })).started).toBe(true);
  });

  it("refuses a switch no longer REQUESTED — abandoned meanwhile, or already started", async () => {
    const r = rig();
    const { sw, lease } = await leased(r);
    await r.switches.abandonIfRequested(sw.id, "country_changed", AT);
    expect(await r.switches.start(lease, { at: AT, rules: RULES })).toEqual({ started: false, reason: "switch" });
    expect(account(r).status).toBe(ACCOUNT.ACTIVE);

    const again = rig();
    const { lease: once } = await moving(again);
    expect(await again.switches.start(once, { at: AT, rules: RULES })).toEqual({ started: false, reason: "switch" });
  });

  it("a claim after the start sends nothing; the row waits, never applied, to be re-pinned", async () => {
    const r = rig();
    const pending = await window(r, SYNC.PENDING, 0);
    await moving(r);

    expect(await r.syncs.claim(pending)).toBeNull();
    expect(r.prisma._syncs.get(pending.id)).toMatchObject({ status: SYNC.PENDING, attemptCount: 0 });
  });

  it("a claim INSIDE its transaction when the start arrives: the start waits on the lock, then sees it in flight", async () => {
    const r = rig();
    const pending = await window(r, SYNC.PENDING, 0);
    const { lease } = await leased(r);
    const gate = new Gate();
    const stalled = new Proxy(r.prisma, {
      get(target: any, key: string) {
        if (key !== "chargebeeSync") return target[key];
        return new Proxy(target.chargebeeSync, {
          get(sync: any, method: string) {
            if (method !== "updateMany") return sync[method];
            return async (args: any) => {
              if (args.data?.status === SYNC.PROCESSING) await gate.pass();
              return sync.updateMany(args);
            };
          },
        });
      },
    });
    const claim = createChargebeeSyncRepository(stalled as never).claim(pending);
    await gate.reached;

    const start = r.switches.start(lease, { at: AT, rules: RULES });
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    expect(account(r).status).toBe(ACCOUNT.ACTIVE); // the start is waiting on the claim's lock

    gate.open();
    expect(await claim).toEqual({ id: pending.id, attemptCount: 1 });
    expect(await start).toEqual({ started: false, reason: "in-flight" });
    expect(account(r).status).toBe(ACCOUNT.ACTIVE);
  });
});

/** The billing-address route's write of the confirmed country. */
async function createBillingCountry(r: Rig, country: string) {
  await r.prisma.billingAccount.update({ where: { tenantId: TENANT }, data: { billingCountry: country } });
}

describe("what the carry holds back, and what B granted by itself: each recorded once", () => {
  it("held back: recorded once, and never once anything has been drained", async () => {
    const r = rig();
    const { sw, lease } = await moving(r);

    expect(await r.switches.recordHeldBack(lease, "250", AT)).toBe(true);
    expect(await r.switches.recordHeldBack(lease, "300", AT)).toBe(false);
    expect(stored(r, sw.id).heldBack).toBe("250");

    const drained = rig();
    const { lease: l2 } = await moving(drained);
    const d = (await drained.switches.recordDrain(l2, "10", AT))!;
    await drained.switches.settleDrain(l2, d.operationId, AT);
    expect(await drained.switches.recordHeldBack(l2, "250", AT)).toBe(false);
  });

  it("B's own grant: recorded once, and never once the mirror is recorded", async () => {
    const r = rig();
    const { sw, lease } = await moving(r);

    expect(await r.switches.recordOwnGrant(lease, "1", AT)).toBe(true);
    expect(await r.switches.recordOwnGrant(lease, "2", AT)).toBe(false);
    expect(stored(r, sw.id).ownGrant).toBe("1");

    const mirrored = rig();
    const { lease: l2 } = await moving(mirrored);
    await mirrored.switches.recordMirror(l2, "600", AT);
    expect(await mirrored.switches.recordOwnGrant(l2, "1", AT)).toBe(false);
  });

  it("refuses a negative figure: credits are never below zero (the column's CHECK)", async () => {
    const r = rig();
    const { lease } = await moving(r);
    await expect(r.switches.recordOwnGrant(lease, "-1", AT)).rejects.toThrow("currency_switch_carry_nonneg");
  });
});

describe("the drain and the mirror: each stored before it is sent, settled once", () => {
  it("records nothing on a switch not MOVING", async () => {
    const r = rig();
    const { lease } = await leased(r);

    expect(await r.switches.recordDrain(lease, "10", AT)).toBeNull();
    expect(await r.switches.recordMirror(lease, "10", AT)).toBeNull();
  });

  it("stores a drain's id and amount before it is sent; a second waits for the first to settle", async () => {
    const r = rig();
    const { sw, lease } = await moving(r);

    expect(await r.switches.recordDrain(lease, "400.50", AT, "op-drain-1")).toEqual({ operationId: "op-drain-1", amount: "400.5" });
    expect(stored(r, sw.id)).toMatchObject({ drainOperationId: "op-drain-1", drainAmount: "400.5" });
    expect(await r.switches.recordDrain(lease, "1", AT)).toBeNull();
  });

  it.each(["0", "-5"])("refuses a drain of %s credits — Chargebee refuses a zero capture, so it would never settle", async (amount) => {
    const r = rig();
    const { lease } = await moving(r);
    await expect(r.switches.recordDrain(lease, amount, AT)).rejects.toThrow(RangeError);
  });

  it("settles a drain by its STORED amount, once: a repeat, or one under another id, adds nothing", async () => {
    const r = rig();
    const { sw, lease } = await moving(r);
    const first = (await r.switches.recordDrain(lease, "0.1", AT))!;

    expect(await r.switches.settleDrain(lease, first.operationId, AT)).toBe(true);
    expect(await r.switches.settleDrain(lease, first.operationId, AT)).toBe(false);
    const second = (await r.switches.recordDrain(lease, "0.2", AT))!;
    expect(await r.switches.settleDrain(lease, "someone-elses", AT)).toBe(false);
    expect(await r.switches.settleDrain(lease, second.operationId, AT)).toBe(true);

    // Exact, as Chargebee's ledger is: 0.1 + 0.2 is 0.3.
    expect(stored(r, sw.id)).toMatchObject({ drained: "0.3", drainOperationId: null, drainAmount: null });
    expect((await r.switches.findById(sw.id))!.drained).toBe("0.3");
  });

  it("drops a drain Chargebee never applied, without counting it", async () => {
    const r = rig();
    const { sw, lease } = await moving(r);
    const drain = (await r.switches.recordDrain(lease, "50", AT))!;

    expect(await r.switches.dropDrain(lease, "not-this-one", AT)).toBe(false);
    expect(await r.switches.dropDrain(lease, drain.operationId, AT)).toBe(true);
    expect(stored(r, sw.id)).toMatchObject({ drained: "0", drainOperationId: null });
  });

  it("records the mirror only with no drain outstanding — once — and settles it once", async () => {
    const r = rig();
    const { sw, lease } = await moving(r);
    const drain = (await r.switches.recordDrain(lease, "400", AT))!;
    expect(await r.switches.recordMirror(lease, "600", AT)).toBeNull();
    await r.switches.settleDrain(lease, drain.operationId, AT);

    expect(await r.switches.recordMirror(lease, "600", AT, "op-mirror")).toEqual({ operationId: "op-mirror", amount: "600" });
    expect(await r.switches.recordMirror(lease, "650", AT)).toBeNull();
    expect(await r.switches.settleMirror(lease, "not-this-one", AT)).toBe(false);
    expect(await r.switches.settleMirror(lease, "op-mirror", later(1))).toBe(true);
    expect(await r.switches.settleMirror(lease, "op-mirror", later(2))).toBe(false);
    expect(stored(r, sw.id)).toMatchObject({ mirrorAmount: "600", mirroredAt: later(1) });
  });
});

describe("link: billing moves to B, its held windows with it, together", () => {
  const to = { subscriptionId: "sub_B", ledgerUnitId: "token-test", currentTermStart: later(1), currentTermEnd: later(60 * 24 * 365), at: later(2) };

  it("relinks the account to B — plan, unit, currency, term — keeps it `switching`, and re-pins only never-applied windows", async () => {
    const r = rig();
    const owed = await window(r, SYNC.OUT_OF_CREDITS, 0);
    const pending = await window(r, SYNC.PENDING, 1);
    const settled = await window(r, SYNC.SUCCESS, 2);
    const { lease } = await moving(r);
    const cursor = r.prisma._cursor;

    const linked = await r.switches.link(lease, to);

    expect(linked).toMatchObject({ linked: true, repointed: 2, switch: { status: SWITCH.LINKED, linkedAt: later(2) } });
    expect(account(r)).toMatchObject({
      chargebeeSubscriptionId: "sub_B",
      chargebeeItemPriceId: "pre-paid-test-v1-USD-Yearly",
      ledgerUnitId: "token-test",
      currency: "USD",
      currentTermStart: later(1),
      status: ACCOUNT.SWITCHING,
    });
    expect([owed, pending, settled].map((w) => r.prisma._syncs.get(w.id)!.chargebeeSubscriptionId)).toEqual(["sub_B", "sub_B", "sub_A"]);
    expect(r.prisma._cursor).toBe(cursor); // the switch never moves the cursor
    expect(r.prisma._rowLocked(TENANT)).toBe(false);
  });

  it.each([
    ["a drain is outstanding", async (r: Rig, lease: SwitchLease) => void (await r.switches.recordDrain(lease, "5", AT))],
    ["the mirror has not landed", async (r: Rig, lease: SwitchLease) => void (await r.switches.recordMirror(lease, "5", AT))],
  ])("refuses while %s — and writes nothing", async (_label, prepare) => {
    const r = rig();
    const { sw, lease } = await moving(r);
    await prepare(r, lease);

    expect(await r.switches.link(lease, to)).toEqual({ linked: false, reason: "switch" });
    expect(account(r)).toMatchObject({ chargebeeSubscriptionId: "sub_A", status: ACCOUNT.SWITCHING, currency: "INR" });
    expect(stored(r, sw.id).status).toBe(SWITCH.MOVING);
  });

  it("refuses a B other than the one recorded", async () => {
    const r = rig();
    const { lease } = await moving(r);

    expect(await r.switches.link(lease, { ...to, subscriptionId: "sub_C" })).toEqual({ linked: false, reason: "switch" });
    expect(account(r).chargebeeSubscriptionId).toBe("sub_A");
  });

  it("refuses an account not `switching` on A — and re-pins nothing", async () => {
    const r = rig();
    const { sw, lease } = await moving(r);
    r.prisma._accounts.get(TENANT)!.status = ACCOUNT.ACTIVE;
    const owed = await window(r, SYNC.OUT_OF_CREDITS, 0);

    expect(await r.switches.link(lease, to)).toEqual({ linked: false, reason: "account" });
    expect(stored(r, sw.id).status).toBe(SWITCH.MOVING);
    expect(r.prisma._syncs.get(owed.id)!.chargebeeSubscriptionId).toBe("sub_A");
  });
});

describe("activation, done, and what blocks top-ups", () => {
  const to = { subscriptionId: "sub_B", ledgerUnitId: "token-test", at: AT };

  it("blocks while REQUESTED, MOVING, and LINKED until the cap has moved; DONE only once activated", async () => {
    const r = rig();
    const { sw, lease } = await leased(r);
    expect((await r.switches.findBlocking(TENANT))?.id).toBe(sw.id);

    await r.switches.setToSubscription(lease, "sub_B", AT);
    await r.switches.start(lease, { at: AT, rules: RULES });
    expect((await r.switches.findBlocking(TENANT))?.id).toBe(sw.id);

    await r.switches.link(lease, to);
    expect((await r.switches.findBlocking(TENANT))?.id).toBe(sw.id);
    expect(await r.switches.markDone(lease, AT)).toBe(false); // not activated yet

    expect(await r.switches.markActivated(lease, later(1))).toBe(true);
    expect(await r.switches.markActivated(lease, later(2))).toBe(false);
    expect(await r.switches.findBlocking(TENANT)).toBeNull(); // cancelling A blocks nothing
    expect((await r.switches.findOpen(TENANT))?.id).toBe(sw.id); // …but the switch is still open

    expect(await r.switches.markDone(lease, later(3))).toBe(true);
    expect(stored(r, sw.id)).toMatchObject({ status: SWITCH.DONE, activatedAt: later(1), completedAt: later(3), error: null });
  });
});

describe("abandon and abort: only before any money moved", () => {
  it("the advancer gives up a REQUESTED switch it holds, saying why", async () => {
    const r = rig();
    const { sw, lease } = await leased(r);

    expect(await r.switches.abandonRequested(lease, "timed_out", AT)).toBe(true);
    expect(stored(r, sw.id)).toMatchObject({ status: SWITCH.ABANDONED, error: "timed_out" });
  });

  it("aborts a MOVING switch that moved nothing — even with a carry not (yet) applied", async () => {
    const r = rig();
    const { sw, lease } = await moving(r);
    carryRow(r, sw.id, "PENDING");

    expect(await r.switches.abort(lease, "chargebee_refused", AT)).toBe(true);
    expect(stored(r, sw.id)).toMatchObject({ status: SWITCH.ABANDONED, error: "chargebee_refused" });
  });

  it.each([
    ["a carry applied", async (r: Rig, sw: CurrencySwitch) => carryRow(r, sw.id, "APPLIED")],
    [
      "a drain settled",
      async (r: Rig, _sw: CurrencySwitch, lease: SwitchLease) => {
        const d = (await r.switches.recordDrain(lease, "5", AT))!;
        await r.switches.settleDrain(lease, d.operationId, AT);
      },
    ],
    ["a drain outstanding", async (r: Rig, _sw: CurrencySwitch, lease: SwitchLease) => void (await r.switches.recordDrain(lease, "5", AT))],
    ["a mirror recorded", async (r: Rig, _sw: CurrencySwitch, lease: SwitchLease) => void (await r.switches.recordMirror(lease, "5", AT))],
  ])("refuses to abort a MOVING switch with %s — it must be finished, not abandoned", async (_label, prepare) => {
    const r = rig();
    const { sw, lease } = await moving(r);
    await prepare(r, sw, lease);

    expect(await r.switches.abort(lease, "too late", AT)).toBe(false);
    expect(stored(r, sw.id).status).toBe(SWITCH.MOVING);
  });

  it("notes why an open switch waits, never over the reason an ended one ended with", async () => {
    const r = rig();
    const sw = await requested(r);
    await r.switches.noteError(sw.id, "waiting: a top-up is unpaid", AT);
    expect(stored(r, sw.id).error).toBe("waiting: a top-up is unpaid");

    await r.switches.abandonIfRequested(sw.id, "country_changed", AT);
    await r.switches.noteError(sw.id, "late note", AT);
    expect(stored(r, sw.id).error).toBe("country_changed");
  });
});
