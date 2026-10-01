/**
 * The billing page payload crewpe-ui renders.
 *
 * ONE SHAPE for every state, so the page never has to guess which fields
 * exist: an unlinked tenant gets the same keys with empty values. Returning 404
 * for "no billing row" once left `site` null, so Chargebee.js never loaded and
 * the Subscribe button stayed disabled. That includes the billing address and
 * currency keys (§1.1): the page asks for the address first in EVERY state —
 * unlinked, activating, switching or linked — and a key missing from one of
 * them would read, to the page, as a billing too old to have it (A26).
 */

import type { Transaction } from "../integrations/chargebee";
import { ACCOUNT } from "../models/account-status";
import type { BillingOverview, CurrencyFacts, LastSync, SubscriptionDetails } from "../services/billing-overview.service";
import type { TopUpOffer } from "../services/plan-catalog.service";

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
  const currency = renderCurrency(overview);
  const empty = {
    site: config.site,
    plansOffered: overview.plansOffered,
    // Whether this org is put on the free plan. With no subscription, false
    // means the page offers `plansOffered` instead of waiting for one.
    freePlan: overview.freePlan,
    status: ACCOUNT.UNLINKED as string,
    plan: { itemPriceId: config.defaultItemPriceId },
    term: { start: null as Date | null, end: null as Date | null },
    credits: { unit: null as string | null, ...NO_CREDIT_FIGURES },
    lastSync: null,
    // An empty list, not null: a tenant with no subscription has genuinely made
    // no payments, which is different from "we could not find out".
    payments: [] as unknown[] | null,
    paymentsNextOffset: null as string | null,
    subscription: null,
    // Only a linked subscription can be topped up.
    topUp: null as TopUpOffer | null,
    unpaidTopUps: [] as unknown[] | null,
    ...currency,
  };

  if (overview.kind === "unlinked") return empty;

  const { account } = overview;
  const plan = { itemPriceId: account.chargebeeItemPriceId ?? config.defaultItemPriceId };
  const term = { start: account.currentTermStart, end: account.currentTermEnd };

  // Paid, but the gateway does not hold the budget yet — or a currency switch
  // is moving the credits to a subscription in another currency. Showing the
  // credits would promise service that is blocked, or figures half-way
  // between two subscriptions; they appear once it turns active.
  if (overview.kind === "activating" || overview.kind === "switching") {
    return {
      ...empty,
      plan,
      status: overview.kind === "switching" ? ACCOUNT.SWITCHING : ACCOUNT.ACTIVATING,
      term,
      credits: { unit: account.ledgerUnitId, ...NO_CREDIT_FIGURES },
    };
  }

  return {
    site: config.site,
    plansOffered: overview.plansOffered,
    freePlan: overview.freePlan,
    status: account.status,
    plan,
    term,
    credits: { unit: account.ledgerUnitId, ...overview.credits },
    lastSync: renderLastSync(overview.lastSync),
    // NULL (not []) when Chargebee could not be reached, so the page can say
    // "we could not load these" instead of the flatly wrong "no payments yet".
    payments: overview.payments?.map(renderPayment) ?? null,
    paymentsNextOffset: overview.payments ? overview.paymentsNextOffset : null,
    subscription: renderSubscription(account.chargebeeSubscriptionId, overview.subscription),
    topUp: overview.topUp,
    // Null when Chargebee could not be asked — the page must not say "nothing owed".
    unpaidTopUps:
      overview.unpaidTopUps?.map((invoice) => ({
        invoiceId: invoice.id,
        status: invoice.status,
        // MINOR units, like payments.
        amountDueMinor: invoice.amountDueMinor,
        currencyCode: invoice.currencyCode,
        nextRetryAt: invoice.nextRetryAt,
      })) ?? null,
    ...currency,
  };
}

/**
 * The billing address and currency keys (§1.1), the same for every kind. The
 * address is the ten fields of the page's form — never the email, phone or
 * third line Chargebee also holds — and a switch's time is when it reached
 * its state.
 */
function renderCurrency(facts: CurrencyFacts) {
  return {
    billingCountry: facts.billingCountry,
    billingAddress: facts.billingAddress,
    currency: facts.currency,
    currencyRules: facts.currencyRules,
    currencySwitch: facts.currencySwitch
      ? {
          fromCurrency: facts.currencySwitch.fromCurrency,
          toCurrency: facts.currencySwitch.toCurrency,
          state: facts.currencySwitch.state,
          reason: facts.currencySwitch.reason,
          since: facts.currencySwitch.since,
        }
      : null,
    currencyLocked: facts.currencyLocked,
    currencyChange: facts.currencyChange,
    plansMissingForCurrency: facts.plansMissingForCurrency,
    addressEditable: facts.addressEditable,
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

/** One later page of the payment history, and the cursor for the page after it. */
export function renderPaymentsPage(page: { transactions: Transaction[]; nextOffset: string | null }) {
  return { payments: page.transactions.map(renderPayment), nextOffset: page.nextOffset };
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
