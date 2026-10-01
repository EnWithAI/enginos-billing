/**
 * Configuration, validated once at import.
 *
 * Every value that can be wrong is checked here rather than at the first
 * capture of the month. A placeholder that reaches Chargebee comes back as
 * "Invalid api key", which gives no hint that the value was never filled in.
 */

import {
  currenciesOf,
  normaliseCountry,
  normaliseCurrency,
  type CurrencyRules,
  type TopUpSettingsForCurrency,
} from "../models/currency";
import { decimal, divide, isPositive } from "../models/decimal";
import { assertRate } from "../models/rate";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  if (/placeholder|replace[_-]?me|your[_-]?key|xxx+/i.test(value)) {
    throw new Error(`${name} is still the placeholder value. Put the real value in .env.`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got ${raw}`);
  }
  return Math.floor(parsed);
}

/**
 * What one credit is worth in USD of LLM spend.
 *
 * Set as CREDITS_PER_USD — how many credits $1 buys, the way the business
 * states it — and turned into the per-credit rate every conversion uses
 * (models/rate.ts), at the ledger's ten decimal places. USD_PER_CREDIT, the
 * same thing stated the other way round, is still read when CREDITS_PER_USD is
 * not set, so an environment that has it keeps working.
 */
function readRate(): string {
  const perUsd = optional("CREDITS_PER_USD", "").trim();
  if (perUsd === "") return assertRate(optional("USD_PER_CREDIT", DEFAULT_USD_PER_CREDIT));
  if (!isPositive(perUsd)) {
    throw new RangeError(`CREDITS_PER_USD must be greater than zero, got ${perUsd}`);
  }
  return assertRate(divide("1", perUsd));
}

/**
 * FREE_PLAN_CREDITS: the credits billing grants an org ONCE, when it is first
 * linked to the free plan. Empty — or 0, which says the same thing and is what
 * an operator turning the grant off naturally writes — turns it off, and the
 * plan's own Credit Grant is all an org gets. Anything else must be a decimal
 * greater than zero — a typo here would otherwise be sent to Chargebee as
 * every new org's grant.
 */
function freePlanCredits(): string {
  const raw = optional("FREE_PLAN_CREDITS", "").trim();
  if (raw === "" || /^0+(\.0+)?$/.test(raw)) return "";
  let positive: boolean;
  try {
    positive = isPositive(raw);
  } catch {
    positive = false;
  }
  if (!positive) throw new RangeError(`FREE_PLAN_CREDITS must be a number greater than zero, got ${raw}`);
  return decimal(raw);
}

/**
 * FREE_PLAN_CREDIT_UNIT: the Chargebee credit unit the free plan's credits go
 * into (`token-test` on the test site). REQUIRED with FREE_PLAN_CREDITS.
 *
 * MEASURED 2026-09-30: a plan whose Credit Grant is zero gets NO credit wallet
 * (ledger account) from Chargebee — no grant block, no balance, no unit — so
 * there is no unit on the subscription to read. An allocate into this unit is
 * what creates the wallet. Without it an org would be put on the free plan
 * and granted nothing, silently.
 */
function freePlanCreditUnit(credits: string): string {
  const unit = optional("FREE_PLAN_CREDIT_UNIT", "").trim();
  if (credits !== "" && unit === "") {
    throw new Error(
      "FREE_PLAN_CREDIT_UNIT is not set. With FREE_PLAN_CREDITS on, it names the credit unit the free credits " +
        "go into (e.g. token-test): a free plan that grants zero gets no credit wallet from Chargebee to read one from.",
    );
  }
  return unit;
}

/**
 * The plan allowlist: ITEM_PRICE_IDS, with every currency's free plan always
 * on it. A site whose only plans are the free ones needs no ITEM_PRICE_IDS at
 * all, and one that lists others cannot leave a free plan off by accident —
 * which would stop every new org billed in that currency being subscribed.
 */
function planAllowlist(listed: string, freePlans: string[]): string[] {
  const ids = listed
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return [...ids, ...freePlans.filter((id, i) => !ids.includes(id) && freePlans.indexOf(id) === i)];
}

/**
 * The currency rule (models/currency.ts): BILLING_DEFAULT_CURRENCY, USD unless
 * set, for an org with no billing address and for every country not mapped;
 * BILLING_COUNTRY_CURRENCIES, `IN:INR` unless set, for the countries that are.
 *
 * Codes are trimmed and upper-cased, then checked — a currency here becomes the
 * suffix of the variables below (`TOPUP_ITEM_PRICE_ID_INR`), so a typo would
 * otherwise go looking for settings nobody wrote. A country named twice is
 * refused: it cannot be billed in two currencies.
 */
function currencyRules(): CurrencyRules {
  const rawDefault = optional("BILLING_DEFAULT_CURRENCY", "USD");
  const defaultCurrency = normaliseCurrency(rawDefault);
  if (defaultCurrency == null) {
    throw new Error(
      `BILLING_DEFAULT_CURRENCY must be a three-letter ISO 4217 currency code such as USD, got ${JSON.stringify(rawDefault)}`,
    );
  }

  const byCountry: Record<string, string> = {};
  const entries = optional("BILLING_COUNTRY_CURRENCIES", "IN:INR")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const parts = entry.split(":");
    const country = normaliseCountry(parts[0]);
    const currency = normaliseCurrency(parts[1]);
    if (parts.length !== 2 || country == null || currency == null) {
      throw new Error(
        `BILLING_COUNTRY_CURRENCIES must be COUNTRY:CURRENCY pairs separated by commas, such as IN:INR or IN:INR,GB:GBP — ` +
          `a two-letter ISO 3166-1 country and a three-letter ISO 4217 currency. ${JSON.stringify(entry)} is not one`,
      );
    }
    if (byCountry[country] != null) {
      throw new Error(
        `BILLING_COUNTRY_CURRENCIES names ${country} twice (${byCountry[country]} and ${currency}); a country is billed in one currency`,
      );
    }
    byCountry[country] = currency;
  }
  return { defaultCurrency, byCountry };
}

/**
 * The single-currency names, read until plans and top-ups became per currency.
 * Each is REFUSED when set, never quietly ignored: a stale .env would
 * otherwise boot with no free plan and no top-up at all — every new org left
 * unsubscribed — rather than fail at start with the names to use instead.
 */
const LEGACY_SINGLE_CURRENCY = [
  "FREE_PLAN_ITEM_PRICE_ID",
  "TOPUP_ITEM_PRICE_ID",
  "TOPUP_AMOUNTS",
  "TOPUP_MIN_AMOUNT",
  "TOPUP_MAX_AMOUNT",
  "TOPUP_CREDITS",
] as const;

function refuseSingleCurrency(currencies: string[]): void {
  const stale = LEGACY_SINGLE_CURRENCY.filter((name) => (process.env[name] ?? "").trim() !== "");
  if (stale.length === 0) return;
  const replacements = stale.map((name) => `${name} with ${currencies.map((currency) => `${name}_${currency}`).join(" and ")}`);
  throw new Error(
    `${stale.join(", ")} ${stale.length === 1 ? "is" : "are"} no longer read: plans and top-ups are set per billing ` +
      `currency (${currencies.join(", ")} — from BILLING_DEFAULT_CURRENCY and BILLING_COUNTRY_CURRENCIES). ` +
      `Replace ${replacements.join("; ")}, each set for its own currency, and remove the old ` +
      `${stale.length === 1 ? "name" : "names"}.`,
  );
}

/**
 * `<name>_<CUR>` for EVERY billing currency, or for none.
 *
 * None turns the feature off, as an empty FREE_PLAN_ITEM_PRICE_ID used to.
 * Some but not all is refused: an org billed in a currency left out would have
 * no free plan to be put on, or no top-up to buy — found out by a customer
 * long after the deploy, rather than by the process at start.
 */
function allOrNone(name: string, currencies: string[], what: string): Record<string, string | null> {
  const values = Object.fromEntries(currencies.map((currency) => [currency, optional(`${name}_${currency}`, "").trim() || null]));
  const set = currencies.filter((currency) => values[currency] != null);
  const missing = currencies.filter((currency) => values[currency] == null);
  if (set.length > 0 && missing.length > 0) {
    const names = (list: string[]) => list.map((currency) => `${name}_${currency}`).join(" and ");
    throw new Error(
      `${names(missing)} ${missing.length === 1 ? "is" : "are"} not set, but ${names(set)} ${set.length === 1 ? "is" : "are"}: ` +
        `every billing currency (${currencies.join(", ")}) needs its own ${what}, or an org billed in ${missing[0]} has none. ` +
        `Set ${names(missing)}, or unset ${names(set)} to turn the ${what} off.`,
    );
  }
  return values;
}

/** What billing sells in one currency, before the container makes a catalog of it (models/currency.ts). */
export interface CurrencyBilling {
  freeItemPriceId: string | null;
  topUp: TopUpSettingsForCurrency | null;
}

/**
 * Each billing currency's free plan and top-up, from the per-currency
 * variables. Every value is checked whether or not its feature is on — a typo
 * in TOPUP_MAX_AMOUNT_USD is refused today, not on the day top-ups are
 * switched on.
 */
function billingByCurrency(currencies: string[], grantsByDefault: boolean): Record<string, CurrencyBilling> {
  const free = allOrNone("FREE_PLAN_ITEM_PRICE_ID", currencies, "free plan");
  const topUpPrices = allOrNone("TOPUP_ITEM_PRICE_ID", currencies, "top-up");
  const billing: Record<string, CurrencyBilling> = {};
  for (const currency of currencies) {
    const minAmount = optionalAmount(`TOPUP_MIN_AMOUNT_${currency}`);
    const maxAmount = optionalAmount(`TOPUP_MAX_AMOUNT_${currency}`);
    if (minAmount != null && maxAmount != null && minAmount > maxAmount) {
      throw new RangeError(
        `TOPUP_MIN_AMOUNT_${currency} (${minAmount}) is larger than TOPUP_MAX_AMOUNT_${currency} (${maxAmount})`,
      );
    }
    const presetAmounts = amountList(`TOPUP_AMOUNTS_${currency}`, "50,100");
    const credits = topUpCredits(`TOPUP_CREDITS_${currency}`);
    const chargebeeGrants = grantMode(`TOPUP_CHARGEBEE_GRANTS_${currency}`, grantsByDefault);
    const itemPriceId = topUpPrices[currency] ?? null;
    billing[currency] = {
      freeItemPriceId: free[currency] ?? null,
      topUp: itemPriceId ? { itemPriceId, presetAmounts, minAmount, maxAmount, credits, chargebeeGrants } : null,
    };
  }
  return billing;
}

/**
 * TOPUP_CHARGEBEE_GRANTS_<CUR>: `true` or `false`, else the site-wide
 * TOPUP_CHARGEBEE_GRANTS. Anything else is refused — a typo here decides
 * whether a paid pack is granted by Chargebee, by billing, or twice.
 */
function grantMode(name: string, fallback: boolean): boolean {
  const raw = optional(name, "").trim();
  if (raw === "") return fallback;
  if (raw === "true" || raw === "false") return raw === "true";
  throw new Error(`${name} must be true or false, got ${JSON.stringify(raw)}`);
}

/**
 * Like `integer`, but 0 is a legitimate value meaning "off".
 *
 * Separate from `integer` on purpose: for a lag, a timeout or a retention
 * window, 0 is a mistake worth refusing — it would read up to `now()` or prune
 * everything. For a cache TTL it is how you turn the cache off.
 */
function nonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be zero or a positive number, got ${raw}`);
  }
  return Math.floor(parsed);
}

/**
 * The shortest `BILLING_LAG_MS` accepted without `BILLING_ALLOW_SHORT_LAG=true`.
 *
 * Windows are on when each LLM call ENDED (`Timestamp + duration_ms`), and its
 * span reaches ClickHouse after that: MEASURED 2026-09-30 over 421 spans, p50
 * 23 s and p99 44 s. A window read sooner than its spans land is billed
 * without them, and they are then behind the cursor and never billed. Thirty
 * seconds is under what the measurement allows and well over any
 * seconds-for-milliseconds typo — the live .env once carried
 * `BILLING_LAG_MS=120` (meant as 120 s), and once `0` — so a value below it
 * stops the process at start instead of losing usage quietly.
 */
export const MIN_LAG_MS = 30_000;

/**
 * `BILLING_LAG_MS`, refusing an obviously wrong value. 60 s unless set: past
 * every span but one in the measurement above. Shorter bills sooner and loses
 * more — at 45 s, 3 of those 421 spans. Enforcement is the gateway's real-time
 * budget, so this delays only when usage reaches Chargebee.
 *
 * `BILLING_ALLOW_SHORT_LAG=true` lifts the floor. It exists for tests that
 * drive the worker against a local ClickHouse on a short clock, and must never
 * be set anywhere real.
 */
function lagMs(): number {
  const value = integer("BILLING_LAG_MS", 60_000);
  if (value < MIN_LAG_MS && process.env.BILLING_ALLOW_SHORT_LAG !== "true") {
    throw new Error(
      `BILLING_LAG_MS is ${value} ms — below the ${MIN_LAG_MS} ms floor. It is in MILLISECONDS: ` +
        `sixty seconds is 60000. A call's span reaches ClickHouse up to ~45 s after the call ends; a shorter ` +
        `lag bills a window before its spans land and silently leaves them unbilled. ` +
        `(BILLING_ALLOW_SHORT_LAG=true lifts the floor, for tests only.)`,
    );
  }
  return value;
}

/**
 * OPEN DECISION (design Q1): the exact rate is a business decision that has not
 * been made. The default below makes 1,000 credits worth $1.00 of LLM spend.
 *
 * A credit is a BILLING unit, not an LLM token — see models/rate.ts. Changing this
 * value does not restate history: every batch stores the credits it computed at
 * the rate in force when its window opened.
 */
const DEFAULT_USD_PER_CREDIT = "0.001";

/**
 * Built on first use, not at import.
 *
 * Eager validation is right for a running server and wrong for a module other
 * code imports: a unit test that only wants `createChargebee({ site, apiKey })`
 * should not be forced to invent a ClickHouse password. Memoised, so the
 * validation still happens exactly once per process.
 */
let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  cached = buildConfig();
  return cached;
}

/** Test-only: forget the memoised config so new env vars take effect. */
export function resetConfig(): void {
  cached = null;
}

function buildConfig() {
  const freeCredits = freePlanCredits();
  const rules = currencyRules();
  const currencies = currenciesOf(rules);
  // Before anything per-currency is read: a stale .env gets the names to use
  // instead, not an all-or-none complaint about variables it never had.
  refuseSingleCurrency(currencies);
  const topUpChargebeeGrants = optional("TOPUP_CHARGEBEE_GRANTS", "false") === "true";
  const billing = billingByCurrency(currencies, topUpChargebeeGrants);
  const freePlans = currencies.map((currency) => billing[currency]!.freeItemPriceId).filter((id): id is string => id != null);
  return {
    /** Charged per credit, in USD. */
    usdPerCredit: readRate(),

    /**
     * Only LLM calls that ended at least this long ago are read
     * (safe_until = now − lag). Milliseconds; below MIN_LAG_MS is refused.
     */
    lagMs: lagMs(),

    /**
     * The longest range one Chargebee charge covers. Each pass bills every
     * tenant from its cursor to `now − lag` — ordinarily the minute since the
     * last pass — and a catch-up after an outage goes an hour at a time.
     * Chargebee refuses a capture larger than the balance WHOLE, so this is
     * also the most an org that ran out mid-outage can have held at once.
     */
    maxRangeMs: integer("BILLING_MAX_RANGE_MS", 60 * 60_000),

    /**
     * How often the usage sync passes over every org. Hatchet's cron fires once
     * a minute at most, so a shorter interval runs several passes inside each
     * minute's run (worker/hatchet-worker.ts). Usage reaches Chargebee about
     * BILLING_LAG_MS plus one interval after the call ended.
     * 60 s or more: one pass per minute.
     */
    sweepIntervalMs: integer("BILLING_SWEEP_INTERVAL_MS", 60 * 1000),

    /** Unresolved syncs past this many attempts log as errors. The row stays unresolved regardless. */
    maxAttempts: integer("BILLING_MAX_ATTEMPTS", 10),

    /**
     * How long a plan's details are reused before Chargebee is asked again.
     * 0 disables the cache — every render asks Chargebee, which is what you
     * want when testing how the page behaves against a broken credential.
     */
    planCacheTtlMs: nonNegativeInteger("BILLING_PLAN_CACHE_TTL_MS", 10 * 60 * 1000),

    chargebee: {
      site: required("CHARGEBEE_SITE"),
      apiKey: required("CHARGEBEE_API_KEY"),
    },

    /**
     * HTTP Basic credentials set on Chargebee's webhook endpoint, checked by
     * POST /api/webhooks/chargebee. Chargebee does not sign webhooks, so these
     * are the whole of its authentication. Empty means unset, and unset
     * refuses every delivery — never accepts it.
     */
    chargebeeWebhook: {
      user: optional("CHARGEBEE_WEBHOOK_USER", ""),
      password: optional("CHARGEBEE_WEBHOOK_PASSWORD", ""),
    },

    clickhouse: {
      url: optional("CLICKHOUSE_URL", "http://localhost:8123"),
      user: optional("CLICKHOUSE_USER", "default"),
      password: required("CLICKHOUSE_PASSWORD"),
      /** Billing reads must never wedge behind a runaway scan. */
      timeoutMs: integer("CLICKHOUSE_TIMEOUT_MS", 20_000),
    },

    /**
     * The LiteLLM gateway, for setting each prepaid team's `max_budget`.
     *
     * Optional: with no master key the budget is not pushed and a warning says
     * so, rather than every checkout failing on a missing gateway.
     */
    litellm: {
      baseUrl: optional("LITELLM_BASE_URL", "http://localhost:4000"),
      masterKey: optional("LITELLM_MASTER_KEY", ""),
      timeoutMs: integer("LITELLM_TIMEOUT_MS", 10_000),
    },

    /**
     * How a billing country becomes a currency (models/currency.ts):
     * BILLING_DEFAULT_CURRENCY (USD) for an org with no billing address and
     * for every country BILLING_COUNTRY_CURRENCIES (`IN:INR`) does not map.
     * An org already subscribed only ever moves to another currency when it
     * CONFIRMS an address — never because of the default.
     */
    currencyRules: rules,

    /** Every currency billing can bill in: the default first, then each mapped one. */
    currencies,

    /**
     * What billing sells in each currency, keyed by currency code — the
     * container makes the catalog every service reads from this. Chargebee
     * fixes a subscription's currency, and refuses a charge in any other
     * (MEASURED: `currency_mismatched`), so each currency has its own item
     * prices:
     *
     *   FREE_PLAN_ITEM_PRICE_ID_<CUR>   the plan an org billed in <CUR> is put
     *                                   on automatically — at sign-up, and when
     *                                   its billing page is opened with no
     *                                   subscription — with no checkout and no
     *                                   card. Must cost nothing (checked
     *                                   against the catalogue before every
     *                                   create); always on the plan allowlist.
     *   TOPUP_ITEM_PRICE_ID_<CUR>       the top-up pack in <CUR>: a ONE-TIME
     *                                   charge, not a second subscription —
     *                                   which would leave the customer with
     *                                   two, where the schema allows one. An
     *                                   ITEM PRICE id (`api_token-USD`), not
     *                                   the item's (`api_token`): checkout
     *                                   looks the price up to learn its
     *                                   currency, and the paid-invoice match is
     *                                   on `line_items[].entity_id`, which is
     *                                   the item price. The live .env once held
     *                                   the item id, and every top-up checkout
     *                                   failed with "No currency for item price
     *                                   test-top-up" (C57c).
     *   TOPUP_AMOUNTS_<CUR>             the one-click amounts, in <CUR>'s MAJOR
     *                                   unit (`50,100` is ₹50 and ₹100). The
     *                                   page shows those it can sell whole
     *                                   within the limits, and Custom beside
     *                                   them. `50,100` unless set.
     *   TOPUP_MIN_AMOUNT_<CUR>,         the smallest and largest top-up, in the
     *   TOPUP_MAX_AMOUNT_<CUR>          same unit. Unset: the smallest is one
     *                                   unit, and there is no largest. Enforced
     *                                   by billing (checkout.startTopUp), not
     *                                   only shown by the page.
     *   TOPUP_CREDITS_<CUR>             credits ONE unit of the pack grants —
     *                                   read only when BILLING allocates the
     *                                   pack (TOPUP_CHARGEBEE_GRANTS=false),
     *                                   and required then. With Chargebee
     *                                   granting it (the pack's own Credit
     *                                   Grant) the credits are Chargebee's,
     *                                   read back from the grant block: the
     *                                   page quotes an amount, not credits.
     *
     * The free plan and the top-up are each set for EVERY currency or for
     * none (none turns it off). The old unsuffixed names are refused at start.
     */
    billing,

    /**
     * The plans an org may be on: the allowlist the linking step picks a usage
     * subscription from, and checkout sells from. ITEM_PRICE_IDS lists any
     * besides the free plans, which are always included — so a site that uses
     * only the free plans sets nothing here. ONE list across currencies: a
     * paid plan's currency is read from the Chargebee catalogue, never parsed
     * from its id. An org's CURRENT subscription is kept whatever this says
     * (models/subscription.ts).
     *
     * An ALLOWLIST, not a menu. Every request naming an item price is checked
     * against it, so a tampered request cannot start a checkout for some other
     * plan in the catalogue.
     */
    itemPriceIds: planAllowlist(optional("ITEM_PRICE_IDS", ""), freePlans),

    /** The paid plan checkout uses when none is named — only for an org billed in that plan's currency. */
    defaultItemPriceId: optional("DEFAULT_ITEM_PRICE_ID", "pre-paid-test-v1-INR-Monthly"),

    /**
     * How long POST /api/internal/billing-address/sync runs a currency switch
     * inline before answering, in milliseconds, counted from the start of the
     * request; the rest finishes in the background (the worker each minute).
     * Under the platform proxy's 10-second timeout with room for reading the
     * address back from Chargebee. 0 runs nothing inline.
     */
    switchInlineMs: nonNegativeInteger("BILLING_SWITCH_INLINE_MS", 6000),

    /**
     * Whether saving an address that changes the currency of a LIVE free
     * subscription switches it (BILLING_CURRENCY_SWITCH_ENABLED). OFF unless
     * exactly `true`. Off, addresses are still saved and still decide the
     * currency of NEW subscriptions, but such a change is refused and nothing
     * is written. A ROLLOUT GATE: an API replica or worker still running the
     * code before this would write `active` or `exhausted` over `switching`
     * and capture on the emptied subscription, leaving a switch stuck — so it
     * is turned on only once every replica and worker runs this code, with
     * both billing-currency migrations applied.
     */
    currencySwitchEnabled: optional("BILLING_CURRENCY_SWITCH_ENABLED", "false") === "true",

    /**
     * Whether an org with no setting of its own is put on the free plan. Off
     * by default: an org is offered the paid plans unless an operator turns
     * the free plan on for it (POST /api/internal/free-plan).
     */
    freePlanDefault: optional("FREE_PLAN_DEFAULT", "false") === "true",

    /**
     * Credits granted ONCE per org on the free plan, by billing's own allocate
     * — for a free plan whose Credit Grant is set to zero in the catalogue, so
     * a renewal grants nothing. Empty: off. See account.service.ts
     * grantFreePlanCredits.
     */
    freePlanCredits: freeCredits,

    /** The credit unit those credits go into; required with them (see freePlanCreditUnit). */
    freePlanCreditUnit: freePlanCreditUnit(freeCredits),

    /**
     * The app's origin, where Chargebee returns the browser after the portal
     * and the card page (`/organization/billing`). MEASURED: Chargebee accepts
     * a redirect only on port 80, 443, 8080 or 8443, so the local
     * `http://localhost:4200` is refused — use the HTTPS dev origin.
     */
    appUrl: optional("APP_URL", "http://localhost:4200"),

    /**
     * Whether POST /api/internal/portal may open Chargebee's self-serve portal.
     * OFF unless set to exactly `true`.
     *
     * Customers must not be able to cancel their subscription, and Chargebee's
     * portal lets them unless "Allow customers to cancel subscriptions" is
     * switched off in the site's Self-Serve Portal settings — a setting this
     * service cannot read or enforce. So the portal stays shut until someone
     * has switched that off on the site AND set this to say so.
     */
    portalEnabled: optional("CHARGEBEE_PORTAL_ENABLED", "false") === "true",

    /**
     * Whether an org that has saved a billing address may change it. OFF
     * unless exactly `true`: the first address is still added (it decides the
     * currency, and top-ups wait on it), but once one is saved the page shows
     * no edit button and the portal refuses a session (409 `address-edit-off`).
     */
    addressEditEnabled: optional("BILLING_ADDRESS_EDIT_ENABLED", "false") === "true",

    /**
     * The top-up charge carries its own Credit Grant in the Chargebee
     * catalogue, so Chargebee grants each paid pack and billing only records
     * it — and never allocates, which would grant twice. The site-wide
     * default; each currency's top-up says for itself in `billing` (from
     * TOPUP_CHARGEBEE_GRANTS_<CUR>, else this).
     */
    topUpChargebeeGrants,
  } as const;
}

/**
 * TOPUP_CREDITS_<CUR>, or "" when unset. Needed only when billing allocates a
 * paid pack itself (TOPUP_CHARGEBEE_GRANTS=false); a pack it would have to
 * allocate without it is held and said out loud (account.service.ts
 * firstTopUp) — never granted a guessed amount.
 */
function topUpCredits(name: string): string {
  const raw = optional(name, "").trim();
  if (raw === "") return "";
  if (!isPositiveDecimal(raw)) throw new RangeError(`${name} must be a number greater than zero, got ${raw}`);
  return decimal(raw);
}

/** A comma-separated list of amounts greater than zero; an empty setting is an empty list. */
function amountList(name: string, fallback: string): number[] {
  const raw = process.env[name] ?? fallback;
  const amounts = raw.split(",").map((a) => a.trim()).filter(Boolean);
  return amounts.map((a) => {
    const n = Number(a);
    if (!Number.isFinite(n) || n <= 0) throw new RangeError(`${name} must list amounts greater than zero, got ${JSON.stringify(a)}`);
    return n;
  });
}

/** An amount greater than zero, or null when unset. */
function optionalAmount(name: string): number | null {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new RangeError(`${name} must be an amount greater than zero, got ${raw}`);
  return n;
}

function isPositiveDecimal(value: string): boolean {
  try {
    return isPositive(value);
  } catch {
    return false;
  }
}

export type Config = ReturnType<typeof buildConfig>;
