/**
 * The smaller response payloads — each one the shape crewpe-ui already reads.
 */

import type { InvoiceDownload } from "../integrations/chargebee";
import type { BillingAccount } from "../repositories/billing-account.repository";

/** After a checkout: whether a subscription is now linked. No credit figures — those are the overview's. */
export function renderSubscriptionSync(account: BillingAccount | null) {
  // No subscription yet is a real answer, not a failure — the customer may
  // simply not have finished checkout.
  if (!account) return { linked: false, reason: "no active subscription" };
  return {
    linked: true,
    status: account.status,
    subscriptionId: account.chargebeeSubscriptionId,
    itemPriceId: account.chargebeeItemPriceId,
  };
}

/** A pre-signed, perishable link — a bearer credential while it lives. */
export function renderInvoiceDownload(download: InvoiceDownload) {
  return { url: download.url, validTill: download.validTillMs };
}

/** Headers for a response carrying a short-lived credential: no cache may keep it. */
export const NO_STORE = { "Cache-Control": "no-store" } as const;
