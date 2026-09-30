/**
 * Plan details for the checkout page, read from Chargebee.
 *
 * The allowlist in `ITEM_PRICE_IDS` says WHICH plans may be sold; it says
 * nothing about what they are. The page used to derive a label by splitting the
 * id on "-", which guessed wrong the moment an item name contained a hyphen and
 * could never show a price at all. Chargebee already holds the name, amount,
 * currency and period, so they are read from there and never duplicated here.
 *
 * Two properties this must have, because it sits on a page load:
 *
 *   - CACHED. Item prices change when someone edits the catalogue, which is
 *     approximately never, and the billing page is opened often. One Chargebee
 *     round trip per plan per TTL, not per render.
 *   - NEVER FATAL. Chargebee being down must not stop the page rendering or
 *     disable checkout: the id alone is enough to start one, and the allowlist
 *     is enforced server-side regardless. A failed lookup degrades to the id.
 */

import type { ChargebeeClient, ItemPrice } from "../integrations/chargebee";
import { errorMessage } from "../shared/errors";
import type { Logger } from "../shared/logger";

/** What the billing API returns per offered plan. */
export interface PlanOffer {
  itemPriceId: string;
  /** Chargebee's customer-facing name, or the id when it could not be read. */
  name: string;
  /** Minor units (paise, cents). Null when unknown — render the name alone. */
  priceMinor: number | null;
  currencyCode: string | null;
  period: number | null;
  periodUnit: string | null;
  /** False when this came from the fallback, so callers can tell a guess apart. */
  resolved: boolean;
}

/**
 * Ten minutes: long enough that the page is not a Chargebee client, short
 * enough that a catalogue edit shows up without a deploy.
 */
export const PLAN_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  plan: PlanOffer;
  at: number;
}

/**
 * Module-level, like the Prisma client: a Next.js route module is reused across
 * requests, so this survives between them. Per-process, so a redeploy or a
 * second pod simply re-reads — the cache is an optimisation, never a source of
 * truth.
 */
const cache = new Map<string, CacheEntry>();

/** The shape used when Chargebee cannot answer. Enough to start a checkout. */
function fallback(itemPriceId: string): PlanOffer {
  return {
    itemPriceId,
    name: itemPriceId,
    priceMinor: null,
    currencyCode: null,
    period: null,
    periodUnit: null,
    resolved: false,
  };
}

function toOffer(price: ItemPrice): PlanOffer {
  return {
    itemPriceId: price.id,
    name: price.name,
    priceMinor: price.priceMinor,
    currencyCode: price.currencyCode,
    period: price.period,
    periodUnit: price.periodUnit,
    resolved: true,
  };
}

/**
 * Describe every offered plan, in the order the allowlist lists them.
 *
 * Order is preserved deliberately: `DEFAULT_ITEM_PRICE_ID` aside, the first
 * entry is what the page pre-selects, so the operator controls the default by
 * ordering the env var.
 */
export async function describePlans(
  itemPriceIds: string[],
  chargebee: ChargebeeClient,
  {
    now = () => Date.now(),
    ttlMs = PLAN_CACHE_TTL_MS,
    logger = console,
  }: {
    now?: () => number;
    ttlMs?: number;
    logger?: Logger;
  } = {},
): Promise<PlanOffer[]> {
  const at = now();

  return Promise.all(
    itemPriceIds.map(async (id) => {
      const hit = cache.get(id);
      if (hit && at - hit.at < ttlMs) return hit.plan;

      try {
        const price = await chargebee.itemPrice(id);
        // A null means the id is not in the catalogue — an allowlist entry that
        // does not exist. Worth saying out loud: checkout for it would fail at
        // Chargebee, and the operator is the only one who can fix it.
        if (!price) {
          logger.warn?.(
            { metric: "billing.plan.not_in_catalogue", itemPriceId: id },
            "Offered plan does not exist in Chargebee; rendering by id",
          );
          return fallback(id);
        }
        const plan = toOffer(price);
        cache.set(id, { plan, at });
        return plan;
      } catch (err) {
        // Serve a stale entry over a degraded one: an hour-old price is closer
        // to the truth than no price, and this is display only.
        if (hit) return hit.plan;
        logger.warn?.(
          { metric: "billing.plan.lookup_failed", itemPriceId: id, err: errorMessage(err) },
          "Could not read plan details from Chargebee; rendering by id",
        );
        return fallback(id);
      }
    }),
  );
}

/** What the billing API returns about the top-up charge. */
export interface TopUpOffer {
  itemPriceId: string;
  name: string;
  /**
   * Price of ONE unit, in minor units. Null unless Chargebee prices the charge
   * per unit — a flat fee is not a unit price and a tiered one has no single
   * number — or when it could not be read. The page then shows no total, and
   * Chargebee's charge quotes the real one.
   */
  unitPriceMinor: number | null;
  currencyCode: string | null;
  /**
   * The one-click amounts (TOPUP_AMOUNTS), in the charge's MAJOR currency
   * unit — `[50, 100]` is ₹50 and ₹100 on an INR charge. The page offers those
   * it can sell whole within the limits below, and Custom beside them.
   */
  presetAmounts: number[];
  /**
   * Fewest and most units one top-up may buy: TOPUP_MIN_AMOUNT and
   * TOPUP_MAX_AMOUNT turned into units of this charge's price. The most is
   * null — no maximum — while TOPUP_MAX_AMOUNT is unset. Both 1 for a charge
   * with no unit price. checkout's startTopUp enforces exactly these, so the
   * page cannot offer what billing refuses.
   */
  minQuantity: number;
  maxQuantity: number | null;
}

/** What configures the top-up offer (config.ts). Amounts are in the charge's MAJOR currency unit. */
export interface TopUpSettings {
  itemPriceId: string;
  presetAmounts: number[];
  minAmount: number | null;
  maxAmount: number | null;
}

const topUpCache = new Map<string, { price: ItemPrice | null; at: number }>();

/** Decimal places of a currency's minor unit: 2 for INR and USD, 0 for JPY. */
export function currencyDigits(currencyCode: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * The fewest and most units one top-up may buy. A charge with no unit price —
 * a flat fee, a tiered price, or one Chargebee could not be asked for — is
 * bought one unit at a time: an amount limit cannot be turned into units of a
 * price not known, and one unit is what the page buys then anyway.
 */
export function topUpQuantityLimits(price: ItemPrice | null, settings: TopUpSettings): { minQuantity: number; maxQuantity: number | null } {
  const unit = price?.pricingModel === "per_unit" ? price.priceMinor : null;
  if (unit == null || unit <= 0 || !price?.currencyCode) return { minQuantity: 1, maxQuantity: 1 };
  const scale = 10 ** currencyDigits(price.currencyCode);
  const minQuantity = settings.minAmount == null ? 1 : Math.max(1, Math.ceil(Math.round(settings.minAmount * scale) / unit));
  const maxQuantity = settings.maxAmount == null ? null : Math.floor(Math.round(settings.maxAmount * scale) / unit);
  return { minQuantity, maxQuantity };
}

/**
 * The top-up charge, described for the page. Same two rules as describePlans:
 * cached, and never fatal — a Chargebee outage leaves the button working with
 * no price shown, since the charge itself still quotes one.
 */
export async function describeTopUp(
  settings: TopUpSettings,
  chargebee: ChargebeeClient,
  {
    now = () => Date.now(),
    ttlMs = PLAN_CACHE_TTL_MS,
    logger = console,
  }: {
    now?: () => number;
    ttlMs?: number;
    logger?: Logger;
  } = {},
): Promise<TopUpOffer> {
  const at = now();
  const hit = topUpCache.get(settings.itemPriceId);
  let price: ItemPrice | null = null;
  if (hit && at - hit.at < ttlMs) {
    price = hit.price;
  } else {
    try {
      price = await chargebee.itemPrice(settings.itemPriceId);
      topUpCache.set(settings.itemPriceId, { price, at });
    } catch (err) {
      price = hit?.price ?? null;
      logger.warn?.(
        { metric: "billing.topup.lookup_failed", itemPriceId: settings.itemPriceId, err: errorMessage(err) },
        "Could not read the top-up charge from Chargebee; the page shows no price",
      );
    }
  }

  return {
    itemPriceId: settings.itemPriceId,
    name: price?.name ?? settings.itemPriceId,
    unitPriceMinor: price?.pricingModel === "per_unit" ? price.priceMinor : null,
    currencyCode: price?.currencyCode ?? null,
    presetAmounts: settings.presetAmounts,
    ...topUpQuantityLimits(price, settings),
  };
}
