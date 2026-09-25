/**
 * The billing page payload crewpe-ui renders.
 *
 * ONE SHAPE for every state, so the page never has to guess which fields
 * exist: an unlinked tenant gets the same keys with empty values. Returning 404
 * for "no billing row" once left `site` null, so Chargebee.js never loaded and
 * the Subscribe button stayed disabled.
 */

import type { Transaction } from "../integrations/chargebee";
import { ACCOUNT } from "../models/account-status";
import type { BillingOverview, LastSync, SubscriptionDetails } from "../services/billing-overview.service";

export interface BillingViewConfig {
  /**
   * Needed by Chargebee.js in the browser. Not a secret — hosted pages and the
   * portal authenticate by site name alone.
   */
  site: string;
  defaultItemPriceId: string;
}

const NO_CREDIT_FIGURES = { granted: "0", allocated: "0", consumed: "0", current: "0" };

export function renderBillingOverview(overview: BillingOverview, config: BillingViewConfig) {
  const empty = {
    site: config.site,
    plansOffered: overview.plansOffered,
    status: ACCOUNT.UNLINKED as string,
    plan: { itemPriceId: config.defaultItemPriceId },
    term: { start: null as Date | null, end: null as Date | null },
    credits: { unit: null as string | null, ...NO_CREDIT_FIGURES },
    lastSync: null,
    // An empty list, not null: a tenant with no subscription has genuinely made
    // no payments, which is different from "we could not find out".
    payments: [] as unknown[] | null,
    subscription: null,
  };

  if (overview.kind === "unlinked") return empty;

  const { account } = overview;
  const plan = { itemPriceId: account.chargebeeItemPriceId ?? config.defaultItemPriceId };
  const term = { start: account.currentTermStart, end: account.currentTermEnd };

  // Paid, but the gateway does not hold the budget yet. Showing the credits
  // would promise service that is blocked; they appear once it turns active.
  if (overview.kind === "activating") {
    return {
      ...empty,
      plan,
      status: ACCOUNT.ACTIVATING,
      term,
      credits: { unit: account.ledgerUnitId, ...NO_CREDIT_FIGURES },
    };
  }

  return {
    site: config.site,
    plansOffered: overview.plansOffered,
    status: account.status,
    plan,
    term,
    credits: { unit: account.ledgerUnitId, ...overview.credits },
    lastSync: renderLastSync(overview.lastSync),
    // NULL (not []) when Chargebee could not be reached, so the page can say
    // "we could not load these" instead of the flatly wrong "no payments yet".
    payments: overview.payments?.map(renderPayment) ?? null,
    subscription: renderSubscription(account.chargebeeSubscriptionId, overview.subscription),
  };
}

function renderLastSync(sync: LastSync | null) {
  if (!sync) return null;
  return {
    at: sync.settledAt ?? sync.toIngestedAt,
    billedUsd: sync.billedUsd.toString(),
    credits: sync.amount.toString(),
    events: sync.eventCount,
  };
}

function renderPayment(t: Transaction) {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    // MINOR units, deliberately un-scaled: the currency's decimals decide the
    // divisor and the page already has `formatPrice` to apply them. Scaling
    // here would have to hardcode 100 and understate JPY 100x.
    amountMinor: t.amountMinor,
    currencyCode: t.currencyCode,
    at: t.atMs == null ? null : new Date(t.atMs),
    method: t.method,
    maskedCardNumber: t.maskedCardNumber,
    error: t.errorText,
    invoiceIds: t.invoiceIds,
  };
}

function renderSubscription(subscriptionId: string | null, details: SubscriptionDetails | null) {
  if (!subscriptionId || !details) return null;
  const { record, card } = details;
  const seconds = (v: unknown) => (typeof v === "number" ? new Date(v * 1000) : null);
  return {
    id: subscriptionId,
    // active | non_renewing | cancelled | in_trial | paused
    status: record.status == null ? null : String(record.status),
    // `non_renewing` is where a cancellation sits until the term ends — the
    // difference between "you have lost access" and "you have it until the
    // 30th". The page must be able to say which.
    cancelledAt: seconds(record.cancelled_at),
    nextBillingAt: seconds(record.next_billing_at),
    activatedAt: seconds(record.activated_at),
    card,
  };
}
