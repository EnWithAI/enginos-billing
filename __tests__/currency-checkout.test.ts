/**
 * Buying in the org's currency, and only in it.
 *
 *   THE FREE PLAN of the currency the org's confirmed billing country is
 *   billed in — USD with no address yet (R8) — checked against the catalogue
 *   for its price AND its currency, created under a key that names the
 *   currency, and the customer told to prefer that currency (A19).
 *
 *   A PAID CHECKOUT only once a country is confirmed, only for a plan in that
 *   country's currency (the catalogue's word, never the plan's id), and
 *   pre-filled with the confirmed address (A21).
 *
 *   A TOP-UP only in the SUBSCRIPTION'S currency (R5, R6) — the pack of that
 *   currency, never the other — refused in a fixed order before anything is
 *   charged, and charged under the account's charge lease (A13), which a
 *   currency switch cannot start under. "Pay now" collects every currency's
 *   owed packs, and may while a switch is only REQUESTED: that switch waits
 *   for exactly this.
 */

import { describe, expect, it, vi } from "vitest";

import type { ChargebeeClient } from "@/integrations/chargebee";
import { ACCOUNT } from "@/models/account-status";
import { currencyCatalog, type CurrencyRules } from "@/models/currency";
import { createBillingAccountRepository } from "@/repositories/billing-account.repository";
import { createCurrencySwitchRepository, SWITCH } from "@/repositories/currency-switch.repository";
import { createAccountService } from "@/services/account.service";
import { createCheckoutService } from "@/services/checkout.service";
import { AppError } from "@/shared/errors";

import { MINUTE, T0, TENANT, makeFakePrisma, quietLogger } from "./harness";

const RULES: CurrencyRules = { defaultCurrency: "USD", byCountry: { IN: "INR" } };
const topUp = (itemPriceId: string, credits = "") => ({ itemPriceId, presetAmounts: [50, 100], minAmount: null, maxAmount: null, credits });
/** The test site's catalogue: a free plan and a pack in each currency. */
const CATALOG = currencyCatalog(RULES, {
  USD: { freeItemPriceId: "free-usd", topUp: topUp("api_token-USD", "50") },
  INR: { freeItemPriceId: "free-inr", topUp: topUp("api_token-INR", "50") },
});
const PRICES: Record<string, { priceMinor: number; currencyCode: string }> = {
  "free-usd": { priceMinor: 0, currencyCode: "USD" },
  "free-inr": { priceMinor: 0, currencyCode: "INR" },
  "pro-inr": { priceMinor: 100_000, currencyCode: "INR" },
  "pro-usd": { priceMinor: 2_000, currencyCode: "USD" },
};
const itemPrice = async (id: string) => (PRICES[id] ? { id, name: id, period: 1, periodUnit: "month", ...PRICES[id] } : null);

async function rejection(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

describe("the free plan is the confirmed country's currency's — USD with no address yet", () => {
  function provisioning(account: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
    const prisma = makeFakePrisma({ chargebeeCustomerId: TENANT, chargebeeSubscriptionId: null, ledgerUnitId: null, status: "unlinked", ...account } as never);
    const accounts = createBillingAccountRepository(prisma);
    const chargebee = {
      activeSubscriptions: vi.fn(async () => []),
      itemPrice: vi.fn(itemPrice),
      subscribeCustomer: vi.fn(async (_args: { customerId: string; itemPriceId: string; idempotencyKey: string }) => ({ id: "sub_free" })),
      setPreferredCurrency: vi.fn(async () => ({})),
      ...over,
    };
    // The link, as syncFromChargebee makes it: the subscription's currency stored.
    const accountService = {
      ensureCustomer: vi.fn(async () => ({ tenantId: TENANT, chargebeeCustomerId: TENANT })),
      bootstrapFromTenant: vi.fn(async () => ({ tenantId: TENANT, chargebeeCustomerId: TENANT })),
      syncFromChargebee: vi.fn(async () => {
        const subscribed = chargebee.subscribeCustomer.mock.calls[0]?.[0] as { itemPriceId: string } | undefined;
        return { chargebeeSubscriptionId: "sub_free", status: "active", ledgerUnitId: "token-test", currency: subscribed ? PRICES[subscribed.itemPriceId]!.currencyCode : null };
      }),
    };
    const errors: Array<Record<string, unknown>> = [];
    const checkout = createCheckoutService({
      chargebee: chargebee as unknown as ChargebeeClient,
      accountService: accountService as never,
      accounts,
      itemPriceIds: ["free-usd", "free-inr", "pro-inr"],
      defaultItemPriceId: "pro-inr",
      catalog: CATALOG,
      freePlanDefault: true,
      logger: { ...quietLogger, error: (o: unknown) => void errors.push(o as Record<string, unknown>) },
      sleep: async () => {},
    });
    return { checkout, chargebee, errors };
  }

  it("an org with no address yet — sign-up sends none — is put on the USD free plan, under a key naming USD", async () => {
    const r = provisioning();

    expect(await r.checkout.provisionFreePlan(TENANT)).toEqual({ status: "subscribed", subscriptionId: "sub_free" });
    expect(r.chargebee.subscribeCustomer).toHaveBeenCalledWith({ customerId: TENANT, itemPriceId: "free-usd", idempotencyKey: `free-plan:${TENANT}:USD` });
    // Chargebee routes a charge by the customer's preferred currency (A19).
    expect(r.chargebee.setPreferredCurrency).toHaveBeenCalledWith(TENANT, "USD");
  });

  it("an org that confirmed an Indian address is put on the INR free plan", async () => {
    const r = provisioning({ billingCountry: "IN" });

    await r.checkout.provisionFreePlan(TENANT);

    expect(r.chargebee.subscribeCustomer).toHaveBeenCalledWith({ customerId: TENANT, itemPriceId: "free-inr", idempotencyKey: `free-plan:${TENANT}:INR` });
    expect(r.chargebee.setPreferredCurrency).toHaveBeenCalledWith(TENANT, "INR");
  });

  it("every country the mapping does not name is the default currency's", async () => {
    const r = provisioning({ billingCountry: "DE" });

    await r.checkout.provisionFreePlan(TENANT);

    expect(r.chargebee.subscribeCustomer).toHaveBeenCalledWith(expect.objectContaining({ itemPriceId: "free-usd" }));
  });

  it("refuses a free plan priced in another currency than the one it is configured for — the subscription's currency is fixed for good", async () => {
    const r = provisioning({}, { itemPrice: vi.fn(async (id: string) => ({ ...(await itemPrice(id))!, currencyCode: "INR" })) });

    const err = await rejection(r.checkout.provisionFreePlan(TENANT));

    expect([err.kind, err.code]).toEqual(["conflict", "free-plan-misconfigured"]);
    expect(r.chargebee.subscribeCustomer).not.toHaveBeenCalled();
    expect(r.errors).toContainEqual(expect.objectContaining({ metric: "billing.free_plan.wrong_currency", currency: "USD", planCurrency: "INR" }));
  });

  it("refuses one that costs money, in its own currency too", async () => {
    const r = provisioning({}, { itemPrice: vi.fn(async (id: string) => ({ ...(await itemPrice(id))!, priceMinor: 900 })) });

    expect((await rejection(r.checkout.provisionFreePlan(TENANT))).code).toBe("free-plan-misconfigured");
    expect(r.chargebee.subscribeCustomer).not.toHaveBeenCalled();
  });

  it("a preferred currency Chargebee would not set is logged, and never fails the sign-up", async () => {
    const r = provisioning({}, {
      setPreferredCurrency: vi.fn(async () => {
        throw new Error("Chargebee 503");
      }),
    });

    expect(await r.checkout.provisionFreePlan(TENANT)).toMatchObject({ status: "subscribed" });
    expect(r.errors).toContainEqual(expect.objectContaining({ metric: "billing.customer.preferred_currency_failed", currency: "USD" }));
  });
});

/** An org with its billing address confirmed, on a live subscription — and the services a purchase goes through. */
function purchasing(account: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma({
    chargebeeCustomerId: TENANT,
    chargebeeSubscriptionId: "sub_1",
    ledgerUnitId: "token-test",
    status: "active",
    billingCountry: "US",
    currency: "USD",
    ...account,
  } as never);
  const paid = (itemPriceId: string) => ({ id: "inv_1", status: "paid", totalMinor: 100, amountDueMinor: 0, currencyCode: PRICES[itemPriceId]?.currencyCode ?? null, nextRetryAt: null });
  const chargebee = {
    itemPrice: vi.fn(itemPrice),
    customer: vi.fn(async () => null),
    checkoutPage: vi.fn(async () => ({ id: "hp_1" })),
    subscription: vi.fn(async () => ({ id: "sub_1", currency_code: "USD" })),
    chargeItem: vi.fn(async ({ itemPriceId }: { itemPriceId: string }) => paid(itemPriceId)),
    collectInvoice: vi.fn(async (id: string) => ({ ...paid("api_token-USD"), id })),
    paymentSource: vi.fn(async () => ({ id: "pm_1", type: "card", status: "valid", brand: "visa", last4: "1111", expiryMonth: 12, expiryYear: 2030 })),
    unpaidInvoicesFor: vi.fn(async () => [] as unknown[]),
    paidInvoicesFor: vi.fn(async () => []),
    subscriptionIdsOf: vi.fn(async () => ["sub_1"]),
    grantBlocks: vi.fn(async () => ({ blocks: [], complete: true })),
    ...over,
  };
  const accounts = createBillingAccountRepository(prisma);
  const switches = createCurrencySwitchRepository(prisma);
  const accountService = createAccountService({ prisma, chargebee: chargebee as unknown as ChargebeeClient, usdPerCredit: "0.001", logger: quietLogger });
  const checkout = createCheckoutService({
    chargebee: chargebee as unknown as ChargebeeClient,
    accountService,
    accounts,
    itemPriceIds: ["free-usd", "free-inr", "pro-inr", "pro-usd"],
    defaultItemPriceId: "pro-inr",
    catalog: CATALOG,
    switches,
    clock: () => T0,
    logger: quietLogger,
    sleep: async () => {},
  });
  /** A switch of the org, seeded in `status` (and with whatever else it should say). */
  async function aSwitch(status: string, extra: Record<string, unknown> = {}) {
    const sw = await switches.create({ tenantId: TENANT, fromSubscriptionId: "sub_1", fromCurrency: "USD", toCurrency: "INR", toItemPriceId: "free-inr", at: new Date(T0) });
    Object.assign(prisma._switches.get(sw!.id)!, { status, ...extra });
    return sw!.id;
  }
  return { prisma, chargebee, checkout, aSwitch, account: () => prisma._accounts.get(TENANT)! };
}

describe("a paid checkout is in the confirmed country's currency", () => {
  it("is refused before a billing address is confirmed — the page asks for it first", async () => {
    const r = purchasing({ billingCountry: null, chargebeeSubscriptionId: null, status: "unlinked" });

    const err = await rejection(r.checkout.startSubscription(TENANT, "pro-inr"));

    expect([err.kind, err.code]).toEqual(["conflict", "billing-address-required"]);
    expect(r.chargebee.checkoutPage).not.toHaveBeenCalled();
  });

  it("sells a plan in that currency, pre-filled with the address the org confirmed — never the email, phone or third line", async () => {
    const r = purchasing({ billingCountry: "IN", currency: null, chargebeeSubscriptionId: null, status: "unlinked" }, {
      customer: vi.fn(async () => ({
        id: TENANT,
        billingAddress: { firstName: "Asha", lastName: null, company: "Acme", line1: "12 MG Road", line2: null, city: "Bengaluru", state: "Karnataka", stateCode: "KA", zip: "560001", country: "IN", email: "a@acme.test", phone: "+91", line3: "C" },
      })),
    });

    await r.checkout.startSubscription(TENANT, "pro-inr");

    expect(r.chargebee.checkoutPage).toHaveBeenCalledWith({
      customerId: TENANT,
      itemPriceId: "pro-inr",
      billingAddress: { firstName: "Asha", lastName: null, company: "Acme", line1: "12 MG Road", line2: null, city: "Bengaluru", state: "Karnataka", stateCode: "KA", zip: "560001", country: "IN" },
    });
  });

  it("an address Chargebee holds in another country than the confirmed one is not pre-filled — only the confirmed country is", async () => {
    const r = purchasing({ billingCountry: "IN", chargebeeSubscriptionId: null, status: "unlinked" }, {
      customer: vi.fn(async () => ({ id: TENANT, billingAddress: { country: "AF", line1: "x" } })),
    });

    await r.checkout.startSubscription(TENANT, "pro-inr");

    expect(r.chargebee.checkoutPage).toHaveBeenCalledWith(expect.objectContaining({ billingAddress: { country: "IN" } }));
  });

  it("refuses a plan in another currency — read from the catalogue — and the default plan is held to the same rule", async () => {
    const r = purchasing({ billingCountry: "US", chargebeeSubscriptionId: null, status: "unlinked" });

    const named = await rejection(r.checkout.startSubscription(TENANT, "pro-inr"));
    expect([named.kind, named.code, named.message]).toEqual(["invalid", "plan-not-offered", "That plan is not offered in USD"]);
    // None named: DEFAULT_ITEM_PRICE_ID (INR here) is not sold to a US org either.
    expect((await rejection(r.checkout.startSubscription(TENANT))).code).toBe("plan-not-offered");
    expect(r.chargebee.checkoutPage).not.toHaveBeenCalled();

    await r.checkout.startSubscription(TENANT, "pro-usd");
    expect(r.chargebee.checkoutPage).toHaveBeenCalledWith(expect.objectContaining({ itemPriceId: "pro-usd" }));
  });

  it("a plan whose currency cannot be read is not sold on a guess", async () => {
    const r = purchasing({ billingCountry: "IN", chargebeeSubscriptionId: null, status: "unlinked" }, { itemPrice: vi.fn(async () => null) });

    const err = await rejection(r.checkout.startSubscription(TENANT, "pro-inr"));
    expect([err.kind, err.code]).toEqual(["upstream", "checkout-failed"]);
  });
});

describe("a top-up is in the subscription's currency, and only its", () => {
  it("a USD subscription is sold the USD pack; an INR one the INR pack — never the other", async () => {
    const usd = purchasing();
    await usd.checkout.startTopUp(TENANT, 2);
    expect(usd.chargebee.chargeItem.mock.calls).toEqual([[{ subscriptionId: "sub_1", itemPriceId: "api_token-USD", quantity: 2 }]]);

    const inr = purchasing({ billingCountry: "IN", currency: "INR" });
    await inr.checkout.startTopUp(TENANT, 2);
    expect(inr.chargebee.chargeItem.mock.calls).toEqual([[{ subscriptionId: "sub_1", itemPriceId: "api_token-INR", quantity: 2 }]]);
  });

  it("follows the subscription, not the address: a paid INR plan with a US address still buys INR packs", async () => {
    const r = purchasing({ billingCountry: "US", currency: "INR" });

    await r.checkout.startTopUp(TENANT);

    expect(r.chargebee.chargeItem).toHaveBeenCalledWith(expect.objectContaining({ itemPriceId: "api_token-INR" }));
  });

  it("an account linked before the currency was stored reads it off the live subscription", async () => {
    const r = purchasing({ currency: null }, { subscription: vi.fn(async () => ({ id: "sub_1", currency_code: "INR" })) });

    await r.checkout.startTopUp(TENANT);

    expect(r.chargebee.chargeItem).toHaveBeenCalledWith(expect.objectContaining({ itemPriceId: "api_token-INR" }));
  });

  describe("is refused, in this order, before anything is charged", () => {
    it("1. a currency switch open — even only asked for — before anything else is asked", async () => {
      const r = purchasing({ billingCountry: null });
      await r.aSwitch(SWITCH.REQUESTED);

      const err = await rejection(r.checkout.startTopUp(TENANT, 0));

      expect([err.kind, err.code]).toEqual(["conflict", "currency-switch-in-progress"]);
      expect(r.chargebee.unpaidInvoicesFor).not.toHaveBeenCalled();
      expect(r.chargebee.chargeItem).not.toHaveBeenCalled();
    });

    it("2. no live subscription", async () => {
      expect((await rejection(purchasing({ chargebeeSubscriptionId: null, billingCountry: null }).checkout.startTopUp(TENANT))).code).toBe("no-subscription");
      expect((await rejection(purchasing({ status: "cancelled", billingCountry: null }).checkout.startTopUp(TENANT))).code).toBe("subscription-cancelled");
    });

    it("3. no billing country confirmed: no pack is sold before the address (R1)", async () => {
      const r = purchasing({ billingCountry: null });

      const err = await rejection(r.checkout.startTopUp(TENANT, 0));

      expect([err.kind, err.code]).toEqual(["conflict", "billing-address-required"]);
      expect(r.chargebee.chargeItem).not.toHaveBeenCalled();
    });

    it("4. no top-up in the subscription's currency", async () => {
      const r = purchasing({ currency: "EUR" });

      const err = await rejection(r.checkout.startTopUp(TENANT, 0));

      expect([err.kind, err.code]).toEqual(["conflict", "topup-not-offered"]);
    });

    it("5. a quantity outside the limits", async () => {
      expect((await rejection(purchasing().checkout.startTopUp(TENANT, 0))).code).toBe("topup-quantity-invalid");
    });
  });

  it("a switch whose cap has moved — only cancelling the old subscription left — blocks nothing", async () => {
    const r = purchasing();
    await r.aSwitch(SWITCH.LINKED, { movingAt: new Date(T0), linkedAt: new Date(T0), toSubscriptionId: "sub_1", toSubscriptionAt: new Date(T0), activatedAt: new Date(T0) });

    await r.checkout.startTopUp(TENANT);

    expect(r.chargebee.chargeItem).toHaveBeenCalledTimes(1);
  });
});

describe("the charge lease: a top-up and a currency switch never overlap (A13)", () => {
  it("is held while the pack is charged, and cleared after — whether it was paid or refused", async () => {
    let leaseDuringCharge: Date | null = null;
    const r = purchasing({}, {
      chargeItem: vi.fn(async () => {
        leaseDuringCharge = r.account().topupChargingUntil ?? null;
        return { id: "inv_1", status: "paid", totalMinor: 100, amountDueMinor: 0, currencyCode: "USD", nextRetryAt: null };
      }),
    });

    await r.checkout.startTopUp(TENANT);
    expect(leaseDuringCharge).toEqual(new Date(T0 + 2 * MINUTE));
    expect(r.account().topupChargingUntil).toBeNull();

    r.chargebee.unpaidInvoicesFor.mockResolvedValueOnce([{ id: "inv_owed" }]);
    expect((await rejection(r.checkout.startTopUp(TENANT))).code).toBe("topup-unpaid");
    expect(r.account().topupChargingUntil).toBeNull();
  });

  it("a second top-up while one is being charged is a 409 topup-in-progress, and charges nothing", async () => {
    const r = purchasing({ topupChargingUntil: new Date(T0 + MINUTE) });

    const err = await rejection(r.checkout.startTopUp(TENANT));

    expect([err.kind, err.code, err.message]).toEqual(["conflict", "topup-in-progress", "A top-up is already being charged"]);
    expect(r.chargebee.chargeItem).not.toHaveBeenCalled();
    expect(r.account().topupChargingUntil).toEqual(new Date(T0 + MINUTE)); // the other charge's, untouched
  });

  it("an account still being set up is not charged: 409 billing-activating", async () => {
    const r = purchasing({ status: ACCOUNT.ACTIVATING });

    expect((await rejection(r.checkout.startTopUp(TENANT))).code).toBe("billing-activating");
    expect(r.chargebee.chargeItem).not.toHaveBeenCalled();
  });
});

describe("Pay now collects what is owed in every currency", () => {
  const OWED = [{ id: "inv_inr", status: "payment_due", amountDueMinor: 5000, currencyCode: "INR", nextRetryAt: null, date: null }];

  it("looks for owed packs of every currency's top-up, and collects them under the charge lease", async () => {
    const r = purchasing({}, { unpaidInvoicesFor: vi.fn(async () => OWED) });

    expect(await r.checkout.payUnpaidTopUps(TENANT)).toMatchObject({ invoices: [{ id: "inv_inr", status: "paid" }] });
    expect(r.chargebee.unpaidInvoicesFor).toHaveBeenCalledWith(TENANT, ["api_token-USD", "api_token-INR"]);
    expect(r.account().topupChargingUntil).toBeNull();
  });

  it("is allowed while a switch is only REQUESTED — which waits for exactly this", async () => {
    const r = purchasing({}, { unpaidInvoicesFor: vi.fn(async () => OWED) });
    await r.aSwitch(SWITCH.REQUESTED);

    await r.checkout.payUnpaidTopUps(TENANT);

    expect(r.chargebee.collectInvoice).toHaveBeenCalledWith("inv_inr");
  });

  it("is refused once a switch is moving the credits", async () => {
    const r = purchasing({}, { unpaidInvoicesFor: vi.fn(async () => OWED) });
    await r.aSwitch(SWITCH.MOVING, { movingAt: new Date(T0) });

    const err = await rejection(r.checkout.payUnpaidTopUps(TENANT));

    expect([err.kind, err.code]).toEqual(["conflict", "currency-switch-in-progress"]);
    expect(r.chargebee.collectInvoice).not.toHaveBeenCalled();
  });
});
