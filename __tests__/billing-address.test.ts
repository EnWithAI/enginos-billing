/**
 * The billing address saved in Chargebee's own editor — and, through its
 * country, the currency (A29).
 *
 *   READ BACK, NEVER SENT. The org saves its address in Chargebee's portal
 *   section; billing reads it off the customer and keeps the one fact that
 *   decides the currency: the country. Nothing the caller sends is taken for
 *   the address.
 *
 *   THE COUNTRY IS ALWAYS KEPT. What used to refuse an address — an unpaid
 *   top-up, credits being set up, a switch moving the org — now leaves the
 *   switch waiting, said in `waitingOn`, or finishing first.
 *
 *   WHAT IT DOES TO THE CURRENCY. Nothing in the same currency. A FREE
 *   subscription in another currency asks for a currency switch and runs it
 *   for what is left of the request's time; a PAID plan keeps its currency,
 *   and so does every plan while switching is off (the page says it is
 *   locked). An org with no subscription gets its next one in the new
 *   currency — from the page's next load, never from here.
 *
 *   THE ANSWER IS WHAT HAPPENED: 200 once the country is kept, whatever its
 *   switch did inline; `synced: false` for an address with no country; a 502
 *   only when nothing was kept.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChargebeeClient } from "@/integrations/chargebee";
import { ACCOUNT } from "@/models/account-status";
import { currencyCatalog, type CurrencyCatalog, type CurrencyRules } from "@/models/currency";
import { createBillingAccountRepository } from "@/repositories/billing-account.repository";
import { createChargebeeSyncRepository } from "@/repositories/chargebee-sync.repository";
import { createCurrencySwitchRepository, SWITCH } from "@/repositories/currency-switch.repository";
import { createAccountService } from "@/services/account.service";
import { createBillingAddressService, MIN_INLINE_STEP_MS, type SwitchWaitReason } from "@/services/billing-address.service";
import { createBillingOverviewService } from "@/services/billing-overview.service";
import { createCheckoutService } from "@/services/checkout.service";
import { createWebhookService } from "@/services/webhook.service";
import { AppError } from "@/shared/errors";

import { MINUTE, T0, TENANT, makeFakePrisma, quietLogger } from "./harness";

/**
 * For the route's own tests (the last block): the container's Prisma client
 * and Chargebee client, as webhook.test.ts swaps them. The service tests
 * above hand their services fakes directly and never reach either.
 */
const held = vi.hoisted(() => ({
  prisma: null as unknown as ReturnType<typeof import("./harness").makeFakePrisma>,
  chargebee: null as unknown as Record<string, unknown>,
}));

vi.mock("@/db/prisma", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/prisma")>()),
  get prisma() {
    return held.prisma;
  },
}));
vi.mock("@/integrations/chargebee", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/chargebee")>()),
  createChargebee: () => held.chargebee,
}));
// No gateway: these tests are about the address and its currency, not the cap.
vi.mock("@/container/budget-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/container/budget-hooks")>()),
  gatewayBudgetHooks: () => ({}),
}));

const RULES: CurrencyRules = { defaultCurrency: "USD", byCountry: { IN: "INR" } };
const topUp = (itemPriceId: string) => ({ itemPriceId, presetAmounts: [5, 10], minAmount: null, maxAmount: null, credits: "50" });
const CATALOG = currencyCatalog(RULES, {
  USD: { freeItemPriceId: "free-usd", topUp: topUp("api_token-USD") },
  INR: { freeItemPriceId: "free-inr", topUp: topUp("api_token-INR") },
});
const PRICES: Record<string, { priceMinor: number; currencyCode: string }> = {
  "free-usd": { priceMinor: 0, currencyCode: "USD" },
  "free-inr": { priceMinor: 0, currencyCode: "INR" },
  "pro-inr": { priceMinor: 100_000, currencyCode: "INR" },
};
const itemPrice = async (id: string) => (PRICES[id] ? { id, name: id, period: 1, periodUnit: "year", ...PRICES[id] } : null);

/** The live record of a free INR subscription (free by A20's rule), and of a paid one. */
const FREE_INR = {
  id: "sub_1",
  status: "active",
  currency_code: "INR",
  subscription_items: [{ item_price_id: "free-inr", item_type: "plan", amount: 0 }],
  mrr: 0,
  has_scheduled_changes: false,
  due_invoices_count: 0,
};
const PAID_INR = { ...FREE_INR, subscription_items: [{ item_price_id: "pro-inr", item_type: "plan", amount: 100_000 }], mrr: 100_000 };

/**
 * The customer as Chargebee answers it after the org saved its address in
 * Chargebee's editor: in `country` — null for an address saved with no
 * country, undefined for no address at all.
 */
function customerIn(country: string | null | undefined) {
  return {
    id: TENANT,
    billingAddress:
      country === undefined
        ? null
        : {
            firstName: "Asha",
            lastName: null,
            company: "Acme",
            line1: "12 Main Road",
            line2: null,
            city: "Springfield",
            state: null,
            stateCode: null,
            zip: null,
            country,
            email: null,
            phone: null,
            line3: null,
          },
    preferredCurrencyCode: "INR",
    vatNumber: null,
    vatNumberPrefix: null,
    registeredForGst: null,
    businessCustomerWithoutVatNumber: null,
  };
}

async function rejection(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

/**
 * An Indian org on the free INR plan, address confirmed — whose address in
 * Chargebee is now in `address` — and the services a sync goes through, real
 * over the fakes, with a stand-in for the currency switch (stage B3's
 * service): `request` writes the REQUESTED row the real one would, `advance`
 * answers what it was set to.
 */
function syncing(
  account: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
  {
    address = "US",
    currencySwitchEnabled = true,
    switcher = true,
    now = T0,
    catalog = CATALOG,
  }: { address?: string | null; currencySwitchEnabled?: boolean; switcher?: boolean; now?: number; catalog?: CurrencyCatalog } = {},
) {
  const prisma = makeFakePrisma({
    chargebeeCustomerId: TENANT,
    chargebeeSubscriptionId: "sub_1",
    chargebeeItemPriceId: "free-inr",
    ledgerUnitId: "token-test",
    status: "active",
    billingCountry: "IN",
    currency: "INR",
    ...account,
  } as never);
  const chargebee = {
    createCustomer: vi.fn(async ({ id }: { id: string }) => ({ id })),
    customer: vi.fn(async () => customerIn(address)),
    subscription: vi.fn(async () => FREE_INR),
    itemPrice: vi.fn(itemPrice),
    activeSubscriptions: vi.fn(async () => []),
    subscribeCustomer: vi.fn(async () => ({ id: "sub_new" })),
    setPreferredCurrency: vi.fn(async () => ({})),
    balance: vi.fn(async () => ({ unitId: "token-test", unitName: "token-test", usable: "400", onHold: "0" })),
    grantedCredits: vi.fn(async () => ({ credits: "1000", blocks: 1 })),
    unpaidTopUpCredits: vi.fn(async () => "0"),
    unpaidInvoicesFor: vi.fn(async () => []),
    transactionsPage: vi.fn(async () => ({ transactions: [], nextOffset: null })),
    paymentSource: vi.fn(async () => null),
    ...over,
  };
  const client = chargebee as unknown as ChargebeeClient;
  const accounts = createBillingAccountRepository(prisma);
  const switches = createCurrencySwitchRepository(prisma);
  const accountService = createAccountService({
    prisma,
    chargebee: client,
    usdPerCredit: "0.001",
    freeItemPriceIds: ["free-usd", "free-inr"],
    topUpItemPriceIds: ["api_token-USD", "api_token-INR"],
    logger: quietLogger,
  });
  const checkout = createCheckoutService({
    chargebee: client,
    accountService,
    accounts,
    itemPriceIds: ["free-usd", "free-inr", "pro-inr"],
    defaultItemPriceId: "pro-inr",
    catalog,
    freePlanDefault: true,
    switches,
    logger: quietLogger,
    sleep: async () => {},
  });
  const currencySwitch = {
    request: vi.fn(async (tenantId: string, toCurrency: string) => {
      const row = await switches.create({
        tenantId,
        fromSubscriptionId: "sub_1",
        fromCurrency: "INR",
        toCurrency,
        toItemPriceId: catalog.settings[toCurrency]!.freeItemPriceId!,
        at: new Date(now),
      });
      return row ?? switches.findOpen(tenantId);
    }),
    advance: vi.fn(async (tenantId: string, _opts: { deadline: number; minStepMs: number }) => ({
      open: await switches.findOpen(tenantId),
      waitingOn: null as SwitchWaitReason | null,
    })),
  };
  const logged: Array<Record<string, unknown>> = [];
  const logger = {
    log: (o: unknown) => void logged.push(o as Record<string, unknown>),
    warn: (o: unknown) => void logged.push(o as Record<string, unknown>),
    error: (o: unknown) => void logged.push(o as Record<string, unknown>),
  };
  const service = createBillingAddressService({
    chargebee: client,
    accountService,
    accounts,
    switches,
    catalog,
    currencySwitchEnabled,
    switchInlineMs: 6_000,
    ...(switcher ? { currencySwitch } : {}),
    clock: () => now,
    logger,
  });
  const overview = createBillingOverviewService({
    chargebee: client,
    accountService,
    accounts,
    syncs: createChargebeeSyncRepository(prisma),
    plansOffered: async () => [],
    topUpOffer: async (t) => ({
      itemPriceId: t.itemPriceId,
      name: t.itemPriceId,
      unitPriceMinor: 100,
      currencyCode: t.itemPriceId.slice(-3),
      presetAmounts: t.presetAmounts,
      minQuantity: 1,
      maxQuantity: null,
    }),
    autoSubscribe: (tenantId) => checkout.provisionFreePlan(tenantId),
    catalog,
    switches,
    currencySwitchEnabled,
    freePlanDefault: true,
    clock: () => now,
    logger: quietLogger,
  });
  /** A switch of the org, seeded in `status`. */
  async function aSwitch(status: string, extra: Record<string, unknown> = {}, toCurrency = "USD", fromCurrency = "INR") {
    const sw = await switches.create({
      tenantId: TENANT,
      fromSubscriptionId: "sub_1",
      fromCurrency,
      toCurrency,
      toItemPriceId: toCurrency === "USD" ? "free-usd" : "free-inr",
      at: new Date(T0),
    });
    Object.assign(prisma._switches.get(sw!.id)!, { status, ...extra });
    return sw!.id;
  }
  return {
    service,
    overview,
    chargebee,
    currencySwitch,
    prisma,
    logged,
    aSwitch,
    account: () => prisma._accounts.get(TENANT)!,
    metrics: () => logged.map((o) => o.metric),
  };
}

/** What a sync answers when it kept the country and nothing else had to happen. */
const kept = (billingCountry: string, currency: string | null) => ({
  synced: true,
  reason: null,
  billingCountry,
  currency,
  currencySwitch: null,
  currencyLocked: false,
  waitingOn: null,
});

describe("syncing the billing address saved in Chargebee", () => {
  it("keeps the country of the address Chargebee holds — read off the org's own customer — and in the same currency starts nothing", async () => {
    const r = syncing({ billingCountry: null }, {}, { address: "IN" });

    expect(await r.service.syncBillingAddress(TENANT, { startedAt: T0 })).toEqual(kept("IN", "INR"));

    expect(r.chargebee.customer).toHaveBeenCalledWith(TENANT);
    expect(r.account().billingCountry).toBe("IN");
    expect(r.currencySwitch.request).not.toHaveBeenCalled();
    // The currency did not move, so the subscription was not even read.
    expect(r.chargebee.subscription).not.toHaveBeenCalled();
    expect(r.logged).toContainEqual(expect.objectContaining({ metric: "billing.address.synced", country: "IN", from: null, outcome: "same" }));
  });

  it("a country Chargebee spells in lower case is kept as billing compares it", async () => {
    const r = syncing({ billingCountry: null }, {}, { address: " in " });

    expect(await r.service.syncBillingAddress(TENANT)).toMatchObject({ synced: true, billingCountry: "IN" });
  });

  it("a free subscription moved to another currency's country asks for a switch, and runs it inline within the request's time", async () => {
    const r = syncing();

    const synced = await r.service.syncBillingAddress(TENANT, { startedAt: T0 });

    expect(r.account().billingCountry).toBe("US");
    expect(r.chargebee.subscription).toHaveBeenCalledWith("sub_1"); // free or paid: the LIVE record says (A20)
    expect(r.currencySwitch.request).toHaveBeenCalledWith(TENANT, "USD");
    // The deadline counts from when the request ARRIVED.
    expect(r.currencySwitch.advance).toHaveBeenCalledWith(TENANT, { deadline: T0 + 6_000, minStepMs: MIN_INLINE_STEP_MS });
    expect(synced).toEqual({
      synced: true,
      reason: null,
      billingCountry: "US",
      currency: "INR", // until the switch has moved it
      currencySwitch: { fromCurrency: "INR", toCurrency: "USD", state: "pending", reason: null, since: new Date(T0) },
      currencyLocked: false,
      waitingOn: null,
    });
  });

  it("a switch that finished inline is answered as done: the org is billed in the new currency, and nothing is pending", async () => {
    const r = syncing();
    r.currencySwitch.advance.mockImplementationOnce(async () => {
      // What the switch does when it gets through: B linked, the cap moved.
      const sw = [...r.prisma._switches.values()][0]!;
      Object.assign(sw, {
        status: SWITCH.LINKED,
        movingAt: new Date(T0),
        toSubscriptionId: "sub_2",
        toSubscriptionAt: new Date(T0),
        linkedAt: new Date(T0),
        activatedAt: new Date(T0),
      });
      Object.assign(r.account(), { chargebeeSubscriptionId: "sub_2", chargebeeItemPriceId: "free-usd", currency: "USD" });
      return { open: null, waitingOn: null };
    });

    expect(await r.service.syncBillingAddress(TENANT, { startedAt: T0 })).toEqual(kept("US", "USD"));
  });

  it("what used to refuse the save now leaves the switch waiting, and says on what (A29): an unpaid top-up", async () => {
    const r = syncing();
    r.currencySwitch.advance.mockImplementationOnce(async () => ({ open: null, waitingOn: "topup-unpaid" }));

    expect(await r.service.syncBillingAddress(TENANT, { startedAt: T0 })).toMatchObject({
      synced: true,
      billingCountry: "US",
      currencySwitch: { state: "pending", toCurrency: "USD" },
      waitingOn: "topup-unpaid",
    });
  });

  it("…and credits still being set up: the switch is asked for all the same — it waits in REQUESTED, not refused", async () => {
    const r = syncing({ status: ACCOUNT.ACTIVATING });
    r.currencySwitch.advance.mockImplementationOnce(async () => ({ open: null, waitingOn: "billing-activating" }));

    expect(await r.service.syncBillingAddress(TENANT)).toMatchObject({ billingCountry: "US", waitingOn: "billing-activating" });
    expect(r.currencySwitch.request).toHaveBeenCalledWith(TENANT, "USD");
  });

  it("runs nothing inline with too little of the request's time left — the worker does it — and still answers what it asked for", async () => {
    const r = syncing({}, {}, { now: T0 + 5_000 });

    const synced = await r.service.syncBillingAddress(TENANT, { startedAt: T0 });

    expect(r.currencySwitch.request).toHaveBeenCalledTimes(1);
    expect(r.currencySwitch.advance).not.toHaveBeenCalled();
    expect(synced.currencySwitch).toMatchObject({ state: "pending", toCurrency: "USD" });
  });

  it("a switch that fails inline does not fail the sync: the country IS kept, the answer is 200, and the worker carries it on", async () => {
    const r = syncing();
    r.currencySwitch.advance.mockRejectedValueOnce(new Error("Chargebee 503"));

    expect(await r.service.syncBillingAddress(TENANT, { startedAt: T0 })).toMatchObject({ synced: true, billingCountry: "US", waitingOn: null });
    expect(r.account().billingCountry).toBe("US");
    expect(r.logged).toContainEqual(expect.objectContaining({ metric: "billing.currency_switch.inline_failed", toCurrency: "USD" }));
  });

  it("a subscription whose currency cannot be read keeps the country, and decides nothing on a guess", async () => {
    const r = syncing({ currency: null }, { subscription: vi.fn(async () => Promise.reject(new Error("Chargebee 503"))) });

    expect(await r.service.syncBillingAddress(TENANT)).toMatchObject({ synced: true, billingCountry: "US", currencySwitch: null, currencyLocked: false });
    expect(r.currencySwitch.request).not.toHaveBeenCalled();
    expect(r.metrics()).toContain("billing.address.currency_sync_failed");

    // Read, but naming no currency: the same — said, and nothing asked for.
    const unnamed = syncing({ currency: null }, { subscription: vi.fn(async () => ({ ...FREE_INR, currency_code: undefined })) });
    expect(await unnamed.service.syncBillingAddress(TENANT)).toMatchObject({ synced: true, billingCountry: "US", currency: null });
    expect(unnamed.currencySwitch.request).not.toHaveBeenCalled();
    expect(unnamed.metrics()).toContain("billing.address.currency_unknown");
  });

  it("a paid plan keeps its currency: the country is kept, no switch is asked for, and the page says the plan is locked", async () => {
    const r = syncing({ chargebeeItemPriceId: "pro-inr" }, { subscription: vi.fn(async () => PAID_INR) });

    expect(await r.service.syncBillingAddress(TENANT)).toEqual({ ...kept("US", "INR"), currencyLocked: true });
    expect(r.currencySwitch.request).not.toHaveBeenCalled();

    const page = await r.overview.overview(TENANT);
    // Top-ups stay in the plan's currency (R5).
    expect(page).toMatchObject({ billingCountry: "US", currency: "INR", currencyLocked: true, currencyChange: "locked", topUp: { itemPriceId: "api_token-INR" } });
  });

  it("with switching turned off (A23), a free plan keeps its currency too — and the page says so — while a save in its own currency is as ever", async () => {
    const r = syncing({}, {}, { currencySwitchEnabled: false });

    expect(await r.service.syncBillingAddress(TENANT)).toEqual({ ...kept("US", "INR"), currencyLocked: true });
    expect(r.currencySwitch.request).not.toHaveBeenCalled();
    expect(await r.overview.overview(TENANT)).toMatchObject({ currencyLocked: true, currencyChange: "locked", topUp: { itemPriceId: "api_token-INR" } });

    r.chargebee.customer.mockResolvedValue(customerIn("IN"));
    expect(await r.service.syncBillingAddress(TENANT)).toEqual(kept("IN", "INR"));
  });

  it("no free plan to switch to keeps the currency, said for an operator", async () => {
    const plain = currencyCatalog(RULES, { USD: { freeItemPriceId: null, topUp: null }, INR: { freeItemPriceId: null, topUp: null } });
    const r = syncing({}, {}, { catalog: plain });

    expect(await r.service.syncBillingAddress(TENANT)).toMatchObject({ billingCountry: "US", currencyLocked: true });
    expect(r.currencySwitch.request).not.toHaveBeenCalled();
    expect(r.logged).toContainEqual(expect.objectContaining({ metric: "billing.currency_switch.misconfigured", toCurrency: "USD" }));
  });

  it("an org with no subscription is not provisioned by the sync — its next page load puts it on the free plan of the address's currency (A3)", async () => {
    const r = syncing(
      { chargebeeSubscriptionId: null, chargebeeItemPriceId: null, ledgerUnitId: null, status: "unlinked", billingCountry: null, currency: null },
      {},
      { address: "IN" },
    );

    expect(await r.service.syncBillingAddress(TENANT)).toEqual(kept("IN", null));
    expect(r.chargebee.subscribeCustomer).not.toHaveBeenCalled();

    await r.overview.overview(TENANT);
    expect(r.chargebee.subscribeCustomer).toHaveBeenCalledWith({ customerId: TENANT, itemPriceId: "free-inr", idempotencyKey: `free-plan:${TENANT}:INR` });
  });

  it("a cancelled subscription is switched nothing: the org's next one is in the country's currency", async () => {
    const r = syncing({ status: ACCOUNT.CANCELLED });

    expect(await r.service.syncBillingAddress(TENANT)).toMatchObject({ synced: true, billingCountry: "US", currencyLocked: false });
    expect(r.currencySwitch.request).not.toHaveBeenCalled();
    expect(r.chargebee.subscription).not.toHaveBeenCalled();
  });

  it("with no currency switch wired yet, the country is kept and the worker is left to ask for the switch", async () => {
    const r = syncing({}, {}, { switcher: false });

    expect(await r.service.syncBillingAddress(TENANT)).toMatchObject({ synced: true, billingCountry: "US", currencySwitch: null });
    expect(r.metrics()).toContain("billing.currency_switch.not_wired");
  });
});

describe("an address with no country — or none at all — keeps nothing", () => {
  it("says so (`no-country`) and changes nothing: a country kept before stays — the org is never moved by a half-cleared address", async () => {
    const r = syncing({}, {}, { address: null });

    expect(await r.service.syncBillingAddress(TENANT)).toEqual({
      synced: false,
      reason: "no-country",
      billingCountry: "IN",
      currency: "INR",
      currencySwitch: null,
      currencyLocked: false,
      waitingOn: null,
    });
    expect(r.account().billingCountry).toBe("IN");
    expect(r.currencySwitch.request).not.toHaveBeenCalled();
    expect(r.logged).toContainEqual(expect.objectContaining({ metric: "billing.address.no_country", billingCountry: "IN", hasAddress: true }));
  });

  it("the same for a customer with no address yet — the editor closed without a save", async () => {
    const r = syncing({ billingCountry: null }, { customer: vi.fn(async () => customerIn(undefined)) });

    expect(await r.service.syncBillingAddress(TENANT)).toMatchObject({ synced: false, reason: "no-country", billingCountry: null });
    expect(r.account().billingCountry).toBeNull();
  });

  it("an org with no Chargebee customer has no address to read, and Chargebee is not asked", async () => {
    const r = syncing({ chargebeeCustomerId: null, billingCountry: null });

    expect(await r.service.syncBillingAddress(TENANT)).toMatchObject({ synced: false, reason: "no-country" });
    expect(r.chargebee.customer).not.toHaveBeenCalled();
  });

  it("Chargebee unreachable is not dressed as 'no country': it fails for the route's 502, with nothing kept", async () => {
    const outage = Object.assign(new Error("Chargebee timeout"), { retryable: true });
    const r = syncing({}, { customer: vi.fn(async () => Promise.reject(outage)) });

    await expect(r.service.syncBillingAddress(TENANT)).rejects.toBe(outage);
    expect(r.account().billingCountry).toBe("IN");
    expect(r.currencySwitch.request).not.toHaveBeenCalled();
  });

  it("a tenant the platform does not know: 404 tenant-not-found", async () => {
    const r = syncing();
    r.prisma._accounts.delete(TENANT);
    (r.prisma as { $queryRaw?: unknown }).$queryRaw = async () => [];

    const err = await rejection(r.service.syncBillingAddress(TENANT));
    expect([err.kind, err.code]).toEqual(["not_found", "tenant-not-found"]);
  });
});

describe("a switch already asked for, or under way (A1)", () => {
  it("an address changed back abandons one only asked for — moot, not failed — and asks for nothing new", async () => {
    const r = syncing({ billingCountry: "US" }, {}, { address: "IN" });
    const id = await r.aSwitch(SWITCH.REQUESTED);

    expect(await r.service.syncBillingAddress(TENANT)).toEqual(kept("IN", "INR"));

    expect(r.prisma._switches.get(id)).toMatchObject({ status: SWITCH.ABANDONED, error: "country_changed" });
    expect(r.currencySwitch.request).not.toHaveBeenCalled();
  });

  it("one that started meanwhile is not abandoned under it: the country is still kept, and the switch finishes", async () => {
    const r = syncing({ billingCountry: "US" }, {}, { address: "IN" });
    const id = await r.aSwitch(SWITCH.REQUESTED);
    // It starts between the sync's look and its abandon.
    vi.spyOn(r.prisma.currencySwitch, "updateMany").mockImplementationOnce(async () => {
      Object.assign(r.prisma._switches.get(id)!, { status: SWITCH.MOVING, movingAt: new Date(T0) });
      return { count: 0 };
    });

    const synced = await r.service.syncBillingAddress(TENANT);

    expect(synced).toMatchObject({ synced: true, billingCountry: "IN", currencySwitch: { state: "moving", toCurrency: "USD" } });
    expect(r.prisma._switches.get(id)!.status).toBe(SWITCH.MOVING);
    expect(r.account().billingCountry).toBe("IN");
    expect(r.logged).toContainEqual(expect.objectContaining({ metric: "billing.currency_switch.abandoned", switchId: id, abandoned: false }));
  });

  it("one still moving the org elsewhere finishes first: the country is kept, nothing new is asked for, and the worker asks for the way back", async () => {
    // INR → USD, linked to the new USD subscription, its cap not moved yet — and the org now says India again.
    const r = syncing({ status: ACCOUNT.SWITCHING, chargebeeSubscriptionId: "sub_2", chargebeeItemPriceId: "free-usd", currency: "USD", billingCountry: "US" }, {
      subscription: vi.fn(async () => ({ ...FREE_INR, id: "sub_2", currency_code: "USD", subscription_items: [{ item_price_id: "free-usd", item_type: "plan", amount: 0 }] })),
    }, { address: "IN" });
    await r.aSwitch(SWITCH.LINKED, { movingAt: new Date(T0), toSubscriptionId: "sub_2", toSubscriptionAt: new Date(T0), linkedAt: new Date(T0) });

    expect(await r.service.syncBillingAddress(TENANT)).toMatchObject({
      synced: true,
      billingCountry: "IN",
      currency: "USD",
      currencySwitch: { state: "finishing", toCurrency: "USD" },
    });
    expect(r.currencySwitch.request).not.toHaveBeenCalled();
    expect(r.logged).toContainEqual(expect.objectContaining({ metric: "billing.currency_switch.request_deferred", toCurrency: "INR" }));
  });

  it("one moving the org to the country's own currency is helped along inline — the same switch, not a second", async () => {
    const r = syncing({ status: ACCOUNT.SWITCHING });
    await r.aSwitch(SWITCH.MOVING, { movingAt: new Date(T0) });

    const synced = await r.service.syncBillingAddress(TENANT, { startedAt: T0 });

    expect(synced.currencySwitch).toMatchObject({ state: "moving", toCurrency: "USD" });
    expect(r.currencySwitch.advance).toHaveBeenCalledTimes(1);
    expect([...r.prisma._switches.values()]).toHaveLength(1);
  });

  it("syncing the same country again keeps the one asked for — the request is the same switch", async () => {
    const r = syncing({ billingCountry: "US" });
    const id = await r.aSwitch(SWITCH.REQUESTED);

    const synced = await r.service.syncBillingAddress(TENANT);

    expect(r.prisma._switches.get(id)!.status).toBe(SWITCH.REQUESTED);
    expect(synced.currencySwitch).toMatchObject({ state: "pending", toCurrency: "USD" });
    expect([...r.prisma._switches.values()]).toHaveLength(1);
  });

  it("one whose cap has moved blocks nothing, but holds the place of the next until it is done: that one is the worker's to ask for", async () => {
    // The org has just been switched USD → INR: linked and activated, only cancelling the old subscription left.
    const r = syncing();
    await r.aSwitch(
      SWITCH.LINKED,
      { fromSubscriptionId: "sub_0", movingAt: new Date(T0), linkedAt: new Date(T0), toSubscriptionId: "sub_1", toSubscriptionAt: new Date(T0), activatedAt: new Date(T0) },
      "INR",
      "USD",
    );

    expect(await r.service.syncBillingAddress(TENANT)).toMatchObject({ synced: true, billingCountry: "US", currencySwitch: null, waitingOn: null });
    expect(r.currencySwitch.request).toHaveBeenCalledWith(TENANT, "USD");
    expect(r.currencySwitch.advance).not.toHaveBeenCalled();
    expect(r.metrics()).toContain("billing.currency_switch.request_deferred");
  });

  it("a switch that failed lately is asked for again when the org syncs its address again — its 'Try again'", async () => {
    const r = syncing({ billingCountry: "US" }, {}, { now: T0 + 60 * MINUTE });
    await r.aSwitch(SWITCH.ABANDONED, { error: "timed_out", updatedAt: new Date(T0) });

    const synced = await r.service.syncBillingAddress(TENANT);

    expect(r.currencySwitch.request).toHaveBeenCalledWith(TENANT, "USD");
    expect(synced.currencySwitch).toMatchObject({ state: "pending", toCurrency: "USD" });
  });
});

describe("customer_changed: Chargebee holds the address, so it is synced (A29)", () => {
  function changed(r: ReturnType<typeof syncing>) {
    const logged: Array<Record<string, unknown>> = [];
    const webhooks = createWebhookService({
      accountService: {} as never,
      accounts: createBillingAccountRepository(r.prisma),
      topUps: [],
      billingAddress: r.service,
      logger: { log: (o: unknown) => void logged.push(o as Record<string, unknown>), warn: () => {}, error: () => {} },
    });
    const deliver = () => webhooks.handle({ id: "ev_c", event_type: "customer_changed", content: { customer: { id: TENANT } } });
    return { deliver, logged };
  }

  it("for an org that confirmed an address: the same sync — the country follows Chargebee's, and a switch is asked for, not run", async () => {
    const r = syncing();
    const { deliver } = changed(r);

    await deliver();

    expect(r.account().billingCountry).toBe("US");
    expect(r.currencySwitch.request).toHaveBeenCalledWith(TENANT, "USD");
    // Chargebee waits on the answer: the worker runs the switch.
    expect(r.currencySwitch.advance).not.toHaveBeenCalled();
  });

  it("for an org that has confirmed none: nothing is read or kept — an address a hosted page wrote back is not one the org chose", async () => {
    const r = syncing({ billingCountry: null });
    const { deliver, logged } = changed(r);

    await deliver();

    expect(r.chargebee.customer).not.toHaveBeenCalled();
    expect(r.account().billingCountry).toBeNull();
    expect(logged).toContainEqual(expect.objectContaining({ metric: "billing.address.changed_unconfirmed", tenantId: TENANT }));
  });

  it("a customer that is no org's is acknowledged, not failed into Chargebee's retries", async () => {
    const r = syncing();
    const { deliver } = changed(r);
    r.prisma._accounts.get(TENANT)!.chargebeeCustomerId = "cus_by_hand";

    await expect(deliver()).resolves.toBeUndefined();
    expect(r.chargebee.customer).not.toHaveBeenCalled();
  });
});

describe("POST /api/internal/billing-address/sync", () => {
  async function post(body: unknown) {
    const { POST } = await import("@/app/api/internal/billing-address/sync/route");
    const res = await POST(
      new Request("http://billing.test/api/internal/billing-address/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  beforeEach(async () => {
    process.env.CHARGEBEE_SITE = "test-site";
    process.env.CHARGEBEE_API_KEY = "test_key";
    process.env.CLICKHOUSE_PASSWORD = "pw";
    process.env.FREE_PLAN_ITEM_PRICE_ID_USD = "free-usd";
    process.env.FREE_PLAN_ITEM_PRICE_ID_INR = "free-inr";
    (await import("@/config/config")).resetConfig();
    held.prisma = makeFakePrisma({
      chargebeeCustomerId: TENANT,
      chargebeeSubscriptionId: "sub_1",
      chargebeeItemPriceId: "free-inr",
      status: "active",
      billingCountry: null,
      currency: "INR",
    } as never);
    held.chargebee = {
      customer: vi.fn(async () => customerIn("IN")),
      subscription: vi.fn(async () => FREE_INR),
    };
    // The service logs every sync; nothing here is about the log.
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("keeps the country of the address the tenant's customer holds in Chargebee, and answers what it did", async () => {
    const res = await post({ tenantId: TENANT });

    expect(res).toEqual({ status: 200, body: kept("IN", "INR") });
    expect(held.chargebee.customer).toHaveBeenCalledWith(TENANT);
    expect(held.prisma._accounts.get(TENANT)!.billingCountry).toBe("IN");
  });

  it("takes nothing from the body but the tenant: an address sent along is not the address", async () => {
    const res = await post({ tenantId: TENANT, country: "US", line1: "1 Main St" });

    expect(res.body).toMatchObject({ billingCountry: "IN", currency: "INR" });
  });

  it("an address with no country is a 200 that says so — the org closed the editor without one", async () => {
    held.chargebee.customer = vi.fn(async () => customerIn(undefined));

    expect(await post({ tenantId: TENANT })).toEqual({
      status: 200,
      body: { synced: false, reason: "no-country", billingCountry: null, currency: "INR", currencySwitch: null, currencyLocked: false, waitingOn: null },
    });
  });

  it("refuses a body with no tenant before anything is asked of anyone", async () => {
    expect(await post({})).toEqual({ status: 400, body: { error: "tenantId is required" } });
    expect(held.chargebee.customer).not.toHaveBeenCalled();
  });

  it("Chargebee unreachable is the route's 502 billing-address-sync-failed — and nothing was kept", async () => {
    held.chargebee.customer = vi.fn(async () => Promise.reject(Object.assign(new Error("timeout"), { retryable: true })));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await post({ tenantId: TENANT })).toEqual({
      status: 502,
      body: { error: "Could not sync the billing address", code: "billing-address-sync-failed" },
    });
    expect(held.prisma._accounts.get(TENANT)!.billingCountry).toBeNull();
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ metric: "billing.address.sync_failed", tenantId: TENANT }), expect.any(String));
    logged.mockRestore();
  });

  it("the address-writing route is gone: billing never writes the address (A29)", async () => {
    await expect(import("@/app/api/internal/billing-address/route" as string)).rejects.toThrow();
  });

  it("POST /api/internal/portal makes a tenant with no customer one, so Chargebee's billing-address editor opens before any subscription", async () => {
    process.env.CHARGEBEE_PORTAL_ENABLED = "true";
    (await import("@/config/config")).resetConfig();
    held.prisma._accounts.get(TENANT)!.chargebeeCustomerId = null;
    held.chargebee = {
      createCustomer: vi.fn(async ({ id }: { id: string }) => ({ id })),
      portalSession: vi.fn(async () => ({ id: "ps_1", token: "tok_1" })),
    };
    try {
      const { POST } = await import("@/app/api/internal/portal/route");
      const res = await POST(
        new Request("http://billing.test/api/internal/portal", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantId: TENANT }),
        }),
      );

      expect([res.status, await res.json()]).toEqual([200, { portalSession: { id: "ps_1", token: "tok_1" } }]);
      expect(held.chargebee.createCustomer).toHaveBeenCalledWith(expect.objectContaining({ id: TENANT }));
      expect(held.chargebee.portalSession).toHaveBeenCalledWith(expect.objectContaining({ customerId: TENANT }));
      expect(held.prisma._accounts.get(TENANT)!.chargebeeCustomerId).toBe(TENANT);
    } finally {
      delete process.env.CHARGEBEE_PORTAL_ENABLED;
    }
  });

  it("a customer_changed delivery syncs the country through the webhook route, for an org that confirmed one", async () => {
    process.env.CHARGEBEE_WEBHOOK_USER = "chargebee";
    process.env.CHARGEBEE_WEBHOOK_PASSWORD = "s3cret";
    process.env.BILLING_CURRENCY_SWITCH_ENABLED = "true";
    (await import("@/config/config")).resetConfig();
    held.prisma._accounts.get(TENANT)!.billingCountry = "IN";
    held.chargebee.customer = vi.fn(async () => customerIn("US"));
    // The webhook asks for the switch and leaves running it to the worker (inline: false).
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { POST } = await import("@/app/api/webhooks/chargebee/route");
      const res = await POST(
        new Request("http://billing.test/api/webhooks/chargebee", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from("chargebee:s3cret").toString("base64")}` },
          body: JSON.stringify({ id: "ev_cc", event_type: "customer_changed", content: { customer: { id: TENANT } } }),
        }),
      );

      expect(res.status).toBe(200);
      expect(held.prisma._accounts.get(TENANT)!.billingCountry).toBe("US");
      expect([...held.prisma._switches.values()]).toEqual([expect.objectContaining({ status: "REQUESTED", toCurrency: "USD" })]);
      expect(warned).not.toHaveBeenCalledWith(expect.objectContaining({ metric: "billing.currency_switch.not_wired" }), expect.any(String));
    } finally {
      logged.mockRestore();
      delete process.env.CHARGEBEE_WEBHOOK_USER;
      delete process.env.CHARGEBEE_WEBHOOK_PASSWORD;
      delete process.env.BILLING_CURRENCY_SWITCH_ENABLED;
      warned.mockRestore();
    }
  });
});
