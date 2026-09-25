/**
 * Configuration, validated once at import.
 *
 * Every value that can be wrong is checked here rather than at the first
 * capture of the month. A placeholder that reaches Chargebee comes back as
 * "Invalid api key", which gives no hint that the value was never filled in.
 */

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
 * The lag is in MILLISECONDS, and the mistake it guards against is real: the
 * live .env carried `BILLING_LAG_MS=120` — 0.12 s, meant as 120 s — so the
 * worker read up to the present instant and raced ClickHouse's own inserts
 * (the collector's batch, async-insert flushes). A row that landed a few
 * seconds late in a window already billed was silently never charged (C11).
 * Ten seconds is well under any lag that makes sense and well over any
 * seconds-for-milliseconds typo, so a value below it stops the process at
 * start instead of losing usage quietly.
 */
export const MIN_LAG_MS = 10_000;

/**
 * `BILLING_LAG_MS`, refusing an obviously wrong value.
 *
 * `BILLING_ALLOW_SHORT_LAG=true` lifts the floor. It exists for tests that
 * drive the worker against a local ClickHouse on a short clock, and must never
 * be set anywhere real.
 */
function lagMs(): number {
  const value = integer("BILLING_LAG_MS", 2 * 60 * 1000);
  if (value < MIN_LAG_MS && process.env.BILLING_ALLOW_SHORT_LAG !== "true") {
    throw new Error(
      `BILLING_LAG_MS is ${value} ms — below the ${MIN_LAG_MS} ms floor. It is in MILLISECONDS: ` +
        `two minutes is 120000, not 120. A lag this short reads rows ClickHouse is still inserting and ` +
        `silently leaves them unbilled. (BILLING_ALLOW_SHORT_LAG=true lifts the floor, for tests only.)`,
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
  return {
    /** Charged per credit, in USD. */
    usdPerCredit: assertRate(optional("USD_PER_CREDIT", DEFAULT_USD_PER_CREDIT)),

    /**
     * Only usage ingested into ClickHouse at least this long ago is read
     * (safe_until = now − lag). Milliseconds; below MIN_LAG_MS is refused.
     */
    lagMs: lagMs(),

    /**
     * How long one billing window is — and it is FIXED, not "however much is
     * available".
     *
     * A window runs from the cursor for exactly this long, and is processed only
     * once it fits entirely inside `now − lag`. That makes the window's end a
     * function of its start, which is what lets two workers reading the same
     * cursor agree on which window they are looking at. A window sized to
     * whatever happened to be available would give them different ends for the
     * same start, and the uniqueness index could not tell they were competing.
     *
     * It also bounds a catch-up scan: after an outage a tenant drains in
     * minute-sized pieces, up to BILLING_MAX_WINDOWS_PER_TICK per tick, each
     * succeeding or failing on its own.
     */
    windowMs: integer("BILLING_WINDOW_MS", 60 * 1000),

    /** How many windows one tick may process for one tenant, so a backlog cannot run past the task timeout. */
    maxWindowsPerTick: integer("BILLING_MAX_WINDOWS_PER_TICK", 20),

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
     * The plans checkout is allowed to sell.
     *
     * An ALLOWLIST, not a menu. Every request naming an item price is checked
     * against it, so a tampered request cannot start a checkout for some other
     * plan in the catalogue — precisely the hole Chargebee's attribute drop-in
     * leaves open, since it puts the item price in markup the browser controls.
     */
    itemPriceIds: optional("ITEM_PRICE_IDS", "pre-paid-test-v1-INR-Monthly")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),

    defaultItemPriceId: optional("DEFAULT_ITEM_PRICE_ID", "pre-paid-test-v1-INR-Monthly"),

    /** Where Chargebee returns the browser after the self-serve portal. */
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
    topUpCredits: optional("TOPUP_CREDITS", "1000"),
  } as const;
}

export type Config = ReturnType<typeof buildConfig>;
