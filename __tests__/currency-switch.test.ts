/**
 * The currency switch, end to end over the real services and repositories
 * (currency-switch.service.ts): a small per-subscription Chargebee fake —
 * every subscription its own currency, its own grant blocks and its own
 * consumption per unit, the USD free plan granting 1 credit on creation as
 * the test site does — and the lifecycle helpers' LiteLLM team.
 *
 *   (a) INR → USD, the worked example: the page's figures continue on B, A is
 *       emptied and cancelled, the LiteLLM cap does not move.
 *   (b) USD → INR.
 *   (c) A re-run mid-MOVING (an answer lost, a crashed advancer's lease)
 *       resumes without a second allocate or capture.
 *   (d) A capture on the wire (PROCESSING) defers START.
 *
 * Then how a switch ends without finishing — a refused carry aborts it, a
 * REQUESTED one times out or loses its country — the worker's orphan recovery
 * and convergence, and the drain's edge cases: a voided top-up held back, an
 * old subscription with no ledger account, a balance that cannot be read.
 */

import { describe, expect, it } from "vitest";

import type { CaptureArgs, CaptureResult, GrantBlock } from "@/integrations/chargebee";
import { ACCOUNT } from "@/models/account-status";
import { currencyCatalog } from "@/models/currency";
import { SYNC } from "@/models/sync-status";
import { createBillingAccountRepository } from "@/repositories/billing-account.repository";
import { createChargebeeSyncRepository } from "@/repositories/chargebee-sync.repository";
import { SWITCH, createCurrencySwitchRepository } from "@/repositories/currency-switch.repository";
import { createTopUpGrantRepository } from "@/repositories/topup-grant.repository";
import { createAccountService } from "@/services/account.service";
import {
  CONVERGE_BACKOFF_MS,
  SWITCH_REQUEST_TTL_MS,
  createCurrencySwitchService,
  targetSubscriptionId,
} from "@/services/currency-switch.service";
import { BASELINE_TERM, BILLING_MANAGED, SPEND_BASELINE, budgetHooksFor, createGatewayBudget } from "@/services/gateway-budget.service";

import { FakeGateway, INR_FREE, TEAM, UNIT, USD_FREE, round6 } from "./failure-matrix-lifecycle-webhooks-litellm.helpers";
import { MINUTE, RATE, T0, TENANT, makeFakePrisma } from "./harness";

const A_TERM = new Date(T0 - 10 * 86_400_000);
const PLAN: Record<string, { currency: string; grant: number }> = {
  [USD_FREE]: { currency: "USD", grant: 1 },
  [INR_FREE]: { currency: "INR", grant: 0 },
};

interface Block {
  id: string;
  sub: string;
  unit: string;
  granted: number;
  createdMs: number;
  expiresAt: number | null;
  itemPriceId: string | null;
  invoiceId: string | null;
}

/** Chargebee, per subscription: its currency, its grant blocks, its consumption per unit. */
class Chargebee {
  subs = new Map<string, Record<string, any>>();
  blocks: Block[] = [];
  consumed = new Map<string, number>();
  ops = new Map<string, { sub: string; unit: string; amount: number }>();
  allocations: Array<{ sub: string; amount: string; key: string }> = [];
  idempotency = new Map<string, { operationId: string; balanceAfter: string; createdAtMs: number }>();
  subscribeCalls = 0;
  preferred: string | null = null;
  /** The next allocate lands, and its answer is lost. */
  loseAllocate = 0;
  /** The next capture lands, and its answer is lost. */
  loseCapture = 0;
  /** The next allocate is refused outright (a 400: nothing granted). */
  refuseAllocate = 0;
  /** Subscriptions whose balance reads as null although their wallet exists. */
  unreadable = new Set<string>();
  /** What `unsettledTopUpInvoices` lists: payment_due, not_paid, voided or pending. */
  unsettled: Array<{ id: string; status: string }> = [];
  private seq = 0;

  constructor(private readonly now: () => number) {}

  subscribe(id: string, plan: string, created = this.now()) {
    const s = Math.floor(created / 1000);
    this.subs.set(id, {
      id,
      customer_id: TENANT,
      status: "active",
      currency_code: PLAN[plan]!.currency,
      created_at: s,
      current_term_start: s,
      current_term_end: s + 365 * 86_400,
      subscription_items: [{ item_price_id: plan, item_type: "plan", amount: 0 }],
      mrr: 0,
    });
    if (PLAN[plan]!.grant > 0) this.block(id, PLAN[plan]!.grant, { itemPriceId: plan, createdMs: created });
  }

  block(
    sub: string,
    granted: number,
    opts: { itemPriceId?: string | null; invoiceId?: string | null; createdMs?: number; expiresAt?: number | null } = {},
  ) {
    const b: Block = {
      id: `gb_${++this.seq}`,
      sub,
      unit: UNIT,
      granted,
      createdMs: opts.createdMs ?? this.now(),
      expiresAt: opts.expiresAt ?? null,
      itemPriceId: opts.itemPriceId ?? null,
      invoiceId: opts.invoiceId ?? null,
    };
    this.blocks.push(b);
    return b;
  }

  consume(sub: string, amount: number) {
    this.consumed.set(`${sub}|${UNIT}`, (this.consumed.get(`${sub}|${UNIT}`) ?? 0) + amount);
  }

  live(sub: string): Block[] {
    return this.blocks.filter((b) => b.sub === sub && (b.expiresAt == null || b.expiresAt * 1000 > this.now()));
  }

  granted(sub: string): number {
    return round6(this.live(sub).reduce((s, b) => s + b.granted, 0));
  }

  used(sub: string): number {
    return this.consumed.get(`${sub}|${UNIT}`) ?? 0;
  }

  usable(sub: string): number {
    return round6(this.granted(sub) - this.used(sub));
  }

  private capture(args: CaptureArgs): CaptureResult {
    if (this.ops.has(args.id)) return { kind: "replayed", operationId: args.id };
    const amount = Number(args.amount);
    if (amount > this.usable(args.subscriptionId) + 1e-9) return { kind: "insufficient" };
    this.ops.set(args.id, { sub: args.subscriptionId, unit: args.unitId, amount });
    this.consume(args.subscriptionId, amount);
    if (this.loseCapture > 0) {
      this.loseCapture -= 1;
      return { kind: "retryable" };
    }
    return { kind: "captured", operationId: args.id, balanceAfter: String(this.usable(args.subscriptionId)) };
  }

  readonly client = {
    itemPrice: async (id: string) =>
      PLAN[id] ? { id, name: id, priceMinor: 0, currencyCode: PLAN[id]!.currency, period: 1, periodUnit: "year" } : null,
    subscribeCustomer: async ({ itemPriceId, subscriptionId }: { customerId: string; itemPriceId: string; subscriptionId?: string }) => {
      this.subscribeCalls += 1;
      const id = subscriptionId ?? `sub_${++this.seq}`;
      if (!this.subs.has(id)) this.subscribe(id, itemPriceId);
      return structuredClone(this.subs.get(id)!);
    },
    subscription: async (id: string) => (this.subs.has(id) ? structuredClone(this.subs.get(id)!) : null),
    cancelSubscription: async (id: string) => {
      this.subs.get(id)!.status = "cancelled";
      return structuredClone(this.subs.get(id)!);
    },
    grantBlocks: async (sub: string) => ({
      complete: true,
      blocks: this.blocks
        .filter((b) => b.sub === sub)
        .sort((a, b) => a.createdMs - b.createdMs)
        .map(
          (b): GrantBlock => ({
            id: b.id,
            subscriptionId: b.sub,
            unitId: b.unit,
            grantedAmount: String(b.granted),
            status: "available",
            source: b.itemPriceId ? "subscription_created" : "promotional_grants",
            createdAtMs: b.createdMs,
            expiresAtMs: b.expiresAt == null ? null : b.expiresAt * 1000,
            invoices: b.invoiceId ? [{ invoiceId: b.invoiceId, lineItemId: `li_${b.invoiceId}` }] : [],
            itemPriceId: b.itemPriceId,
            doneBy: b.itemPriceId ? null : "full_access_key_v1",
          }),
        ),
    }),
    /** No wallet until something is granted into it (MEASURED). */
    balance: async (sub: string, unit?: string | null) => {
      if (!this.blocks.some((b) => b.sub === sub) || (unit && unit !== UNIT) || this.unreadable.has(sub)) return null;
      return { unitId: UNIT, unitName: UNIT, usable: String(this.usable(sub)), onHold: "0", unitCount: 1 };
    },
    /** The units the subscription holds a ledger account in: none until something is granted. */
    ledgerUnits: async (sub: string) => (this.blocks.some((b) => b.sub === sub) ? [UNIT] : []),
    grantedCredits: async (sub: string) => ({ credits: String(this.granted(sub)), blocks: this.live(sub).length }),
    allocate: async (args: { subscriptionId: string; unitId: string; amount: string; expiresAt: number; idempotencyKey: string }) => {
      if (this.refuseAllocate > 0) {
        this.refuseAllocate -= 1;
        throw Object.assign(new Error("allocate: invalid_request"), { status: 400, apiErrorCode: "invalid_request", retryable: false });
      }
      const seen = this.idempotency.get(args.idempotencyKey);
      if (seen) return { ...seen };
      this.allocations.push({ sub: args.subscriptionId, amount: args.amount, key: args.idempotencyKey });
      this.block(args.subscriptionId, Number(args.amount), { expiresAt: args.expiresAt });
      const result = { operationId: `alloc_${this.allocations.length}`, balanceAfter: String(this.usable(args.subscriptionId)), createdAtMs: this.now() };
      this.idempotency.set(args.idempotencyKey, result);
      if (this.loseAllocate > 0) {
        this.loseAllocate -= 1;
        throw Object.assign(new Error("allocate: timeout"), { retryable: true });
      }
      return result;
    },
    capture: async (args: CaptureArgs) => this.capture(args),
    captureIdempotent: async (args: CaptureArgs) => this.capture(args),
    findOperation: async (id: string) => (this.ops.has(id) ? { id } : null),
    ledgerOperation: async () => null,
    customer: async (id: string) => ({ id, billingAddress: null, preferredCurrencyCode: this.preferred }),
    setPreferredCurrency: async (id: string, currency: string) => {
      this.preferred = currency;
      return { id, billingAddress: null, preferredCurrencyCode: currency };
    },
    unsettledTopUpInvoices: async () => this.unsettled.map((i) => ({ ...i })),
    unpaidTopUpCredits: async () => "0",
    subscriptionIdsOf: async () => [...this.subs.keys()],
    activeSubscriptions: async () => [...this.subs.values()].filter((s) => s.status === "active"),
    paidInvoicesFor: async () => [],
  };
}

const PACK: Record<string, string> = { INR: "api_token-INR", USD: "api_token-USD" };
const topUpFor = (currency: string) => ({ itemPriceId: PACK[currency]!, presetAmounts: [10], minAmount: null, maxAmount: null, credits: "1000" });

/**
 * An org on `from`'s free plan (sub_A) whose confirmed country now wants
 * the other currency: A granted 1,000 in two blocks, `used` consumed. Its
 * LiteLLM team billing-managed with baseline $0, cap = what A grants.
 *
 *   wallet false   A grants nothing (the INR plan, no free credits): no block,
 *                  no ledger account — still linked to the unit, on 0 credits.
 *   topUps         each currency sells a pack (PACK).
 *   prepare        more of A's Chargebee state, before the cap is read.
 *   switchEnabled  BILLING_CURRENCY_SWITCH_ENABLED (convergence).
 */
function rig({
  from,
  used,
  wallet = true,
  topUps = false,
  prepare,
  switchEnabled = false,
}: {
  from: "INR" | "USD";
  used: number;
  wallet?: boolean;
  topUps?: boolean;
  prepare?: (cb: Chargebee) => void;
  switchEnabled?: boolean;
}) {
  let now = T0;
  const cb = new Chargebee(() => now);
  const plan = from === "INR" ? INR_FREE : USD_FREE;
  cb.subscribe("sub_A", plan, T0 - 10 * 86_400_000);
  if (wallet) {
    // Top up to 1,000 granted whatever the plan granted itself.
    const own = PLAN[plan]!.grant;
    cb.block("sub_A", 700 - own, { createdMs: T0 - 9 * 86_400_000 });
    cb.block("sub_A", 300, { createdMs: T0 - 8 * 86_400_000, expiresAt: Math.floor(T0 / 1000) + 400 * 86_400 });
  }
  cb.consume("sub_A", used);
  prepare?.(cb);

  const prisma = makeFakePrisma(
    {
      chargebeeCustomerId: TENANT,
      chargebeeSubscriptionId: "sub_A",
      chargebeeItemPriceId: plan,
      ledgerUnitId: UNIT,
      status: ACCOUNT.ACTIVE,
      currency: from,
      billingCountry: from === "INR" ? "US" : "IN",
      currentTermStart: A_TERM,
    } as never,
    T0,
  );
  const gateway = new FakeGateway();
  gateway.team_ = {
    spend: round6(used * Number(RATE)),
    maxBudget: round6(cb.granted("sub_A") * Number(RATE)),
    budgetDuration: null,
    blocked: false,
    metadata: { [BILLING_MANAGED]: true, [SPEND_BASELINE]: 0, [BASELINE_TERM]: A_TERM.toISOString() },
  };
  const accounts = createBillingAccountRepository(prisma as never);
  const hooks = budgetHooksFor(
    createGatewayBudget({
      gateway,
      usdPerCredit: RATE,
      teamIdFor: async () => TEAM,
      grantedCreditsFor: async (tenantId) => {
        const a = await accounts.findByTenantId(tenantId);
        return a?.chargebeeSubscriptionId ? String(cb.granted(a.chargebeeSubscriptionId)) : "0";
      },
    }),
  );
  const errors: Array<Record<string, unknown>> = [];
  const logger = { log() {}, warn() {}, error: (o: unknown) => void errors.push(o as Record<string, unknown>) };
  const accountService = createAccountService({
    prisma: prisma as never,
    chargebee: cb.client as never,
    usdPerCredit: RATE,
    clock: () => now,
    logger,
    ...hooks,
  });
  const switches = createCurrencySwitchRepository(prisma as never);
  const catalog = currencyCatalog(
    { defaultCurrency: "USD", byCountry: { IN: "INR" } },
    {
      USD: { freeItemPriceId: USD_FREE, topUp: topUps ? topUpFor("USD") : null },
      INR: { freeItemPriceId: INR_FREE, topUp: topUps ? topUpFor("INR") : null },
    },
  );
  const service = createCurrencySwitchService({
    chargebee: cb.client as never,
    accountService,
    accounts,
    switches,
    topUps: createTopUpGrantRepository(prisma as never),
    catalog,
    currencySwitchEnabled: switchEnabled,
    clock: () => now,
    logger,
  });

  const r = {
    cb,
    prisma,
    gateway,
    switches,
    service,
    errors,
    syncs: createChargebeeSyncRepository(prisma as never),
    account: () => prisma._accounts.get(TENANT)!,
    to: from === "INR" ? "USD" : "INR",
    /** Move the clock forward by `ms`. */
    wait(ms: number) {
      now += ms;
      prisma._now = now;
      return r;
    },
    advance: () => service.advance(TENANT, { deadline: now + MINUTE, minStepMs: 1_500 }),
    /** Advance, letting B's grant settle, until no switch is open (bounded). */
    async run() {
      for (let i = 0; i < 6; i += 1) {
        const p = await r.advance();
        if (!p.open) return;
        r.wait(11_000);
      }
      throw new Error("the switch did not finish");
    },
    latest: () => switches.latestFor(TENANT),
    metrics: () => errors.map((e) => e.metric),
    /** One worker pass, with a minute to spend. */
    advanceOpen: () => service.advanceOpen({ deadline: now + MINUTE, minStepMs: 1_500 }),
  };
  return r;
}

describe("the currency switch", () => {
  it("(a) INR → USD, the worked example: B continues A's figures, A is emptied and cancelled, the cap does not move", async () => {
    const r = rig({ from: "INR", used: 600 });
    const capBefore = r.gateway.team_.maxBudget;
    expect(r.cb.usable("sub_A")).toBe(400);

    expect((await r.service.request(TENANT, "USD"))?.status).toBe(SWITCH.REQUESTED);
    await r.run();

    const sw = (await r.latest())!;
    const B = targetSubscriptionId(sw.id);
    expect(sw).toMatchObject({ status: SWITCH.DONE, toSubscriptionId: B, ownGrant: "1", drained: "400", mirrorAmount: "601" });
    // B continues the page's figures, granted and consumed both + its own 1-credit grant.
    expect(r.cb.subs.get(B)!.currency_code).toBe("USD");
    expect(r.cb.granted(B)).toBe(1001);
    expect(r.cb.used(B)).toBe(601);
    expect(r.cb.usable(B)).toBe(400);
    // A emptied and cancelled.
    expect(r.cb.usable("sub_A")).toBe(0);
    expect(r.cb.subs.get("sub_A")!.status).toBe("cancelled");
    // Billing on B, the cap where it was.
    expect(r.account()).toMatchObject({ status: ACCOUNT.ACTIVE, chargebeeSubscriptionId: B, currency: "USD", ledgerUnitId: UNIT, chargebeeItemPriceId: USD_FREE });
    expect(r.gateway.team_.maxBudget).toBe(capBefore);
    expect(r.gateway.team_.blocked).toBe(false);
    expect(r.cb.preferred).toBe("USD");
    expect(r.cb.allocations).toHaveLength(2);
  });

  it("(b) USD → INR: the USD plan's own block is carried like any other; B grants nothing itself", async () => {
    const r = rig({ from: "USD", used: 300 });
    const capBefore = r.gateway.team_.maxBudget;

    await r.service.request(TENANT, "INR");
    await r.run();

    const sw = (await r.latest())!;
    const B = targetSubscriptionId(sw.id);
    expect(sw).toMatchObject({ status: SWITCH.DONE, ownGrant: "0", drained: "700", mirrorAmount: "300" });
    expect([r.cb.granted(B), r.cb.used(B), r.cb.usable(B)]).toEqual([1000, 300, 700]);
    expect(r.cb.usable("sub_A")).toBe(0);
    expect(r.cb.subs.get("sub_A")!.status).toBe("cancelled");
    expect(r.account()).toMatchObject({ status: ACCOUNT.ACTIVE, chargebeeSubscriptionId: B, currency: "INR" });
    expect(r.gateway.team_.maxBudget).toBe(capBefore);
  });

  it("(c) a re-run mid-MOVING resumes: no second allocate, no second capture", async () => {
    const r = rig({ from: "INR", used: 600 });
    await r.service.request(TENANT, "USD");
    r.cb.loseAllocate = 1;

    // The first carry lands and its answer is lost: the switch waits, MOVING.
    await r.advance();
    expect((await r.latest())!.status).toBe(SWITCH.MOVING);
    expect(r.account().status).toBe(ACCOUNT.SWITCHING);

    // Next: the drain lands and its answer is lost.
    r.cb.loseCapture = 1;
    r.wait(MINUTE);
    await r.advance();
    expect((await r.latest())!.drainOperationId).not.toBeNull();

    // An advancer that crashed holding the lease: nothing moves until it runs out.
    const sw = (await r.latest())!;
    expect(await r.switches.takeLease(sw.id, new Date(T0 + MINUTE))).not.toBeNull();
    const ops = r.cb.ops.size;
    await r.advance();
    expect(r.cb.ops.size).toBe(ops);

    r.wait(6 * MINUTE);
    await r.run();

    const done = (await r.latest())!;
    expect(done).toMatchObject({ status: SWITCH.DONE, drained: "400", mirrorAmount: "601" });
    expect(r.cb.allocations).toHaveLength(2); // one per block of A, the lost one re-sent under its key
    expect(r.cb.used("sub_A")).toBe(1000); // 600 used + one drain of 400
    expect([...r.cb.ops.values()].filter((o) => o.sub === "sub_A")).toHaveLength(1);
    expect(r.cb.usable(targetSubscriptionId(done.id))).toBe(400);
  });

  it("(d) a capture on the wire (PROCESSING) defers START until it settles", async () => {
    const r = rig({ from: "INR", used: 600 });
    const row = await r.syncs.create({
      tenantId: TENANT,
      chargebeeSubscriptionId: "sub_A",
      ledgerUnitId: UNIT,
      fromIngestedAt: new Date(T0 - 2 * MINUTE),
      toIngestedAt: new Date(T0 - MINUTE),
      eventCount: 1,
      amount: "2",
      billedUsd: "0.002",
      status: SYNC.PROCESSING,
      error: null,
      settledAt: null,
      hatchetRunId: null,
    });
    await r.service.request(TENANT, "USD");

    await r.advance();
    expect((await r.latest())!).toMatchObject({ status: SWITCH.REQUESTED, error: "a usage capture is in flight" });
    expect(r.account().status).toBe(ACCOUNT.ACTIVE);
    expect(r.cb.allocations).toHaveLength(0);

    const stored = r.prisma._syncs.get(row.id)!;
    r.prisma._syncs.set(row.id, { ...stored, status: SYNC.SUCCESS, settledAt: new Date(T0) });
    await r.run();
    expect((await r.latest())!.status).toBe(SWITCH.DONE);
  });
});

/** A usage capture on the wire (PROCESSING) on A: START waits while it is. */
function captureInFlight(r: ReturnType<typeof rig>) {
  return r.syncs.create({
    tenantId: TENANT,
    chargebeeSubscriptionId: "sub_A",
    ledgerUnitId: UNIT,
    fromIngestedAt: new Date(T0 - 2 * MINUTE),
    toIngestedAt: new Date(T0 - MINUTE),
    eventCount: 1,
    amount: "2",
    billedUsd: "0.002",
    status: SYNC.PROCESSING,
    error: null,
    settledAt: null,
    hatchetRunId: null,
  });
}

/** Request INR → USD and advance once with a capture in flight: B is made, the switch stays REQUESTED. */
async function requestedWithTarget(r: ReturnType<typeof rig>) {
  await captureInFlight(r);
  await r.service.request(TENANT, "USD");
  await r.advance();
  const sw = (await r.latest())!;
  expect(sw).toMatchObject({ status: SWITCH.REQUESTED, toSubscriptionId: targetSubscriptionId(sw.id) });
  expect(r.cb.subs.get(sw.toSubscriptionId!)!.status).toBe("active");
  return sw.toSubscriptionId!;
}

describe("a switch that does not finish", () => {
  it("a carry Chargebee refuses before any credit moved aborts it: the org back on A, B cancelled, nothing drained", async () => {
    const r = rig({ from: "INR", used: 600 });
    r.cb.refuseAllocate = 1;

    await r.service.request(TENANT, "USD");
    await r.advance();

    const sw = (await r.latest())!;
    expect(sw).toMatchObject({ status: SWITCH.ABANDONED, error: "chargebee_refused", drained: "0", drainOperationId: null });
    expect(r.metrics()).toContain("billing.currency_switch.aborted");
    expect(r.account()).toMatchObject({ status: ACCOUNT.ACTIVE, chargebeeSubscriptionId: "sub_A", currency: "INR" });
    expect(r.cb.subs.get(sw.toSubscriptionId!)!.status).toBe("cancelled");
    expect(r.cb.subs.get("sub_A")!.status).toBe("active");
    expect(r.cb.allocations).toHaveLength(0);
    expect([r.cb.used("sub_A"), r.cb.usable("sub_A")]).toEqual([600, 400]);
    expect(r.gateway.team_.blocked).toBe(false);
  });

  it(`a REQUESTED switch that has not started after ${SWITCH_REQUEST_TTL_MS / MINUTE} minutes is abandoned (timed_out), and B cancelled`, async () => {
    const r = rig({ from: "INR", used: 600 });
    const B = await requestedWithTarget(r);

    r.wait(SWITCH_REQUEST_TTL_MS + MINUTE);
    await r.advance();

    expect((await r.latest())!).toMatchObject({ status: SWITCH.ABANDONED, error: "timed_out" });
    expect(r.cb.subs.get(B)!.status).toBe("cancelled");
    expect(r.account()).toMatchObject({ status: ACCOUNT.ACTIVE, chargebeeSubscriptionId: "sub_A" });
    expect(r.cb.allocations).toHaveLength(0);
  });

  it("a REQUESTED switch whose billing country changed back is abandoned (country_changed), and B cancelled", async () => {
    const r = rig({ from: "INR", used: 600 });
    const B = await requestedWithTarget(r);

    r.prisma._accounts.set(TENANT, { ...r.account(), billingCountry: "IN" });
    await r.advance();

    expect((await r.latest())!).toMatchObject({ status: SWITCH.ABANDONED, error: "country_changed" });
    expect(r.cb.subs.get(B)!.status).toBe("cancelled");
    expect(r.account()).toMatchObject({ status: ACCOUNT.ACTIVE, chargebeeSubscriptionId: "sub_A", currency: "INR" });
  });
});

describe("the worker (advanceOpen)", () => {
  it("an account left switching with no switch moving it is put back on its subscription", async () => {
    const r = rig({ from: "INR", used: 600 });
    r.prisma._accounts.set(TENANT, { ...r.account(), status: ACCOUNT.SWITCHING });

    const summary = await r.advanceOpen();

    expect(summary.recovered).toBe(1);
    expect(r.account()).toMatchObject({ status: ACCOUNT.ACTIVE, chargebeeSubscriptionId: "sub_A" });
  });

  it("an account a MOVING switch holds is left switching", async () => {
    const r = rig({ from: "INR", used: 600 });
    await r.service.request(TENANT, "USD");
    r.cb.loseAllocate = 1;
    await r.advance();
    expect((await r.latest())!.status).toBe(SWITCH.MOVING);

    // No time to advance it: only the recovery runs.
    const summary = await r.service.advanceOpen({ deadline: T0, minStepMs: 1_500 });

    expect(summary).toMatchObject({ recovered: 0, open: 1, advanced: 0 });
    expect(r.account().status).toBe(ACCOUNT.SWITCHING);
  });

  it("requests a switch for a free org whose currency is not its country's — only when switching is enabled", async () => {
    const off = rig({ from: "INR", used: 600 });
    expect((await off.advanceOpen()).requested).toBe(0);
    expect(await off.latest()).toBeNull();

    const on = rig({ from: "INR", used: 600, switchEnabled: true });
    expect((await on.advanceOpen()).requested).toBe(1);
    expect((await on.latest())!).toMatchObject({ status: SWITCH.REQUESTED, fromCurrency: "INR", toCurrency: "USD" });
  });

  it(`does not request again within ${CONVERGE_BACKOFF_MS / MINUTE} minutes of an abandoned switch`, async () => {
    const r = rig({ from: "INR", used: 600, switchEnabled: true });
    const sw = (await r.service.request(TENANT, "USD"))!;
    expect(await r.switches.abandonIfRequested(sw.id, "test", new Date(T0))).toBe(true);

    r.wait(CONVERGE_BACKOFF_MS - MINUTE);
    expect((await r.advanceOpen()).requested).toBe(0);

    r.wait(2 * MINUTE);
    expect((await r.advanceOpen()).requested).toBe(1);
    expect((await r.latest())!.id).not.toBe(sw.id);
  });
});

describe("the drain's edge cases", () => {
  it("a voided top-up on A is held back: not carried, drained with the rest, and B shows what A displayed", async () => {
    // A: 1,000 granted + a 200 pack whose invoice was voided; 600 used, so 600 usable — 400 of it the org's.
    const r = rig({
      from: "INR",
      used: 600,
      topUps: true,
      prepare: (cb) => {
        cb.block("sub_A", 200, { itemPriceId: PACK.INR!, invoiceId: "inv_void", createdMs: T0 - 7 * 86_400_000 });
        cb.unsettled = [{ id: "inv_void", status: "voided" }];
      },
    });
    expect(r.cb.usable("sub_A")).toBe(600);

    await r.service.request(TENANT, "USD");
    await r.run();

    const sw = (await r.latest())!;
    const B = targetSubscriptionId(sw.id);
    expect(sw).toMatchObject({ status: SWITCH.DONE, heldBack: "200", drained: "600", ownGrant: "1", mirrorAmount: "601" });
    expect(r.cb.allocations).toHaveLength(2); // the two plan/free blocks; never the voided pack
    expect([r.cb.granted(B), r.cb.used(B), r.cb.usable(B)]).toEqual([1001, 601, 400]);
    expect(r.cb.usable("sub_A")).toBe(0);
    expect(r.account()).toMatchObject({ chargebeeSubscriptionId: B, currency: "USD" });
  });

  it("an A with no ledger account in its unit (granted nothing, ever) has nothing to drain: the switch completes", async () => {
    const r = rig({ from: "INR", used: 0, wallet: false });
    expect(r.cb.blocks.filter((b) => b.sub === "sub_A")).toHaveLength(0);

    await r.service.request(TENANT, "USD");
    await r.run();

    const sw = (await r.latest())!;
    const B = targetSubscriptionId(sw.id);
    expect(sw).toMatchObject({ status: SWITCH.DONE, drained: "0", drainOperationId: null, ownGrant: "1", mirrorAmount: "1" });
    expect(r.cb.allocations).toHaveLength(0);
    expect([r.cb.granted(B), r.cb.usable(B)]).toEqual([1, 0]);
    expect(r.cb.subs.get("sub_A")!.status).toBe("cancelled");
    expect(r.account()).toMatchObject({ chargebeeSubscriptionId: B, currency: "USD", ledgerUnitId: UNIT });
  });

  it("an A whose ledger account exists but whose balance cannot be read waits — never guesses — then completes once it can", async () => {
    const r = rig({ from: "INR", used: 600 });
    r.cb.unreadable.add("sub_A");

    await r.service.request(TENANT, "USD");
    await r.advance();

    expect((await r.latest())!).toMatchObject({ status: SWITCH.MOVING, drainOperationId: null, error: "the old subscription's balance is unreadable" });
    expect(r.cb.used("sub_A")).toBe(600); // nothing drained
    expect(r.account().status).toBe(ACCOUNT.SWITCHING);

    r.cb.unreadable.delete("sub_A");
    r.wait(MINUTE);
    await r.run();

    expect((await r.latest())!).toMatchObject({ status: SWITCH.DONE, drained: "400", mirrorAmount: "601" });
    expect(r.cb.allocations).toHaveLength(2);
    expect(r.cb.usable("sub_A")).toBe(0);
  });
});
