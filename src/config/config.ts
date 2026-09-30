/**
 * Configuration, validated once at import.
 *
 * Every value that can be wrong is checked here rather than at the first
 * capture of the month. A placeholder that reaches Chargebee comes back as
 * "Invalid api key", which gives no hint that the value was never filled in.
 */

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
 * linked to the free plan. Empty turns it off, and the plan's own Credit Grant
 * is all an org gets. Anything set must be a decimal greater than zero — a
 * typo here would otherwise be sent to Chargebee as every new org's grant.
 */
function freePlanCredits(): string {
  const raw = optional("FREE_PLAN_CREDITS", "").trim();
  if (raw === "") return "";
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
 * The plan allowlist: ITEM_PRICE_IDS, with the free plan always on it. A site
 * whose only plan is the free one needs no ITEM_PRICE_IDS at all, and one that
 * lists others cannot leave the free plan off by accident — which would stop
 * every new org being subscribed.
 */
function planAllowlist(listed: string, freePlan: string): string[] {
  const ids = listed
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return freePlan !== "" && !ids.includes(freePlan) ? [...ids, freePlan] : ids;
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
     * The plans an org may be on: the allowlist the linking step picks a usage
     * subscription from, and checkout sells from. ITEM_PRICE_IDS lists any
     * besides the free plan, which is always included — so a site that uses
     * only the free plan sets nothing here. An org's CURRENT subscription is
     * kept whatever this says (models/subscription.ts).
     *
     * An ALLOWLIST, not a menu. Every request naming an item price is checked
     * against it, so a tampered request cannot start a checkout for some other
     * plan in the catalogue.
     */
    itemPriceIds: planAllowlist(optional("ITEM_PRICE_IDS", ""), optional("FREE_PLAN_ITEM_PRICE_ID", "")),

    defaultItemPriceId: optional("DEFAULT_ITEM_PRICE_ID", "pre-paid-test-v1-INR-Monthly"),

    /**
     * The plan every org is put on automatically — at sign-up, and when its
     * billing page is opened with no subscription — with no checkout and no
     * card. Must cost nothing (checked against the catalogue before every
     * create); always on the plan allowlist. Empty turns automatic
     * subscription off.
     */
    freeItemPriceId: optional("FREE_PLAN_ITEM_PRICE_ID", ""),

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
     * The top-up pack: a ONE-TIME charge, not a second subscription.
     *
     * Buying another subscription would leave the customer with two, and the
     * schema allows only one per tenant. A charge adds credits to the existing
     * subscription's ledger instead.
     */
    //
    // An ITEM PRICE id (e.g. `test-top-up-INR`), not the item's id
    // (`test-top-up`): checkout looks the price up to learn its currency, and
    // the paid-invoice match is on `line_items[].entity_id`, which is the
    // item price. The live .env once held the item id, and every top-up
    // checkout failed with "No currency for item price test-top-up" (C57c).
    topUpItemPriceId: optional("TOPUP_ITEM_PRICE_ID", "token-pack-5m-INR"),
    /**
     * Credits ONE UNIT of the top-up charge grants. The customer picks a
     * quantity; a paid invoice for N units grants N × this. Before quantities
     * every top-up was one unit, so an existing value keeps meaning what it did.
     */
    topUpCredits: optional("TOPUP_CREDITS", "1000"),
    /** The most units one top-up checkout may sell — a typo guard, not a limit on spend. */
    topUpMaxQuantity: integer("TOPUP_MAX_QUANTITY", 100),
    /**
     * The top-up charge carries its own Credit Grant in the Chargebee catalogue,
     * so Chargebee grants each paid pack and billing only records it — and never
     * allocates, which would grant twice. TOPUP_CREDITS must then equal what that
     * grant gives per unit: it is only the figure the page quotes.
     */
    topUpChargebeeGrants: optional("TOPUP_CHARGEBEE_GRANTS", "false") === "true",
  } as const;
}

export type Config = ReturnType<typeof buildConfig>;
