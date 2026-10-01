/**
 * The guards a currency switch needs from the two existing tables — each a
 * compare-and-set in billing-account.repository.ts or
 * chargebee-sync.repository.ts, tested against the fake Prisma's own model of
 * Postgres (its row lock, its CHECKs).
 *
 *   linkSubscription      only from the subscription the caller chose from, and
 *                         never while `switching`
 *   status writes         never over `switching` (but for the switch itself)
 *   cursor writes         none while `switching`; a cancelled-gap restart only
 *                         while the account still reads as the caller saw it
 *   openWindow / claim    none while `switching`, and only for a row pinned
 *                         where the account still bills
 *   repointHeld           only rows Chargebee never applied
 */

import { describe, expect, it } from "vitest";

import { ACCOUNT } from "@/models/account-status";
import { SYNC } from "@/models/sync-status";
import { createBillingAccountRepository } from "@/repositories/billing-account.repository";
import { createChargebeeSyncRepository, type ChargebeeSync } from "@/repositories/chargebee-sync.repository";

import { Gate } from "./failure-matrix-crash-and-concurrency.helpers";
import { MINUTE, SLUG, T0, TENANT, makeFakePrisma } from "./harness";

const OTHER = "22222222-2222-4222-8222-222222222222";

function rig(account: Record<string, unknown> = {}, cursorAt: number | undefined = T0) {
  const prisma = makeFakePrisma({ chargebeeCustomerId: TENANT, chargebeeSubscriptionId: "sub_A", ledgerUnitId: "token", ...account } as never, cursorAt);
  return { prisma, accounts: createBillingAccountRepository(prisma), syncs: createChargebeeSyncRepository(prisma) };
}

/** A window row as the usage sync writes one: pinned, with a status. */
async function row(
  syncs: ReturnType<typeof createChargebeeSyncRepository>,
  status: string,
  { fromMin = 0, subscriptionId = "sub_A", unitId = "token", tenantId = TENANT } = {},
): Promise<ChargebeeSync> {
  return syncs.create({
    tenantId,
    chargebeeSubscriptionId: subscriptionId,
    ledgerUnitId: unitId,
    fromIngestedAt: new Date(T0 + fromMin * MINUTE),
    toIngestedAt: new Date(T0 + (fromMin + 1) * MINUTE),
    eventCount: 1,
    amount: "1",
    billedUsd: "0.001",
    status,
    error: null,
    settledAt: status === SYNC.SUCCESS ? new Date(T0) : null,
    hatchetRunId: null,
  });
}

/** Wraps the fake so that ONE caller's claim stalls INSIDE its transaction, after it took the account row's lock. */
function stallingAtClaimCas(prisma: ReturnType<typeof makeFakePrisma>, gate: Gate) {
  return new Proxy(prisma, {
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
}

const turns = async (n = 50) => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

describe("linkSubscription: a compare-and-set on the subscription the caller chose from", () => {
  const LINK = { chargebeeSubscriptionId: "sub_B", chargebeeItemPriceId: "free-usd", ledgerUnitId: "token", currency: "USD", status: ACCOUNT.ACTIVE };

  it("links when the account is still on what the chooser saw", async () => {
    const { accounts, prisma } = rig();

    const result = await accounts.linkSubscription(TENANT, "sub_A", LINK);

    expect(result.linked).toBe(true);
    expect(result.account).toMatchObject({ chargebeeSubscriptionId: "sub_B", chargebeeItemPriceId: "free-usd", currency: "USD" });
    expect(prisma._accounts.get(TENANT)!.chargebeeSubscriptionId).toBe("sub_B");
  });

  it("links a first subscription from none (expected null), and re-links the same one", async () => {
    const { accounts } = rig({ chargebeeSubscriptionId: null, ledgerUnitId: null, status: "unlinked" });

    expect((await accounts.linkSubscription(TENANT, null, LINK)).linked).toBe(true);
    expect((await accounts.linkSubscription(TENANT, "sub_B", { ...LINK, ledgerUnitId: "token" })).linked).toBe(true);
  });

  it("writes NOTHING when another writer moved the account since — a stale sync cannot put the old link back", async () => {
    const { accounts, prisma } = rig({ chargebeeSubscriptionId: "sub_B", currency: "USD" });
    const before = { ...prisma._accounts.get(TENANT)! };

    const stale = await accounts.linkSubscription(TENANT, "sub_A", {
      chargebeeSubscriptionId: "sub_A",
      ledgerUnitId: "token",
      currency: "INR",
      status: ACCOUNT.ACTIVE,
    });

    expect(stale.linked).toBe(false);
    expect(stale.account).toEqual(before);
    expect(prisma._accounts.get(TENANT)).toEqual(before);
  });

  it("writes nothing to a switching account, even from the right subscription — only the switch relinks it", async () => {
    const { accounts, prisma } = rig({ status: ACCOUNT.SWITCHING });

    expect((await accounts.linkSubscription(TENANT, "sub_A", LINK)).linked).toBe(false);
    expect(prisma._accounts.get(TENANT)).toMatchObject({ chargebeeSubscriptionId: "sub_A", status: ACCOUNT.SWITCHING });
  });

  it("keeps the stored currency when the link names none", async () => {
    const { accounts } = rig({ currency: "INR" });

    const { account } = await accounts.linkSubscription(TENANT, "sub_A", { chargebeeSubscriptionId: "sub_A", ledgerUnitId: "token", status: ACCOUNT.ACTIVE });
    expect(account!.currency).toBe("INR");
  });

  it("answers no account for a tenant with no row", async () => {
    const { accounts } = rig();
    expect(await accounts.linkSubscription(OTHER, null, LINK)).toEqual({ linked: false, account: null });
  });
});

describe("setBillingCountry", () => {
  it("stores the confirmed country, and null forgets it", async () => {
    const { accounts, prisma } = rig();

    expect((await accounts.setBillingCountry(TENANT, "IN")).billingCountry).toBe("IN");
    await accounts.setBillingCountry(TENANT, null);
    expect(prisma._accounts.get(TENANT)!.billingCountry).toBeNull();
  });

  it.each(["in", "IND", "1N"])("is refused by the column's CHECK for %s — billing stores upper-case alpha-2 only", async (country) => {
    const { accounts } = rig();
    await expect(accounts.setBillingCountry(TENANT, country)).rejects.toThrow("billing_account_billing_country_check");
  });
});

describe("status writes never land on a switching account", () => {
  it("setStatusUnlessCancelled refuses `switching`, and says so with the account as it stands", async () => {
    const { accounts } = rig({ status: ACCOUNT.SWITCHING });

    const result = await accounts.setStatusUnlessCancelled(TENANT, ACCOUNT.ACTIVE);

    expect(result.changed).toBe(false);
    expect(result.account.status).toBe(ACCOUNT.SWITCHING);
  });

  it("…unless the currency switch itself says so (overSwitching)", async () => {
    const { accounts } = rig({ status: ACCOUNT.SWITCHING });

    const result = await accounts.setStatusUnlessCancelled(TENANT, ACCOUNT.EXHAUSTED, { overSwitching: true });

    expect([result.changed, result.account.status]).toEqual([true, ACCOUNT.EXHAUSTED]);
  });

  it("never over `cancelled`, overSwitching or not", async () => {
    const { accounts } = rig({ status: ACCOUNT.CANCELLED });

    expect((await accounts.setStatusUnlessCancelled(TENANT, ACCOUNT.ACTIVE, { overSwitching: true })).changed).toBe(false);
    expect((await accounts.setStatusUnlessCancelled(TENANT, ACCOUNT.ACTIVE)).account.status).toBe(ACCOUNT.CANCELLED);
  });

  it("still moves every other status, as before", async () => {
    const { accounts } = rig({ status: ACCOUNT.ACTIVATING });
    expect((await accounts.setStatusUnlessCancelled(TENANT, ACCOUNT.ACTIVE)).changed).toBe(true);
  });

  it.each([
    [ACCOUNT.SWITCHING, false],
    [ACCOUNT.CANCELLED, false],
    [ACCOUNT.ACTIVE, true],
  ])("markExhaustedUnlessCancelled over %s: %s", async (status, marked) => {
    const { accounts, prisma } = rig({ status });

    expect(await accounts.markExhaustedUnlessCancelled(TENANT)).toBe(marked);
    expect(prisma._accounts.get(TENANT)!.status).toBe(marked ? ACCOUNT.EXHAUSTED : status);
  });
});

describe("the cursor while switching, and the cancelled-gap restart", () => {
  it("advancePastEmptyWindow refuses a switching account: the cursor does not move", async () => {
    const { accounts, prisma } = rig({ status: ACCOUNT.SWITCHING });

    expect(await accounts.advancePastEmptyWindow(TENANT, new Date(T0), new Date(T0 + MINUTE))).toEqual({ moved: false, owner: null });
    expect(prisma._cursor).toBe(T0);
  });

  it("advancePastEmptyWindow still moves an active account's cursor", async () => {
    const { accounts, prisma } = rig();

    expect((await accounts.advancePastEmptyWindow(TENANT, new Date(T0), new Date(T0 + MINUTE))).moved).toBe(true);
    expect(prisma._cursor).toBe(T0 + MINUTE);
  });

  it("restartCursorAt moves a cancelled account's cursor forward — only while it is cancelled on what the caller read", async () => {
    const cancelled = rig({ status: ACCOUNT.CANCELLED });
    expect(await cancelled.accounts.restartCursorAt(TENANT, new Date(T0 + 5 * MINUTE), "sub_A")).toBe(true);
    expect(cancelled.prisma._cursor).toBe(T0 + 5 * MINUTE);

    // Relinked (and billing again) since the caller read it: the live cursor is not the caller's to move.
    const relinked = rig({ status: ACCOUNT.ACTIVE, chargebeeSubscriptionId: "sub_B" });
    expect(await relinked.accounts.restartCursorAt(TENANT, new Date(T0 + 5 * MINUTE), "sub_A")).toBe(false);
    expect(relinked.prisma._cursor).toBe(T0);

    const otherSubscription = rig({ status: ACCOUNT.CANCELLED, chargebeeSubscriptionId: "sub_B" });
    expect(await otherSubscription.accounts.restartCursorAt(TENANT, new Date(T0 + 5 * MINUTE), "sub_A")).toBe(false);
  });
});

describe("openWindow: no window while switching, and none pinned where the account no longer bills", () => {
  const window = (over: Record<string, unknown> = {}) => ({
    tenantId: TENANT,
    chargebeeSubscriptionId: "sub_A",
    ledgerUnitId: "token",
    fromIngestedAt: new Date(T0),
    toIngestedAt: new Date(T0 + MINUTE),
    eventCount: 1,
    amount: "1",
    billedUsd: "0.001",
    status: SYNC.PENDING,
    error: null,
    settledAt: null,
    hatchetRunId: null,
    ...over,
  });

  it("opens a window pinned to the account's own subscription and unit", async () => {
    const { syncs, prisma } = rig();
    expect(await syncs.openWindow(window())).toMatchObject({ chargebeeSubscriptionId: "sub_A", status: SYNC.PENDING });
    expect(prisma._log).toHaveLength(1);
  });

  it("opens none while the account is switching", async () => {
    const { syncs, prisma } = rig({ status: ACCOUNT.SWITCHING });
    expect(await syncs.openWindow(window())).toBeNull();
    expect(prisma._log).toEqual([]);
  });

  it.each([
    ["the subscription", { chargebeeSubscriptionId: "sub_B" }],
    ["the unit", { ledgerUnitId: "token-test" }],
  ])("opens none from a stale read: the account has moved off %s the row would be pinned to", async (_what, moved) => {
    const { syncs, prisma } = rig(moved);
    expect(await syncs.openWindow(window())).toBeNull();
    expect(prisma._log).toEqual([]);
  });
});

describe("claim: nothing sent while switching, nothing sent where a row is no longer pinned", () => {
  it("claims a PENDING row as before: PROCESSING, one more attempt", async () => {
    const { syncs, prisma } = rig();
    const pending = await row(syncs, SYNC.PENDING);

    expect(await syncs.claim(pending)).toEqual({ id: pending.id, attemptCount: 1 });
    expect(prisma._syncs.get(pending.id)).toMatchObject({ status: SYNC.PROCESSING, attemptCount: 1 });
  });

  it("refuses while the account is switching, and leaves the row exactly as it was", async () => {
    const { syncs, prisma } = rig({ status: ACCOUNT.SWITCHING });
    const pending = await row(syncs, SYNC.PENDING);

    expect(await syncs.claim(pending)).toBeNull();
    expect(prisma._syncs.get(pending.id)).toMatchObject({ status: SYNC.PENDING, attemptCount: 0 });
  });

  it("refuses a row read before it was re-pinned — a stale copy cannot be sent to the old subscription", async () => {
    const { syncs, prisma } = rig();
    const asRead = await row(syncs, SYNC.OUT_OF_CREDITS);
    await syncs.repointHeld(prisma, { tenantId: TENANT, fromSubscriptionId: "sub_A", toSubscriptionId: "sub_B", ledgerUnitId: "token" });

    expect(await syncs.claim(asRead)).toBeNull();
    expect(prisma._syncs.get(asRead.id)).toMatchObject({ status: SYNC.OUT_OF_CREDITS, chargebeeSubscriptionId: "sub_B" });
  });

  it("holds the account row's lock for its whole transaction: a second claim of the row waits, then finds it taken", async () => {
    const { prisma, syncs } = rig();
    const pending = await row(syncs, SYNC.PENDING);
    const gate = new Gate();

    const first = createChargebeeSyncRepository(stallingAtClaimCas(prisma, gate) as never).claim(pending);
    await gate.reached;
    expect(prisma._rowLocked(TENANT)).toBe(true);

    let secondSettled = false;
    const second = syncs.claim(pending).finally(() => (secondSettled = true));
    await turns();
    expect(secondSettled).toBe(false); // waiting on the lock, as an UPDATE of a locked row does

    gate.open();
    expect(await first).toEqual({ id: pending.id, attemptCount: 1 });
    expect(await second).toBeNull();
    expect(prisma._rowLocked(TENANT)).toBe(false);
  });
});

describe("repointHeld: only rows Chargebee never applied move to the new subscription", () => {
  it("re-pins PENDING, OUT_OF_CREDITS and INVALID — not RATE_LIMITING, which may have landed — and no one else's", async () => {
    const { prisma, syncs } = rig();
    prisma._accounts.set(OTHER, { tenantId: OTHER, routingSlug: `${SLUG}_2`, chargebeeSubscriptionId: "sub_X", ledgerUnitId: "token", status: "active", lastProcessedIngestedAt: null });
    const statuses = [SYNC.PENDING, SYNC.RATE_LIMITING, SYNC.OUT_OF_CREDITS, SYNC.INVALID, SYNC.PROCESSING, SYNC.UNKNOWN, SYNC.SUCCESS, SYNC.WRITTEN_OFF];
    const rows = await Promise.all(statuses.map((status, i) => row(syncs, status, { fromMin: i })));
    const elsewhere = await row(syncs, SYNC.PENDING, { fromMin: 20, subscriptionId: "sub_Z" });
    const otherTenant = await row(syncs, SYNC.PENDING, { tenantId: OTHER });

    const moved = await syncs.repointHeld(prisma, { tenantId: TENANT, fromSubscriptionId: "sub_A", toSubscriptionId: "sub_B", ledgerUnitId: "token-test" });

    expect(moved).toBe(3);
    const pinOf = (id: string) => [prisma._syncs.get(id)!.chargebeeSubscriptionId, prisma._syncs.get(id)!.ledgerUnitId];
    expect(Object.fromEntries(rows.map((r) => [r.status, pinOf(r.id)]))).toEqual({
      PENDING: ["sub_B", "token-test"],
      // A throttled LOOKUP after a lost answer leaves a capture that landed as
      // RATE_LIMITING: it is settled on A, by lookup, never moved.
      RATE_LIMITING: ["sub_A", "token"],
      OUT_OF_CREDITS: ["sub_B", "token-test"],
      INVALID: ["sub_B", "token-test"],
      PROCESSING: ["sub_A", "token"],
      UNKNOWN: ["sub_A", "token"],
      SUCCESS: ["sub_A", "token"],
      WRITTEN_OFF: ["sub_A", "token"],
    });
    expect(pinOf(elsewhere.id)).toEqual(["sub_Z", "token"]);
    expect(pinOf(otherTenant.id)).toEqual(["sub_A", "token"]);
    // Re-pinned as they stand: same id, same window, same amount, same status.
    expect(prisma._syncs.get(rows[2]!.id)).toMatchObject({ id: rows[2]!.id, status: SYNC.OUT_OF_CREDITS, amount: "1" });
  });

  it("countInFlight counts the tenant's PROCESSING, UNKNOWN and RATE_LIMITING rows — what may have landed — only", async () => {
    const { prisma, syncs } = rig();
    prisma._accounts.set(OTHER, { tenantId: OTHER, routingSlug: `${SLUG}_2`, chargebeeSubscriptionId: "sub_X", ledgerUnitId: "token", status: "active", lastProcessedIngestedAt: null });
    const statuses = [SYNC.PENDING, SYNC.PROCESSING, SYNC.UNKNOWN, SYNC.RATE_LIMITING, SYNC.SUCCESS];
    await Promise.all(statuses.map((status, i) => row(syncs, status, { fromMin: i })));
    await row(syncs, SYNC.UNKNOWN, { tenantId: OTHER });

    expect(await syncs.countInFlight(prisma, TENANT)).toBe(3);
  });
});

describe("writeOff: decided against the account as it NOW stands, under its row lock", () => {
  it("writes off a refusal once the account is cancelled, or bills another subscription and is not switching", async () => {
    const cancelled = rig({ status: ACCOUNT.CANCELLED });
    const a = await row(cancelled.syncs, SYNC.OUT_OF_CREDITS);
    expect(await cancelled.syncs.writeOff(a, "ended")).toBe(true);
    expect(cancelled.prisma._syncs.get(a.id)!.status).toBe(SYNC.WRITTEN_OFF);

    const moved = rig({ chargebeeSubscriptionId: "sub_B" });
    const b = await row(moved.syncs, SYNC.INVALID);
    expect(await moved.syncs.writeOff(b, "moved")).toBe(true);
  });

  it("refuses while the row's subscription is still the account's: it has not ended", async () => {
    const { syncs, prisma } = rig();
    const refused = await row(syncs, SYNC.OUT_OF_CREDITS);

    expect(await syncs.writeOff(refused, "stale idea")).toBe(false);
    expect(prisma._syncs.get(refused.id)!.status).toBe(SYNC.OUT_OF_CREDITS);
  });

  it("refuses while a currency switch holds the account — the row is about to move with it, not to be lost", async () => {
    const { syncs, prisma } = rig({ status: ACCOUNT.SWITCHING, chargebeeSubscriptionId: "sub_B" });
    const refused = await row(syncs, SYNC.OUT_OF_CREDITS);

    expect(await syncs.writeOff(refused, "switching")).toBe(false);
    expect(prisma._syncs.get(refused.id)!.status).toBe(SYNC.OUT_OF_CREDITS);
  });

  it("refuses a stale copy: a row the switch re-pinned to B since it was read is billed on B, never written off", async () => {
    // A usage pass read the account on A and this refusal on A; meanwhile the
    // switch linked B and re-pinned the row. The pass then judges the row
    // against its stale copy ("pinned to A, the account left A").
    const { syncs, prisma } = rig({ status: ACCOUNT.SWITCHING });
    const asRead = await row(syncs, SYNC.OUT_OF_CREDITS);
    prisma._accounts.get(TENANT)!.chargebeeSubscriptionId = "sub_B";
    await syncs.repointHeld(prisma, { tenantId: TENANT, fromSubscriptionId: "sub_A", toSubscriptionId: "sub_B", ledgerUnitId: "token" });

    expect(await syncs.writeOff(asRead, "stale")).toBe(false);
    expect(prisma._syncs.get(asRead.id)).toMatchObject({ status: SYNC.OUT_OF_CREDITS, chargebeeSubscriptionId: "sub_B" });
  });

  it("a row pinned to nothing ends only with a cancellation, as pinnedToLinked says", async () => {
    const live = rig();
    const unpinned = await row(live.syncs, SYNC.INVALID, { subscriptionId: null as never });
    expect(await live.syncs.writeOff(unpinned, "x")).toBe(false);

    const cancelled = rig({ status: ACCOUNT.CANCELLED });
    const legacy = await row(cancelled.syncs, SYNC.INVALID, { subscriptionId: null as never });
    expect(await cancelled.syncs.writeOff(legacy, "x")).toBe(true);
  });
});

describe("the top-up charge lease: a charge and a switch's start never overlap", () => {
  const SWITCH_ROW = { tenantId: TENANT, fromSubscriptionId: "sub_A", fromCurrency: "INR", toCurrency: "USD", toItemPriceId: "free-usd" };
  const at = (m: number) => new Date(T0 + m * MINUTE);

  it("is taken on a live account, refused to a second charge while it runs, and taken again once it has run out", async () => {
    const { accounts, prisma } = rig();

    expect(await accounts.takeTopUpCharge(TENANT, at(0), 2 * MINUTE)).toEqual({ taken: true, until: at(2) });
    expect(prisma._accounts.get(TENANT)!.topupChargingUntil).toEqual(at(2));
    expect(await accounts.takeTopUpCharge(TENANT, at(1), 2 * MINUTE)).toEqual({ taken: false, reason: "charging" });
    expect(await accounts.takeTopUpCharge(TENANT, at(2), 2 * MINUTE)).toEqual({ taken: true, until: at(4) });
  });

  it("is released only by the charge that holds it", async () => {
    const { accounts, prisma } = rig();
    await accounts.takeTopUpCharge(TENANT, at(0), 2 * MINUTE);
    const current = await accounts.takeTopUpCharge(TENANT, at(3), 2 * MINUTE);

    expect(await accounts.releaseTopUpCharge(TENANT, at(2))).toBe(false); // the first, run out and replaced
    expect(await accounts.releaseTopUpCharge(TENANT, (current as { until: Date }).until)).toBe(true);
    expect(prisma._accounts.get(TENANT)!.topupChargingUntil).toBeNull();
  });

  it.each([
    ["REQUESTED", {}],
    ["MOVING", { movingAt: new Date(T0) }],
    ["LINKED", { movingAt: new Date(T0), linkedAt: new Date(T0), toSubscriptionId: "sub_B", toSubscriptionAt: new Date(T0) }],
  ])("is refused while a switch is %s and its cap has not moved — nothing is charged onto A", async (status, extra) => {
    const { accounts, prisma } = rig();
    await prisma.currencySwitch.create({ data: { ...SWITCH_ROW, status, ...extra } });

    expect(await accounts.takeTopUpCharge(TENANT, at(0), 2 * MINUTE)).toEqual({ taken: false, reason: "switch" });
    expect(prisma._accounts.get(TENANT)!.topupChargingUntil ?? null).toBeNull();
  });

  it("is not held up by a switch whose cap has moved (cancelling A is a background chore), nor by one that ended", async () => {
    const { accounts, prisma } = rig();
    await prisma.currencySwitch.create({
      data: { ...SWITCH_ROW, status: "LINKED", movingAt: new Date(T0), linkedAt: new Date(T0), toSubscriptionId: "sub_B", toSubscriptionAt: new Date(T0), activatedAt: new Date(T0) },
    });

    expect((await accounts.takeTopUpCharge(TENANT, at(0), 2 * MINUTE)).taken).toBe(true);
  });

  it.each([ACCOUNT.CANCELLED, ACCOUNT.SWITCHING, ACCOUNT.ACTIVATING])("is refused to a %s account", async (status) => {
    const { accounts } = rig({ status });
    expect(await accounts.takeTopUpCharge(TENANT, at(0), 2 * MINUTE)).toEqual({ taken: false, reason: "account" });
  });
});

describe("what the worker looks for", () => {
  const RULES = { defaultCurrency: "USD", byCountry: { IN: "INR" } };
  const FREE = ["free-usd", "free-inr"];
  const at = (m: number) => new Date(T0 + m * MINUTE);

  function org(prisma: ReturnType<typeof makeFakePrisma>, n: number, over: Record<string, unknown>) {
    const tenantId = `00000000-0000-4000-8000-00000000000${n}`;
    prisma._accounts.set(tenantId, {
      tenantId,
      routingSlug: `org_${n}`,
      chargebeeSubscriptionId: `sub_${n}`,
      chargebeeItemPriceId: "free-inr",
      ledgerUnitId: "token",
      status: ACCOUNT.ACTIVE,
      billingCountry: "US",
      currency: "INR",
      lastProcessedIngestedAt: null,
      ...over,
    });
    return tenantId;
  }

  it("lists live free-plan accounts billed in another currency than their country's — none moving, none just given up on", async () => {
    const { prisma, accounts } = rig({ billingCountry: "IN", currency: "INR", chargebeeItemPriceId: "free-inr" }); // TENANT: no mismatch
    const usInInr = org(prisma, 1, {});
    const inInUsd = org(prisma, 2, { billingCountry: "IN", currency: "USD", chargebeeItemPriceId: "free-usd" });
    org(prisma, 3, { billingCountry: "US", currency: "USD", chargebeeItemPriceId: "free-usd" }); // agrees
    org(prisma, 4, { chargebeeItemPriceId: "paid-inr-monthly" }); // paid: keeps its currency
    org(prisma, 5, { status: ACCOUNT.CANCELLED });
    org(prisma, 6, { currency: null }); // not read yet
    org(prisma, 7, { billingCountry: null }); // no address yet
    const moving = org(prisma, 8, {});
    await prisma.currencySwitch.create({ data: { tenantId: moving, fromSubscriptionId: "sub_8", fromCurrency: "INR", toCurrency: "USD", toItemPriceId: "free-usd", status: "REQUESTED" } });
    const justFailed = org(prisma, 9, { status: ACCOUNT.EXHAUSTED });
    prisma._now = T0 + 10 * MINUTE;
    await prisma.currencySwitch.create({ data: { tenantId: justFailed, fromSubscriptionId: "sub_9", fromCurrency: "INR", toCurrency: "USD", toItemPriceId: "free-usd", status: "ABANDONED", updatedAt: at(10) } });

    const listed = await accounts.listCurrencyMismatches({ rules: RULES, freeItemPriceIds: FREE, abandonedSince: at(-20), limit: 20 });
    expect(listed.map((a) => a.tenantId)).toEqual([usInInr, inInUsd]); // oldest tenant id first

    // Thirty minutes after it gave up, the worker tries that one again.
    const later = await accounts.listCurrencyMismatches({ rules: RULES, freeItemPriceIds: FREE, abandonedSince: at(20), limit: 20 });
    expect(later.map((a) => a.tenantId)).toContain(justFailed);
    expect((await accounts.listCurrencyMismatches({ rules: RULES, freeItemPriceIds: FREE, abandonedSince: at(20), limit: 1 })).length).toBe(1);
  });

  it("lists every account left `switching`, for the worker to find one no switch is moving", async () => {
    const { prisma, accounts } = rig({ status: ACCOUNT.SWITCHING });
    org(prisma, 1, {});

    expect(await accounts.listSwitchingTenantIds()).toEqual([TENANT]);
  });
});

describe("topup_grant: what a switch reads of its carries", () => {
  function grant(prisma: ReturnType<typeof makeFakePrisma>, invoiceId: string, status: string) {
    const id = `tg_${prisma._topUps.size}`;
    prisma._topUps.set(id, {
      id,
      tenantId: TENANT,
      invoiceId,
      chargebeeSubscriptionId: "sub_B",
      ledgerUnitId: "token",
      credits: "100",
      expiresAt: new Date(T0),
      idempotencyKey: `k_${id}`,
      keyIssuedAt: new Date(T0),
      status,
      source: "allocation",
      chargebeeRef: status === "APPLIED" ? "ledger_operation:x" : null,
      attemptCount: 1,
      error: null,
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
      appliedAt: status === "APPLIED" ? new Date(T0) : null,
    });
  }

  it("lists a switch's carry rows by their prefix, and counts the tenant's unsettled grants", async () => {
    const { prisma } = rig();
    const { createTopUpGrantRepository } = await import("@/repositories/topup-grant.repository");
    const topUps = createTopUpGrantRepository(prisma);
    grant(prisma, "carry:sw1:gb_1", "APPLIED");
    grant(prisma, "carry:sw1:gb_2", "PENDING");
    grant(prisma, "carry:sw2:gb_3", "SENDING");
    grant(prisma, "inv_9", "APPLIED");

    expect((await topUps.withInvoicePrefix(TENANT, "carry:sw1:")).map((g) => g.invoiceId).sort()).toEqual(["carry:sw1:gb_1", "carry:sw1:gb_2"]);
    expect(await topUps.countUnresolved(TENANT)).toBe(2);
  });
});
