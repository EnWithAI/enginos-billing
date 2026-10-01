/**
 * The billing currency's configuration: the rule that turns a billing country
 * into a currency, and what billing sells in each currency.
 *
 * Chargebee fixes a subscription's currency and refuses a charge in any other,
 * so the free plan and the top-up are set once PER CURRENCY
 * (`FREE_PLAN_ITEM_PRICE_ID_USD`, `_INR` …). What is pinned here: the defaults
 * a process gets with nothing set (vitest loads no .env, and every other
 * getConfig() test relies on them), that a feature is set for every currency
 * or for none, and that the old single-currency names stop the process at
 * start — naming what to set instead — rather than quietly running with no
 * free plan and no top-up.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig, resetConfig } from "@/config/config";

const PER_CURRENCY = [
  "FREE_PLAN_ITEM_PRICE_ID",
  "TOPUP_ITEM_PRICE_ID",
  "TOPUP_AMOUNTS",
  "TOPUP_MIN_AMOUNT",
  "TOPUP_MAX_AMOUNT",
  "TOPUP_CREDITS",
];
const KEYS = [
  "CHARGEBEE_SITE",
  "CHARGEBEE_API_KEY",
  "CLICKHOUSE_PASSWORD",
  "BILLING_DEFAULT_CURRENCY",
  "BILLING_COUNTRY_CURRENCIES",
  "BILLING_SWITCH_INLINE_MS",
  "ITEM_PRICE_IDS",
  "DEFAULT_ITEM_PRICE_ID",
  "TOPUP_CHARGEBEE_GRANTS",
  "BILLING_CURRENCY_SWITCH_ENABLED",
  ...PER_CURRENCY,
  ...[...PER_CURRENCY, "TOPUP_CHARGEBEE_GRANTS"].flatMap((name) => ["USD", "INR", "GBP", "EUR"].map((currency) => `${name}_${currency}`)),
];

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.CHARGEBEE_SITE = "site-test";
  process.env.CHARGEBEE_API_KEY = "test_key_123";
  process.env.CLICKHOUSE_PASSWORD = "pw";
  resetConfig();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfig();
});

const set = (env: Record<string, string>) => Object.assign(process.env, env);

/** Both currencies' free plans and top-ups, as the test site has them. */
const BOTH = {
  FREE_PLAN_ITEM_PRICE_ID_USD: "pre-paid-test-v1-USD-Yearly",
  FREE_PLAN_ITEM_PRICE_ID_INR: "pre-paid-test-v1-INR-Yearly",
  TOPUP_ITEM_PRICE_ID_USD: "api_token-USD",
  TOPUP_ITEM_PRICE_ID_INR: "api_token-INR",
};

describe("with nothing set — what every test, and a bare process, gets", () => {
  it("bills India in INR and everyone else in USD, sells nothing, and keeps no single-currency field", () => {
    const config = getConfig();

    expect(config.currencyRules).toEqual({ defaultCurrency: "USD", byCountry: { IN: "INR" } });
    expect(config.currencies).toEqual(["USD", "INR"]);
    expect(config.billing).toEqual({
      USD: { freeItemPriceId: null, topUp: null },
      INR: { freeItemPriceId: null, topUp: null },
    });
    expect(config.itemPriceIds).toEqual([]);
    expect(config.switchInlineMs).toBe(6000);
    expect(config.currencySwitchEnabled).toBe(false);
    for (const gone of ["freeItemPriceId", "topUpItemPriceId", "topUpCredits", "topUpAmounts", "topUpMinAmount", "topUpMaxAmount"]) {
      expect(config).not.toHaveProperty(gone);
    }
  });
});

describe("per-currency settings", () => {
  it("reads each currency's free plan and top-up, with its own amounts, limits and credits", () => {
    set({
      ...BOTH,
      TOPUP_AMOUNTS_USD: " 5, 10 ",
      TOPUP_MIN_AMOUNT_INR: "50",
      TOPUP_MAX_AMOUNT_INR: "10000",
      TOPUP_CREDITS_USD: " 50 ",
    });

    expect(getConfig().billing).toEqual({
      USD: {
        freeItemPriceId: "pre-paid-test-v1-USD-Yearly",
        topUp: { itemPriceId: "api_token-USD", presetAmounts: [5, 10], minAmount: null, maxAmount: null, credits: "50", chargebeeGrants: false },
      },
      INR: {
        freeItemPriceId: "pre-paid-test-v1-INR-Yearly",
        // Unset amounts are 50,100, as TOPUP_AMOUNTS always defaulted to.
        topUp: { itemPriceId: "api_token-INR", presetAmounts: [50, 100], minAmount: 50, maxAmount: 10000, credits: "", chargebeeGrants: false },
      },
    });
  });

  it("says per currency whether Chargebee grants the pack, else what TOPUP_CHARGEBEE_GRANTS says", () => {
    // The INR pack's grant is MEASURED; the USD one's is not, so it is set apart.
    set({ ...BOTH, TOPUP_CHARGEBEE_GRANTS: "true", TOPUP_CHARGEBEE_GRANTS_USD: "false", TOPUP_CREDITS_USD: "50" });

    expect(getConfig().billing.USD?.topUp).toMatchObject({ chargebeeGrants: false, credits: "50" });
    expect(getConfig().billing.INR?.topUp).toMatchObject({ chargebeeGrants: true });
    expect(getConfig().topUpChargebeeGrants).toBe(true);
  });

  it.each(["yes", "TRUE", "1"])("refuses a per-currency grant mode of %s — it decides who grants a paid pack", (value) => {
    set({ TOPUP_CHARGEBEE_GRANTS_INR: value });
    expect(() => getConfig()).toThrow(`TOPUP_CHARGEBEE_GRANTS_INR must be true or false, got "${value}"`);
  });

  it("puts every currency's free plan on the plan allowlist, after ITEM_PRICE_IDS and only once", () => {
    set({ ...BOTH, ITEM_PRICE_IDS: "pre-paid-test-v1-INR-Monthly, pre-paid-test-v1-INR-Yearly" });

    expect(getConfig().itemPriceIds).toEqual([
      "pre-paid-test-v1-INR-Monthly",
      "pre-paid-test-v1-INR-Yearly",
      "pre-paid-test-v1-USD-Yearly",
    ]);
  });

  it("turns the free plan or the top-up off by leaving it unset for EVERY currency", () => {
    set({ TOPUP_ITEM_PRICE_ID_USD: "api_token-USD", TOPUP_ITEM_PRICE_ID_INR: "api_token-INR" });

    expect(getConfig().billing.USD).toMatchObject({ freeItemPriceId: null, topUp: { itemPriceId: "api_token-USD" } });
    expect(getConfig().billing.INR).toMatchObject({ freeItemPriceId: null, topUp: { itemPriceId: "api_token-INR" } });
  });

  it.each([
    ["FREE_PLAN_ITEM_PRICE_ID", "free plan"],
    ["TOPUP_ITEM_PRICE_ID", "top-up"],
  ])("refuses %s for some currencies but not all, naming the one missing", (name, what) => {
    set({ [`${name}_USD`]: "only-usd" });

    expect(() => getConfig()).toThrow(
      new RegExp(`${name}_INR is not set, but ${name}_USD is: every billing currency \\(USD, INR\\) needs its own ${what}`),
    );
  });

  it("refuses a per-currency minimum above its maximum, naming the currency", () => {
    set({ TOPUP_MIN_AMOUNT_INR: "100", TOPUP_MAX_AMOUNT_INR: "50" });
    expect(() => getConfig()).toThrow("TOPUP_MIN_AMOUNT_INR (100) is larger than TOPUP_MAX_AMOUNT_INR (50)");
  });

  it.each([
    [{ TOPUP_AMOUNTS_USD: "5,abc" }, /TOPUP_AMOUNTS_USD must list amounts greater than zero/],
    [{ TOPUP_MAX_AMOUNT_USD: "-5" }, /TOPUP_MAX_AMOUNT_USD must be an amount greater than zero/],
    [{ TOPUP_CREDITS_INR: "0" }, /TOPUP_CREDITS_INR must be a number greater than zero/],
  ])("checks every per-currency value at start, top-ups on or not: %o", (env, message) => {
    set(env);
    expect(() => getConfig()).toThrow(message);
  });
});

describe("the single-currency names", () => {
  it.each(PER_CURRENCY)("%s set is refused at start, naming the per-currency variables to use instead", (name) => {
    set({ [name]: name === "TOPUP_AMOUNTS" ? "50,100" : name.endsWith("AMOUNT") || name === "TOPUP_CREDITS" ? "50" : "some-id" });

    expect(() => getConfig()).toThrow(`Replace ${name} with ${name}_USD and ${name}_INR`);
    expect(() => getConfig()).toThrow(/no longer read: plans and top-ups are set per billing currency \(USD, INR/);
  });

  it("names every one that is set, in one message", () => {
    set({ FREE_PLAN_ITEM_PRICE_ID: "pre-paid-test-v1-INR-Yearly", TOPUP_ITEM_PRICE_ID: "api_token-INR", TOPUP_AMOUNTS: "50,100" });

    expect(() => getConfig()).toThrow(/^FREE_PLAN_ITEM_PRICE_ID, TOPUP_ITEM_PRICE_ID, TOPUP_AMOUNTS are no longer read/);
  });

  it("names the replacements for the currencies actually configured", () => {
    set({ BILLING_COUNTRY_CURRENCIES: "IN:INR,GB:GBP", TOPUP_ITEM_PRICE_ID: "api_token-INR" });

    expect(() => getConfig()).toThrow(
      "Replace TOPUP_ITEM_PRICE_ID with TOPUP_ITEM_PRICE_ID_USD and TOPUP_ITEM_PRICE_ID_INR and TOPUP_ITEM_PRICE_ID_GBP",
    );
  });

  it("is refused even beside the new names — a stale line left in .env is still a mistake", () => {
    set({ ...BOTH, TOPUP_ITEM_PRICE_ID: "api_token-INR" });
    expect(() => getConfig()).toThrow(/TOPUP_ITEM_PRICE_ID is no longer read/);
  });

  it("an empty one is unset, not refused — .env.example's blank lines stay harmless", () => {
    set({ FREE_PLAN_ITEM_PRICE_ID: "", TOPUP_MIN_AMOUNT: "  " });
    expect(() => getConfig()).not.toThrow();
  });
});

describe("BILLING_COUNTRY_CURRENCIES and BILLING_DEFAULT_CURRENCY", () => {
  it("parses country:currency pairs, trimmed and upper-cased, default currency first", () => {
    set({ BILLING_COUNTRY_CURRENCIES: " in:inr , GB:GBP,", BILLING_DEFAULT_CURRENCY: "usd" });

    expect(getConfig().currencyRules).toEqual({ defaultCurrency: "USD", byCountry: { IN: "INR", GB: "GBP" } });
    expect(getConfig().currencies).toEqual(["USD", "INR", "GBP"]);
  });

  it("is IN:INR when set empty, as when unset — a blank line must not quietly bill India in USD", () => {
    set({ BILLING_COUNTRY_CURRENCIES: "" });
    expect(getConfig().currencyRules.byCountry).toEqual({ IN: "INR" });
  });

  it("lists a currency once however many countries map to it, and the default not again", () => {
    set({ BILLING_COUNTRY_CURRENCIES: "IN:INR,NP:INR,US:USD" });

    expect(getConfig().currencies).toEqual(["USD", "INR"]);
  });

  it("reads the per-currency settings of every currency it names", () => {
    set({ BILLING_DEFAULT_CURRENCY: "EUR", BILLING_COUNTRY_CURRENCIES: "IN:INR", FREE_PLAN_ITEM_PRICE_ID_EUR: "free-eur", FREE_PLAN_ITEM_PRICE_ID_INR: "free-inr" });

    expect(getConfig().currencies).toEqual(["EUR", "INR"]);
    expect(getConfig().billing.EUR?.freeItemPriceId).toBe("free-eur");
    expect(getConfig().itemPriceIds).toEqual(["free-eur", "free-inr"]);
  });

  it.each(["IND:INR", "IN-INR", "IN:RUPEE", "IN:INR:X", "IN", ":INR"])("refuses %s, saying what a pair is", (value) => {
    set({ BILLING_COUNTRY_CURRENCIES: value });
    expect(() => getConfig()).toThrow(/BILLING_COUNTRY_CURRENCIES must be COUNTRY:CURRENCY pairs/);
  });

  it("refuses a country mapped twice", () => {
    set({ BILLING_COUNTRY_CURRENCIES: "IN:INR,in:usd" });
    expect(() => getConfig()).toThrow("BILLING_COUNTRY_CURRENCIES names IN twice (INR and USD)");
  });

  it.each(["EURO", "E1", "$"])("refuses a default currency of %s", (value) => {
    set({ BILLING_DEFAULT_CURRENCY: value });
    expect(() => getConfig()).toThrow(/BILLING_DEFAULT_CURRENCY must be a three-letter ISO 4217 currency code/);
  });
});

describe("BILLING_CURRENCY_SWITCH_ENABLED — the rollout gate", () => {
  it("is off unless exactly `true`", () => {
    for (const value of ["", "false", "TRUE", "1", "yes"]) {
      resetConfig();
      set({ BILLING_CURRENCY_SWITCH_ENABLED: value });
      expect(getConfig().currencySwitchEnabled).toBe(false);
    }
    resetConfig();
    set({ BILLING_CURRENCY_SWITCH_ENABLED: "true" });
    expect(getConfig().currencySwitchEnabled).toBe(true);
  });
});

describe("BILLING_SWITCH_INLINE_MS", () => {
  it("is read in milliseconds, and 0 runs nothing inline", () => {
    set({ BILLING_SWITCH_INLINE_MS: "2500" });
    expect(getConfig().switchInlineMs).toBe(2500);

    resetConfig();
    set({ BILLING_SWITCH_INLINE_MS: "0" });
    expect(getConfig().switchInlineMs).toBe(0);
  });

  it("refuses a negative one", () => {
    set({ BILLING_SWITCH_INLINE_MS: "-1" });
    expect(() => getConfig()).toThrow(/BILLING_SWITCH_INLINE_MS must be zero or a positive number/);
  });
});
