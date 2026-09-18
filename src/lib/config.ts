/**
 * Configuration, validated once at import.
 *
 * Every value that can be wrong is checked here rather than at the first
 * capture of the month. A placeholder that reaches Chargebee comes back as
 * "Invalid api key", which gives no hint that the value was never filled in.
 */

import { assertRate } from "./rate";

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
 * OPEN DECISION (design Q1): the exact rate is a business decision that has not
 * been made. The default below makes 1,000 credits worth $1.00 of LLM spend.
 *
 * A credit is a BILLING unit, not an LLM token — see lib/rate.ts. Changing this
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
     * Set true only if the Chargebee ledger unit rejects fractional amounts.
     * When true, the remainder is carried forward rather than truncated, so many
     * small windows cannot round to zero forever.
     */
    wholeCreditsOnly: process.env.WHOLE_CREDITS_ONLY === "true",

    /** How long a window must have been closed before it is billed. */
    lagMs: integer("BILLING_LAG_MS", 2 * 60 * 1000),

    /** Longest interval one window may cover, so a backlog stays auditable. */
    maxWindowMs: integer("BILLING_MAX_WINDOW_MS", 60 * 60 * 1000),

    /** Give up on a batch after this many attempts and ask for a human. */
    maxAttempts: integer("BILLING_MAX_ATTEMPTS", 10),

    chargebee: {
      site: required("CHARGEBEE_SITE"),
      apiKey: required("CHARGEBEE_API_KEY"),
      /** Chargebee does not sign webhooks — these credentials are the only auth. */
      webhookUser: optional("CHARGEBEE_WEBHOOK_USER", ""),
      webhookPassword: optional("CHARGEBEE_WEBHOOK_PASSWORD", ""),
    },

    clickhouse: {
      url: optional("CLICKHOUSE_URL", "http://localhost:8123"),
      user: optional("CLICKHOUSE_USER", "default"),
      password: required("CLICKHOUSE_PASSWORD"),
      /** Billing reads must never wedge behind a runaway scan. */
      timeoutMs: integer("CLICKHOUSE_TIMEOUT_MS", 20_000),
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
     * The top-up pack: a ONE-TIME charge, not a second subscription.
     *
     * Buying another subscription would leave the customer with two, and the
     * schema allows only one per tenant. A charge adds credits to the existing
     * subscription's ledger instead.
     */
    topUpItemPriceId: optional("TOPUP_ITEM_PRICE_ID", "token-pack-5m-INR"),
    topUpCredits: optional("TOPUP_CREDITS", "1000"),

    /** Shared secret for the internal API crewpe-ui calls through its proxy. */
    internalApiKey: required("BILLING_INTERNAL_API_KEY"),
  } as const;
}

export type Config = ReturnType<typeof buildConfig>;
