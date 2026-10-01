/**
 * The billing page, in one currency at a time.
 *
 *   ONE TOP-UP OFFER, OR NONE (R1, R5, R6). The subscription's currency's
 *   pack — never the address's, never two — and only once the org has
 *   confirmed a billing country, with no currency switch open, on a live
 *   subscription.
 *
 *   THE PLANS of the confirmed country's currency, the org's current plan
 *   always among them; none before an address. A currency with no paid plan
 *   at all says so (`plansMissingForCurrency`, A24).
 *
 *   THE SWITCH, as the page needs it: pending, moving, finishing until the
 *   cap has moved, and `failed` for a day after one was given up — never one
 *   the org made moot itself (A1, A17). Read from the database only: the page
 *   never advances it, and while the account is `switching` it asks Chargebee
 *   nothing (A22).
 *
 *   EVERY KEY, EVERY KIND: unlinked, activating, switching and linked render
 *   the same keys, so the page never mistakes a state for an older billing.
 */

import { describe, expect, it, vi } from "vitest";

import type { ChargebeeClient } from "@/integrations/chargebee";
import { ACCOUNT } from "@/models/account-status";
import { currencyCatalog, type CurrencyRules } from "@/models/currency";
import { createBillingAccountRepository } from "@/repositories/billing-account.repository";
import { createChargebeeSyncRepository } from "@/repositories/chargebee-sync.repository";
import { createCurrencySwitchRepository, SWITCH } from "@/repositories/currency-switch.repository";
import { createBillingOverviewService, FAILED_SWITCH_SHOWN_MS } from "@/services/billing-overview.service";
import type { PlanOffer, TopUpOffer } from "@/services/plan-catalog.service";
import { renderBillingOverview } from "@/views/billing.view";

import { MINUTE, T0, TENANT, makeFakePrisma, quietLogger } from "./harness";

const RULES: CurrencyRules = { defaultCurrency: "USD", byCountry: { IN: "INR" } };
const topUp = (itemPriceId: string) => ({ itemPriceId, presetAmounts: [5, 10], minAmount: null, maxAmount: null, credits: "" });
const CATALOG = currencyCatalog(RULES, {
  USD: { freeItemPriceId: "free-usd", topUp: topUp("api_token-USD") },
  INR: { freeItemPriceId: "free-inr", topUp: topUp("api_token-INR") },
});

const plan = (itemPriceId: string, currencyCode: string | null, resolved = true): PlanOffer => ({
  itemPriceId,
  name: itemPriceId,
  priceMinor: itemPriceId.startsWith("free") ? 0 : 100_000,
  currencyCode,
  period: 1,
  periodUnit: "month",
  resolved,
});
/** The allowlist as the catalogue describes it: both free plans, and paid plans in INR only — as on the test site (A24). */
const ALLOWLIST = [plan("free-usd", "USD"), plan("free-inr", "INR"), plan("pro-inr", "INR")];

/** A live free subscription's record, as Chargebee answers it — free by A20's rule. */
const freeRecord = (currency: string, itemPriceId = currency === "USD" ? "free-usd" : "free-inr") => ({
  id: "sub_1",
  status: "active",
  currency_code: currency,
  subscription_items: [{ item_price_id: itemPriceId, item_type: "plan", amount: 0 }],
  mrr: 0,
  has_scheduled_changes: false,
  due_invoices_count: 0,
});
const paidRecord = (currency: string) => ({
  ...freeRecord(currency, "pro-inr"),
  subscription_items: [{ item_price_id: "pro-inr", item_type: "plan", amount: 100_000 }],
  mrr: 100_000,
});

const ADDRESS = {
  firstName: "Ann",
  lastName: "Lee",
  company: "Acme",
  line1: "1 Main St",
  line2: null,
  city: "Austin",
  state: "Texas",
  stateCode: "TX",
  zip: "73301",
  country: "US",
  email: "billing@acme.test",
  phone: "+1 512 555 0100",
  line3: "Suite 9",
};

function page(
  account: Record<string, unknown> = {},
  {
    over = {},
    plans = ALLOWLIST,
    currencySwitchEnabled = true,
    freePlanDefault = true,
    now = T0,
    catalog = CATALOG,
  }: {
    over?: Record<string, unknown>;
    plans?: PlanOffer[];
    currencySwitchEnabled?: boolean;
    freePlanDefault?: boolean;
    now?: number;
    catalog?: typeof CATALOG;
  } = {},
) {
  const prisma = makeFakePrisma({
    chargebeeCustomerId: TENANT,
    chargebeeSubscriptionId: "sub_1",
    chargebeeItemPriceId: "free-usd",
    ledgerUnitId: "token-test",
    status: "active",
    billingCountry: "US",
    currency: "USD",
    ...account,
  } as never);
  const accounts = createBillingAccountRepository(prisma);
  const switches = createCurrencySwitchRepository(prisma);
  const chargebee = {
    transactionsPage: vi.fn(async () => ({ transactions: [], nextOffset: null })),
    subscription: vi.fn(async () => freeRecord("USD")),
    paymentSource: vi.fn(async () => null),
    balance: vi.fn(async () => ({ unitId: "token-test", unitName: "token-test", usable: "400", onHold: "0" })),
    grantedCredits: vi.fn(async () => ({ credits: "1000", blocks: 1 })),
    unpaidInvoicesFor: vi.fn(async () => []),
    unpaidTopUpCredits: vi.fn(async () => "0"),
    customer: vi.fn(async () => ({ id: TENANT, billingAddress: ADDRESS, preferredCurrencyCode: "USD" })),
    ...over,
  };
  const topUpOffer = vi.fn(
    async (t: { itemPriceId: string; presetAmounts: number[] }): Promise<TopUpOffer> => ({
      itemPriceId: t.itemPriceId,
      name: t.itemPriceId,
      unitPriceMinor: 100,
      currencyCode: t.itemPriceId.slice(-3),
      presetAmounts: t.presetAmounts,
      minQuantity: 1,
      maxQuantity: null,
    }),
  );
  const plansOffered = vi.fn(async () => plans);
  const errors: Array<Record<string, unknown>> = [];
  const service = createBillingOverviewService({
    chargebee: chargebee as unknown as ChargebeeClient,
    accountService: { ensureLocalAccount: (t: string) => accounts.findByTenantId(t) } as never,
    accounts,
    syncs: createChargebeeSyncRepository(prisma),
    plansOffered,
    topUpOffer,
    catalog,
    switches,
    currencySwitchEnabled,
    freePlanDefault,
    clock: () => now,
    logger: { ...quietLogger, error: (o: unknown) => void errors.push(o as Record<string, unknown>) },
  });
  /** A switch of the org, seeded in `status`. */
  async function aSwitch(status: string, extra: Record<string, unknown> = {}) {
    const sw = await switches.create({ tenantId: TENANT, fromSubscriptionId: "sub_1", fromCurrency: "INR", toCurrency: "USD", toItemPriceId: "free-usd", at: new Date(T0) });
    Object.assign(prisma._switches.get(sw!.id)!, { status, ...extra });
  }
  return { service, chargebee, topUpOffer, plansOffered, prisma, errors, aSwitch };
}

describe("one top-up offer, in the subscription's currency, or none", () => {
  it("none before the org has confirmed a billing address — even on a live subscription (R1)", async () => {
    const r = page({ billingCountry: null });

    const overview = await r.service.overview(TENANT);

    expect(overview).toMatchObject({ kind: "linked", topUp: null, billingCountry: null });
    expect(r.topUpOffer).not.toHaveBeenCalled();
  });

  it("a USD subscription is offered the USD pack, an INR one the INR pack — one, never both (R5, R6)", async () => {
    const usd = await page().service.overview(TENANT);
    expect(usd).toMatchObject({ kind: "linked", currency: "USD", topUp: { itemPriceId: "api_token-USD", currencyCode: "USD" } });

    const r = page({ billingCountry: "IN", currency: "INR", chargebeeItemPriceId: "free-inr" }, { over: { subscription: vi.fn(async () => freeRecord("INR")) } });
    expect(await r.service.overview(TENANT)).toMatchObject({ currency: "INR", topUp: { itemPriceId: "api_token-INR" } });
    expect(r.topUpOffer).toHaveBeenCalledTimes(1);
  });

  it("follows the subscription, not the address: a paid INR plan with a US address is offered INR packs — and the page is told the plan is locked", async () => {
    const r = page({ currency: "INR", chargebeeItemPriceId: "pro-inr" }, { over: { subscription: vi.fn(async () => paidRecord("INR")) } });

    const overview = await r.service.overview(TENANT);

    expect(overview).toMatchObject({ topUp: { itemPriceId: "api_token-INR" }, currencyLocked: true, currencyChange: "locked" });
  });

  it("an account linked before the currency was stored takes it from the live subscription", async () => {
    const r = page({ currency: null }, { over: { subscription: vi.fn(async () => freeRecord("USD")) } });

    expect(await r.service.overview(TENANT)).toMatchObject({ currency: "USD", topUp: { itemPriceId: "api_token-USD" } });
  });

  it("none while a currency switch is open — asked for, moving, or finishing", async () => {
    for (const [status, extra] of [
      [SWITCH.REQUESTED, {}],
      [SWITCH.LINKED, { movingAt: new Date(T0), linkedAt: new Date(T0), toSubscriptionId: "sub_1", toSubscriptionAt: new Date(T0) }],
    ] as const) {
      const r = page();
      await r.aSwitch(status, extra);
      expect(await r.service.overview(TENANT)).toMatchObject({ topUp: null, currencySwitch: { state: status === SWITCH.REQUESTED ? "pending" : "finishing" } });
    }
  });

  it("offered again once the switch's cap has moved — what is left blocks nothing (A17)", async () => {
    const r = page();
    await r.aSwitch(SWITCH.LINKED, { movingAt: new Date(T0), linkedAt: new Date(T0), toSubscriptionId: "sub_1", toSubscriptionAt: new Date(T0), activatedAt: new Date(T0) });

    expect(await r.service.overview(TENANT)).toMatchObject({ currencySwitch: null, topUp: { itemPriceId: "api_token-USD" } });
  });

  it("none in a currency billing sells no pack in, nor on an ended subscription", async () => {
    const eur = page({ currency: "EUR" }, { over: { subscription: vi.fn(async () => freeRecord("EUR")) } });
    expect(await eur.service.overview(TENANT)).toMatchObject({ topUp: null });

    const cancelled = page({ status: ACCOUNT.CANCELLED });
    expect(await cancelled.service.overview(TENANT)).toMatchObject({ topUp: null, currencyChange: "none" });
  });
});

describe("the plans offered are in the confirmed country's currency", () => {
  it("none before an address — the page asks for it first — but the org's current plan is always listed", async () => {
    const r = page({ billingCountry: null, chargebeeItemPriceId: "free-usd" }, { freePlanDefault: false });

    expect((await r.service.overview(TENANT)).plansOffered.map((p) => p.itemPriceId)).toEqual(["free-usd"]);
  });

  it("an Indian org choosing a plan sees the INR plans only", async () => {
    const r = page(
      { billingCountry: "IN", chargebeeSubscriptionId: null, chargebeeItemPriceId: null, status: "unlinked", currency: null },
      { freePlanDefault: false, plans: [...ALLOWLIST, plan("pro-usd", "USD")] },
    );

    const overview = await r.service.overview(TENANT);

    expect(overview.plansOffered.map((p) => p.itemPriceId)).toEqual(["pro-inr"]);
    expect(overview.plansMissingForCurrency).toBe(false);
  });

  it("a currency with no paid plan says so — and raises it once per process (A24)", async () => {
    // A currency of its own (GBP), so no other test here has raised it first.
    const rules = { defaultCurrency: "USD", byCountry: { IN: "INR", GB: "GBP" } };
    const catalog = currencyCatalog(rules, {
      USD: { freeItemPriceId: "free-usd", topUp: null },
      INR: { freeItemPriceId: "free-inr", topUp: null },
      GBP: { freeItemPriceId: "free-gbp", topUp: null },
    });
    const r = page(
      { billingCountry: "GB", chargebeeSubscriptionId: null, chargebeeItemPriceId: null, status: "unlinked", currency: null },
      { freePlanDefault: false, catalog, plans: [...ALLOWLIST, plan("free-gbp", "GBP")] },
    );

    const overview = await r.service.overview(TENANT);
    await r.service.overview(TENANT);

    expect(overview.plansOffered).toEqual([]);
    expect(overview.plansMissingForCurrency).toBe(true);
    expect(r.errors.filter((e) => e.metric === "billing.plans.currency_missing")).toEqual([
      expect.objectContaining({ currency: "GBP", allowlisted: ["pro-inr"] }),
    ]);
  });

  it("a plan whose currency could not be read is not offered, and says nothing about the catalogue", async () => {
    const r = page(
      { billingCountry: "US", chargebeeSubscriptionId: null, chargebeeItemPriceId: null, status: "unlinked", currency: null },
      { freePlanDefault: false, plans: [plan("free-usd", "USD"), plan("pro-usd", null, false)] },
    );

    expect(await r.service.overview(TENANT)).toMatchObject({ plansOffered: [], plansMissingForCurrency: false });
  });
});

describe("the currency switch, as the page is told about it", () => {
  it("pending while asked for, moving while the credits move", async () => {
    const pending = page();
    await pending.aSwitch(SWITCH.REQUESTED);
    expect((await pending.service.overview(TENANT)).currencySwitch).toEqual({
      fromCurrency: "INR",
      toCurrency: "USD",
      state: "pending",
      reason: null,
      since: new Date(T0),
    });

    const moving = page({ status: ACCOUNT.SWITCHING });
    await moving.aSwitch(SWITCH.MOVING, { movingAt: new Date(T0 + MINUTE) });
    expect((await moving.service.overview(TENANT)).currencySwitch).toMatchObject({ state: "moving", since: new Date(T0 + MINUTE) });
  });

  it("failed for a day after it was given up — towards the currency the org's country still wants (A1)", async () => {
    // An INR org with a US address whose switch to USD timed out.
    const account = { currency: "INR", chargebeeItemPriceId: "free-inr" };
    const over = { subscription: vi.fn(async () => freeRecord("INR")) };
    const failed = page(account, { over, now: T0 + 60 * MINUTE });
    await failed.aSwitch(SWITCH.ABANDONED, { error: "timed_out", updatedAt: new Date(T0) });

    const overview = await failed.service.overview(TENANT);
    expect(overview.currencySwitch).toEqual({ fromCurrency: "INR", toCurrency: "USD", state: "failed", reason: "timed_out", since: new Date(T0) });
    // Top-ups go on in the subscription's currency while it has failed (R5).
    expect(overview).toMatchObject({ kind: "linked", topUp: { itemPriceId: "api_token-INR" } });

    const later = page(account, { over, now: T0 + FAILED_SWITCH_SHOWN_MS + MINUTE });
    await later.aSwitch(SWITCH.ABANDONED, { error: "timed_out", updatedAt: new Date(T0) });
    expect((await later.service.overview(TENANT)).currencySwitch).toBeNull();
  });

  it("never failed when the org made it moot itself, or no longer wants that currency", async () => {
    const changedBack = page({ currency: "INR" }, { over: { subscription: vi.fn(async () => freeRecord("INR")) } });
    await changedBack.aSwitch(SWITCH.ABANDONED, { error: "country_changed", updatedAt: new Date(T0) });
    expect((await changedBack.service.overview(TENANT)).currencySwitch).toBeNull();

    const nowIndian = page({ currency: "INR", billingCountry: "IN" }, { over: { subscription: vi.fn(async () => freeRecord("INR")) } });
    await nowIndian.aSwitch(SWITCH.ABANDONED, { error: "timed_out", updatedAt: new Date(T0) });
    expect((await nowIndian.service.overview(TENANT)).currencySwitch).toBeNull();
  });

  it("while the account is switching the page reads the database only — not one Chargebee call (A22)", async () => {
    const refuse = () =>
      vi.fn(async () => {
        throw new Error("no Chargebee call while switching");
      });
    const r = page(
      { status: ACCOUNT.SWITCHING },
      {
        over: {
          transactionsPage: refuse(),
          subscription: refuse(),
          paymentSource: refuse(),
          balance: refuse(),
          grantedCredits: refuse(),
          unpaidInvoicesFor: refuse(),
          unpaidTopUpCredits: refuse(),
          customer: refuse(),
        },
      },
    );
    await r.aSwitch(SWITCH.MOVING, { movingAt: new Date(T0) });

    const overview = await r.service.overview(TENANT);

    expect(overview).toMatchObject({ kind: "switching", billingCountry: "US", currency: "USD", currencySwitch: { state: "moving" }, plansOffered: [] });
    expect(r.plansOffered).not.toHaveBeenCalled();
    expect(r.errors).toEqual([]);
  });
});

describe("what saving another country's address would do (A6)", () => {
  it("switch for a live free subscription; locked for a paid one, or with the switch turned off (A23); none while being set up", async () => {
    expect((await page().service.overview(TENANT)).currencyChange).toBe("switch");
    expect((await page({}, { currencySwitchEnabled: false }).service.overview(TENANT)).currencyChange).toBe("locked");
    expect((await page({}, { over: { subscription: vi.fn(async () => paidRecord("USD")) } }).service.overview(TENANT)).currencyChange).toBe("locked");
    expect((await page({ status: ACCOUNT.ACTIVATING }).service.overview(TENANT)).currencyChange).toBe("none");
    expect((await page({ chargebeeSubscriptionId: null, status: "unlinked" }).service.overview(TENANT)).currencyChange).toBe("none");
  });

  it("a free plan that cannot be switched keeps its currency, and the page says so: switching off (A23), or no free plan to switch to", async () => {
    // An INR org on the free INR plan whose confirmed country is now the US.
    const account = { currency: "INR", chargebeeItemPriceId: "free-inr" };
    const over = { subscription: vi.fn(async () => freeRecord("INR")) };

    expect(await page(account, { over }).service.overview(TENANT)).toMatchObject({ currencyLocked: false, currencyChange: "switch" });
    expect(await page(account, { over, currencySwitchEnabled: false }).service.overview(TENANT)).toMatchObject({
      currencyLocked: true,
      currencyChange: "locked",
    });
    const noFreePlans = currencyCatalog(RULES, { USD: { freeItemPriceId: null, topUp: null }, INR: { freeItemPriceId: null, topUp: null } });
    expect(await page(account, { over, catalog: noFreePlans }).service.overview(TENANT)).toMatchObject({
      currencyLocked: true,
      currencyChange: "locked",
    });
  });

  it("a ₹0 plan carrying a paid addon is not free: decided from the LIVE record (A20)", async () => {
    const addon = { ...freeRecord("USD"), subscription_items: [...freeRecord("USD").subscription_items, { item_price_id: "addon", item_type: "addon", amount: 500 }] };

    expect((await page({}, { over: { subscription: vi.fn(async () => addon) } }).service.overview(TENANT)).currencyChange).toBe("locked");
  });
});

describe("the billing address the page shows", () => {
  it("is Chargebee's, with the form's ten fields only — never the email, phone or third line", async () => {
    expect((await page().service.overview(TENANT)).billingAddress).toEqual({
      firstName: "Ann",
      lastName: "Lee",
      company: "Acme",
      line1: "1 Main St",
      line2: null,
      city: "Austin",
      state: "Texas",
      stateCode: "TX",
      zip: "73301",
      country: "US",
    });
  });

  it("an address that cannot be read is null — the page shows the country alone — and the page renders anyway", async () => {
    const r = page({}, {
      over: {
        customer: vi.fn(async () => {
          throw new Error("Chargebee 503");
        }),
      },
    });

    expect(await r.service.overview(TENANT)).toMatchObject({ kind: "linked", billingAddress: null, billingCountry: "US", credits: { current: "400" } });
    expect(r.errors).toContainEqual(expect.objectContaining({ metric: "billing.page.address_unreadable" }));
  });
});

describe("every key, for every kind of page", () => {
  const CURRENCY_KEYS = [
    "billingCountry",
    "billingAddress",
    "currency",
    "currencyRules",
    "currencySwitch",
    "currencyLocked",
    "currencyChange",
    "plansMissingForCurrency",
  ];
  const config = { site: "test-site", defaultItemPriceId: "pro-inr" };

  it("unlinked, activating, switching and linked all render the same keys — the currency ones among them", async () => {
    const kinds = {
      unlinked: page(),
      activating: page({ status: ACCOUNT.ACTIVATING }),
      switching: page({ status: ACCOUNT.SWITCHING }),
      linked: page(),
    };
    kinds.unlinked.prisma._accounts.delete(TENANT); // no billing row at all; the platform does not know it either
    (kinds.unlinked.prisma as { $queryRaw?: unknown }).$queryRaw = async () => [];

    const rendered: Record<string, Record<string, unknown>> = {};
    for (const [kind, r] of Object.entries(kinds)) {
      const overview = await r.service.overview(TENANT);
      expect(overview.kind).toBe(kind);
      rendered[kind] = renderBillingOverview(overview, config);
    }

    const keys = Object.keys(rendered.linked!).sort();
    for (const key of CURRENCY_KEYS) expect(keys).toContain(key);
    for (const view of Object.values(rendered)) expect(Object.keys(view).sort()).toEqual(keys);

    expect(rendered.switching).toMatchObject({ status: "switching", credits: { granted: "0", current: "0" }, topUp: null });
    expect(rendered.unlinked).toMatchObject({ billingCountry: null, currency: null, currencyRules: RULES, currencyChange: "none" });
    expect(rendered.linked).toMatchObject({ billingCountry: "US", currency: "USD", currencyRules: RULES, currencyLocked: false });
  });
});
