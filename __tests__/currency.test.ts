/**
 * The currency rule and the billing address, as pure models.
 *
 * models/currency.ts says which currency an org is billed in — India in INR,
 * everywhere else and "no address yet" in USD — and what billing sells in
 * each. models/billing-address.ts validates the address an org confirms
 * before anything is written to Chargebee or here, naming the field it
 * refuses.
 */

import { describe, expect, it } from "vitest";

import { ACCOUNT } from "@/models/account-status";
import { BILLING_ADDRESS_LIMITS, parseBillingAddress } from "@/models/billing-address";
import {
  currenciesOf,
  currencyCatalog,
  currencyForCountry,
  currencyOfFreePlan,
  freeItemPriceIds,
  normaliseCountry,
  normaliseCurrency,
  settingsFor,
  topUpItemPriceIds,
  topUpsOf,
  type CurrencyRules,
} from "@/models/currency";
import { AppError } from "@/shared/errors";

const RULES: CurrencyRules = { defaultCurrency: "USD", byCountry: { IN: "INR" } };

const topUp = (itemPriceId: string, credits = "") => ({ itemPriceId, presetAmounts: [50, 100], minAmount: null, maxAmount: null, credits });

describe("the currency rule", () => {
  it.each([
    ["IN", "INR"],
    [" in ", "INR"],
    ["US", "USD"],
    ["DE", "USD"],
    [null, "USD"],
    [undefined, "USD"],
    ["IND", "USD"],
    ["", "USD"],
  ])("bills %s in %s — no address, or none that is a country, is the default", (country, currency) => {
    expect(currencyForCountry(country, RULES)).toBe(currency);
  });

  it.each([
    [" in ", "IN"],
    ["Gb", "GB"],
    ["IND", null],
    ["I1", null],
    ["", null],
    [42, null],
    [null, null],
  ])("normalises country %o to %o", (raw, code) => {
    expect(normaliseCountry(raw)).toBe(code);
  });

  it.each([
    [" inr ", "INR"],
    ["USD", "USD"],
    ["US", null],
    ["EURO", null],
    [undefined, null],
  ])("normalises currency %o to %o", (raw, code) => {
    expect(normaliseCurrency(raw)).toBe(code);
  });

  it("lists every currency it bills in: the default first, each mapped one once, in mapping order", () => {
    expect(currenciesOf({ defaultCurrency: "USD", byCountry: { IN: "INR", NP: "INR", GB: "GBP", US: "USD" } })).toEqual([
      "USD",
      "INR",
      "GBP",
    ]);
  });
});

describe("the currency catalog", () => {
  const catalog = currencyCatalog(RULES, {
    USD: { freeItemPriceId: "free-usd", topUp: topUp("api_token-USD", "50") },
    INR: { freeItemPriceId: "free-inr", topUp: topUp("api_token-INR") },
  });

  it("has an entry for every currency, with nulls for what is not configured", () => {
    const bare = currencyCatalog(RULES, { INR: { freeItemPriceId: "free-inr", topUp: null } });

    expect(bare.currencies).toEqual(["USD", "INR"]);
    expect(bare.settings).toEqual({
      USD: { currency: "USD", freeItemPriceId: null, topUp: null },
      INR: { currency: "INR", freeItemPriceId: "free-inr", topUp: null },
    });
  });

  it("refuses settings for a currency the rules never bill in", () => {
    expect(() => currencyCatalog(RULES, { EUR: { freeItemPriceId: "free-eur", topUp: null } })).toThrow(/Settings for EUR/);
  });

  it("answers a currency it does not know with settings that sell nothing", () => {
    expect(settingsFor(catalog, "EUR")).toEqual({ currency: "EUR", freeItemPriceId: null, topUp: null });
    expect(settingsFor(catalog, "INR").topUp?.itemPriceId).toBe("api_token-INR");
  });

  it("lists every currency's free plans and top-ups, the default currency's first", () => {
    expect(freeItemPriceIds(catalog)).toEqual(["free-usd", "free-inr"]);
    expect(topUpItemPriceIds(catalog)).toEqual(["api_token-USD", "api_token-INR"]);
    expect(topUpsOf(catalog).map((t) => [t.currency, t.itemPriceId, t.credits])).toEqual([
      ["USD", "api_token-USD", "50"],
      ["INR", "api_token-INR", ""],
    ]);
  });

  it("says whose free plan an item price is", () => {
    expect(currencyOfFreePlan(catalog, "free-inr")).toBe("INR");
    expect(currencyOfFreePlan(catalog, "free-usd")).toBe("USD");
    expect(currencyOfFreePlan(catalog, "paid-monthly")).toBeNull();
    expect(currencyOfFreePlan(catalog, null)).toBeNull();
  });
});

describe("the account status", () => {
  it("has `switching`, for an account whose credits are moving to a subscription in another currency", () => {
    expect(ACCOUNT.SWITCHING).toBe("switching");
  });
});

describe("parseBillingAddress", () => {
  const MINIMAL = { country: "IN", line1: "12 MG Road", city: "Bengaluru" };

  function refused(body: Record<string, unknown>): AppError {
    let caught: unknown = null;
    try {
      parseBillingAddress(body);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect([err.kind, err.code]).toEqual(["invalid", "billing-address-invalid"]);
    return err;
  }

  it("reads an address: strings trimmed, the country upper-cased, blank optional fields left out, other keys ignored", () => {
    expect(
      parseBillingAddress({
        tenantId: "11111111-1111-4111-8111-111111111111",
        country: " in ",
        line1: "  12 MG Road ",
        city: "Bengaluru",
        line2: "   ",
        state: "Karnataka",
        stateCode: "KA",
        zip: "560001",
        firstName: "Asha",
        lastName: null,
        company: "Acme",
        somethingElse: "ignored",
      }),
    ).toEqual({
      country: "IN",
      line1: "12 MG Road",
      city: "Bengaluru",
      state: "Karnataka",
      stateCode: "KA",
      zip: "560001",
      firstName: "Asha",
      company: "Acme",
    });
  });

  it("needs only a country, a first line and a city", () => {
    expect(parseBillingAddress(MINIMAL)).toEqual(MINIMAL);
  });

  it.each([
    [{ line1: "1 Main St", city: "Austin" }, "country is required"],
    [{ ...MINIMAL, country: "" }, "country is required"],
    [{ ...MINIMAL, country: "IND" }, "country must be a two-letter ISO 3166-1 country code, such as IN or US"],
    [{ ...MINIMAL, country: 91 }, "country must be a two-letter ISO 3166-1 country code, such as IN or US"],
    [{ country: "IN", city: "Bengaluru" }, "line1 is required"],
    [{ ...MINIMAL, line1: "   " }, "line1 is required"],
    [{ country: "IN", line1: "12 MG Road" }, "city is required"],
    [{ ...MINIMAL, zip: 560001 }, "zip must be text"],
    [{ ...MINIMAL, company: "x".repeat(251) }, "company must be at most 250 characters"],
    [{ ...MINIMAL, city: "x".repeat(51) }, "city must be at most 50 characters"],
  ])("refuses %o: %s", (body, message) => {
    expect(refused(body as Record<string, unknown>).message).toBe(message);
  });

  it("takes every field at exactly its limit — Chargebee's own", () => {
    const atLimit = Object.fromEntries(Object.entries(BILLING_ADDRESS_LIMITS).map(([field, limit]) => [field, "x".repeat(limit)]));
    expect(parseBillingAddress({ country: "US", ...atLimit })).toEqual({ country: "US", ...atLimit });
  });
});

describe("isFreeSubscriptionRecord: free is read off the live subscription", () => {
  // The shape Chargebee returns for the free plans on the test site.
  const FREE = {
    id: "sub_free",
    status: "active",
    currency_code: "USD",
    mrr: 0,
    has_scheduled_changes: false,
    due_invoices_count: 0,
    subscription_items: [{ item_price_id: "pre-paid-test-v1-USD-Yearly", item_type: "plan", quantity: 1, unit_price: 0, amount: 0 }],
  };

  it("is free: one plan item of amount 0, no mrr, nothing scheduled, nothing due", async () => {
    const { isFreeSubscriptionRecord } = await import("@/models/subscription");
    expect(isFreeSubscriptionRecord(FREE)).toBe(true);
    expect(isFreeSubscriptionRecord({ ...FREE, mrr: undefined })).toBe(true); // mrr is checked only when given
  });

  it.each([
    ["a paid addon beside the ₹0 plan", { subscription_items: [...FREE.subscription_items, { item_price_id: "token-overage-INR", item_type: "addon", amount: 500 }] }],
    ["a priced plan", { subscription_items: [{ ...FREE.subscription_items[0], amount: 99900 }] }],
    ["a plan with no amount said", { subscription_items: [{ item_price_id: "x", item_type: "plan" }] }],
    ["a charge, not a plan", { subscription_items: [{ ...FREE.subscription_items[0], item_type: "charge" }] }],
    ["recurring revenue", { mrr: 1200 }],
    ["a change scheduled", { has_scheduled_changes: true }],
    ["an invoice due", { due_invoices_count: 1 }],
    ["no items at all", { subscription_items: [] }],
  ])("is paid with %s — and keeps its currency", async (_label, over) => {
    const { isFreeSubscriptionRecord } = await import("@/models/subscription");
    expect(isFreeSubscriptionRecord({ ...FREE, ...over })).toBe(false);
  });

  it("is not free when there is no record", async () => {
    const { isFreeSubscriptionRecord } = await import("@/models/subscription");
    expect(isFreeSubscriptionRecord(null)).toBe(false);
  });
});
