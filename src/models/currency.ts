/**
 * Which currency an org is billed in, and what billing sells in each one.
 *
 * THE RULE. The org's billing address decides: a country mapped in
 * BILLING_COUNTRY_CURRENCIES (`IN:INR`) is billed in its currency, and every
 * other country — and an org that has not given an address yet — in
 * BILLING_DEFAULT_CURRENCY (USD). Stated here once, as data, because three
 * things must agree on it: the subscription an org is put on, the top-up it is
 * offered, and the warning the page shows before an address change moves the
 * org to another currency (the page is sent these rules; it never hard-codes
 * them).
 *
 * WHY PER CURRENCY. Chargebee fixes a subscription's currency for good, and
 * refuses a charge in any other (MEASURED: `currency_mismatched`). So every
 * item price billing sells — the free plan, the top-up — exists once per
 * currency, under its own id, with its own amounts. What does NOT vary is the
 * credit: a credit is a credit whatever the money that bought it, and the
 * LiteLLM cap is in USD of spend either way.
 *
 * Pure: no configuration is read here. config.ts parses the environment into
 * these shapes, and the container builds the catalog from it.
 */

/** ISO 3166-1 alpha-2, upper case: `IN`, `US`. */
const COUNTRY_CODE = /^[A-Z]{2}$/;

/** ISO 4217, upper case: `INR`, `USD`. */
const CURRENCY_CODE = /^[A-Z]{3}$/;

export interface CurrencyRules {
  /** The currency of every country not mapped below, and of an org with no billing address yet. */
  defaultCurrency: string;
  /** Billing country (ISO 3166-1 alpha-2) → the currency it is billed in: `{ IN: "INR" }`. */
  byCountry: Record<string, string>;
}

/**
 * A country code as the rest of billing stores and compares it — trimmed and
 * upper case — or null when it is not two letters. ` in ` is `IN`; `IND`,
 * `I1` and an empty string are not countries.
 */
export function normaliseCountry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return COUNTRY_CODE.test(code) ? code : null;
}

/** A currency code, trimmed and upper case, or null when it is not three letters. */
export function normaliseCurrency(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return CURRENCY_CODE.test(code) ? code : null;
}

/**
 * The currency a billing country is billed in. No country yet, or one that is
 * not a country at all, is the default: an org is billed in the default
 * currency until it confirms an address that maps elsewhere.
 */
export function currencyForCountry(country: string | null | undefined, rules: CurrencyRules): string {
  const code = normaliseCountry(country);
  return (code != null ? rules.byCountry[code] : undefined) ?? rules.defaultCurrency;
}

/**
 * Every currency the rules can bill in: the default FIRST, then each mapped
 * currency once, in the order the mapping names them. The order is what
 * config.ts reads per-currency settings in, so its errors come out in the
 * order an operator wrote the mapping.
 */
export function currenciesOf(rules: CurrencyRules): string[] {
  return [...new Set([rules.defaultCurrency, ...Object.values(rules.byCountry)])];
}

/**
 * One currency's top-up: an ITEM PRICE in that currency (`api_token-USD`), the
 * one-click amounts and limits in that currency's MAJOR unit, and — for a pack
 * billing allocates itself — the credits one unit grants. Shaped so it is
 * also a plan-catalog `TopUpSettings`: describeTopUp takes it as it is.
 */
export interface TopUpSettingsForCurrency {
  itemPriceId: string;
  presetAmounts: number[];
  minAmount: number | null;
  maxAmount: number | null;
  /**
   * TOPUP_CREDITS_<CUR>: credits ONE unit grants, read only when billing
   * allocates the pack (its charge carries no Credit Grant). "" when unset.
   */
  credits: string;
  /**
   * TOPUP_CHARGEBEE_GRANTS_<CUR> (else TOPUP_CHARGEBEE_GRANTS): this
   * currency's charge carries its own Credit Grant, so Chargebee grants each
   * paid pack and billing only records it. Per currency because each charge is
   * its own catalogue entry — and the USD one's grant is not measured. Absent
   * (a test's catalog): the service's own setting decides.
   */
  chargebeeGrants?: boolean;
}

/** What billing sells in one currency. Null means "not sold in it". */
export interface CurrencySettings {
  currency: string;
  /** The card-free plan an org billed in this currency is put on (FREE_PLAN_ITEM_PRICE_ID_<CUR>). */
  freeItemPriceId: string | null;
  topUp: TopUpSettingsForCurrency | null;
}

/** The rules, and every billable currency's settings. Built once per request by the container. */
export interface CurrencyCatalog {
  rules: CurrencyRules;
  settings: Record<string, CurrencySettings>;
  /** The default first — see currenciesOf. */
  currencies: string[];
}

/**
 * Build the catalog. Every currency the rules can bill in gets an entry, with
 * nulls for whatever is not configured; settings for a currency the rules
 * never bill in is a mistake in the caller, refused rather than dropped.
 */
export function currencyCatalog(
  rules: CurrencyRules,
  configured: Record<string, { freeItemPriceId: string | null; topUp: TopUpSettingsForCurrency | null }>,
): CurrencyCatalog {
  const currencies = currenciesOf(rules);
  const unknown = Object.keys(configured).filter((currency) => !currencies.includes(currency));
  if (unknown.length > 0) {
    throw new Error(
      `Settings for ${unknown.join(", ")}, which no rule bills in (the default is ${rules.defaultCurrency}; mapped: ${
        currencies.slice(1).join(", ") || "none"
      })`,
    );
  }
  const settings: Record<string, CurrencySettings> = {};
  for (const currency of currencies) {
    settings[currency] = {
      currency,
      freeItemPriceId: configured[currency]?.freeItemPriceId ?? null,
      topUp: configured[currency]?.topUp ?? null,
    };
  }
  return { rules, settings, currencies };
}

/**
 * What billing sells in `currency`. A currency the catalog does not know — a
 * subscription someone made by hand in EUR — sells nothing: the same shape,
 * with nulls, so a caller asks one question ("is there a top-up?") whatever
 * the currency.
 */
export function settingsFor(catalog: CurrencyCatalog, currency: string): CurrencySettings {
  return catalog.settings[currency] ?? { currency, freeItemPriceId: null, topUp: null };
}

/** Every currency's free plan. An org on ANY of them is on "the free plan". */
export function freeItemPriceIds(catalog: CurrencyCatalog): string[] {
  return catalog.currencies.map((c) => settingsFor(catalog, c).freeItemPriceId).filter((id): id is string => id != null);
}

/**
 * Every currency's top-up item price. What looks for packs — paid, unpaid or
 * held back — looks at all of them: a pack bought in INR is still owed, or
 * still to be recorded, after the org has moved to USD.
 */
export function topUpItemPriceIds(catalog: CurrencyCatalog): string[] {
  return topUpsOf(catalog).map((topUp) => topUp.itemPriceId);
}

/** Every currency's top-up, with the currency it is sold in. The default currency's first. */
export function topUpsOf(catalog: CurrencyCatalog): Array<TopUpSettingsForCurrency & { currency: string }> {
  return catalog.currencies.flatMap((currency) => {
    const topUp = settingsFor(catalog, currency).topUp;
    return topUp ? [{ ...topUp, currency }] : [];
  });
}

/** The currency whose free plan this item price is; null when it is no currency's free plan. */
export function currencyOfFreePlan(catalog: CurrencyCatalog, itemPriceId: string | null | undefined): string | null {
  if (!itemPriceId) return null;
  return catalog.currencies.find((currency) => settingsFor(catalog, currency).freeItemPriceId === itemPriceId) ?? null;
}
