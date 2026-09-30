/**
 * The shapes the Chargebee client speaks, narrowed to what this service reads.
 */

import type { Logger } from "../../shared/logger";
import type { CaptureResult } from "./errors";

/**
 * A plan as Chargebee describes it, for the checkout page to render.
 *
 * MEASURED against the live site: `price` is in the currency's MINOR unit
 * (`10000` for ₹100.00), so it must not be rendered raw. `external_name` is the
 * customer-facing label and `name` the internal one, which carries the currency
 * and period appended — hence the preference order in `itemPrice()`.
 *
 * Deliberately NOT here: the credit grant amount. It is configured on the item
 * price but this API version returns it on neither `/item_prices/{id}` nor
 * `/items/{id}`, and there is no `/item_price_credit_grants` endpoint (404).
 * Credits become visible only as `grant_blocks` once a subscription exists.
 */
export interface ItemPrice {
  id: string;
  /** Customer-facing name; falls back to the internal one, then to the id. */
  name: string;
  /** Minor units, e.g. paise. Null for a price Chargebee does not quote here. */
  priceMinor: number | null;
  currencyCode: string | null;
  /** `period` × `periodUnit` — 1 × "month". */
  period: number | null;
  periodUnit: string | null;
  /**
   * `per_unit`, `flat_fee`, `tiered`, `volume` or `stairstep`. Only `per_unit`
   * makes `priceMinor` the price of ONE unit, which is what a top-up quantity
   * multiplies. Optional so fakes that predate it still type-check.
   */
  pricingModel?: string | null;
}

export interface LedgerBalance {
  unitId: string;
  unitName: string;
  usable: string;
  onHold: string;
  /** How many credit units the subscription holds. More than one means a unit was CHOSEN — see balance(). */
  unitCount?: number;
}

/**
 * One ledger operation, narrowed to what the top-up guard reads.
 *
 * MEASURED on the test site: an allocation's `created_at` (and
 * `ledger_operation_timestamp`) is the same second as the `created_at` of the
 * grant block it made — op 2082089061337649922 and block B0FYuUVW8TAKdE2 are
 * both 1790248715. That is what ties an operation to its block.
 */
export interface LedgerOperation {
  id: string;
  type: string;
  subscriptionId: string | null;
  unitId: string | null;
  /** Plain decimal string. */
  amount: string | null;
  createdAtMs: number | null;
}

/**
 * One grant block, narrowed to what the top-up guard reads.
 *
 * `invoices` is what makes a pack whose item price carries its OWN Credit
 * Grant recognisable as already granted — see grantBlockInvoiceRefs().
 */
export interface GrantBlock {
  id: string;
  subscriptionId: string;
  unitId: string;
  /** Plain decimal string. */
  grantedAmount: string;
  status: string;
  /** `grant_source`: subscription_created, top_up, promotional_grants, … */
  source: string | null;
  createdAtMs: number | null;
  invoices: Array<{ invoiceId: string | null; lineItemId: string | null }>;
  itemPriceId: string | null;
  doneBy: string | null;
}

/**
 * One movement of real money: a payment, or a refund of one.
 *
 * This is what a customer means by "my payments", and it is deliberately NOT an
 * invoice. An invoice is what we ASKED for; a transaction is what the gateway
 * actually did, which is the only place a FAILED attempt is visible at all — a
 * declined card leaves the invoice sitting at `payment_due` and says nothing
 * about why, while the transaction carries `status: failure` and `error_text`.
 *
 * MEASURED against the live site: amounts are in the currency's MINOR unit
 * (1000000 = Rs 10,000.00 for INR) and `date` is epoch SECONDS, so neither can
 * be rendered raw. `masked_card_number` arrives as "************1111".
 */
export interface Transaction {
  id: string;
  /** payment | refund | authorization | payment_reversal */
  type: string;
  /** success | failure | timeout | needs_attention | voided */
  status: string;
  /** MINOR units. Scale by the currency's decimals before display. */
  amountMinor: number;
  currencyCode: string | null;
  /** Epoch ms, converted here so no caller has to remember the seconds. */
  atMs: number | null;
  /** card | paypal | bank_transfer | … */
  method: string | null;
  maskedCardNumber: string | null;
  /** Why it failed. Null on success — the presence of this IS the failure signal. */
  errorText: string | null;
  /** The invoices this payment was applied to. */
  invoiceIds: string[];
}

/**
 * Just enough of an invoice to prove who it belongs to.
 *
 * Deliberately narrow. The download route needs exactly one fact — the owning
 * customer — and returning the whole record would invite a caller to render
 * fields off it without checking that first.
 */
export interface InvoiceRef {
  id: string;
  customerId: string | null;
  status: string | null;
}

/** A short-lived, pre-signed link to the invoice PDF. */
export interface InvoiceDownload {
  url: string;
  /** Epoch ms after which the link is dead, so the caller does not cache it. */
  validTillMs: number | null;
}

/** The card Chargebee will charge next. */
export interface PaymentSource {
  id: string;
  /** card | paypal_express_checkout | direct_debit | … */
  type: string;
  /** valid | expiring | expired | invalid | pending_verification */
  status: string;
  brand: string | null;
  last4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
}

/** The invoice a charge created. `status` is Chargebee's: `paid` once collected. */
export interface ChargedInvoice {
  id: string;
  status: string;
  /** MINOR units of the currency. */
  totalMinor: number | null;
  amountDueMinor: number | null;
  currencyCode: string | null;
  /**
   * When Chargebee next retries the card, for an invoice it could not collect
   * (dunning). Null once paid, or when no retry is scheduled.
   */
  nextRetryAt: Date | null;
}

/** A top-up invoice Chargebee has not collected: `payment_due` while it retries, `not_paid` once it gave up. */
export interface UnpaidInvoice {
  id: string;
  status: string;
  /** MINOR units of the currency. */
  amountDueMinor: number;
  currencyCode: string | null;
  nextRetryAt: Date | null;
  date: Date | null;
}

export interface CaptureArgs {
  id: string;
  subscriptionId: string;
  unitId: string;
  amount: string;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface ChargebeeClient {
  createCustomer(args: { id: string; email?: string; company?: string }): Promise<{ id: string }>;
  capture(args: CaptureArgs): Promise<CaptureResult>;
  captureIdempotent(args: CaptureArgs): Promise<CaptureResult>;
  findOperation(id: string, subscriptionId: string): Promise<{ id: string } | null>;
  /** One unit's balance: `unitId`'s when given (always, once the account has one), else the subscription's oldest unit. */
  balance(subscriptionId: string, unitId?: string | null): Promise<LedgerBalance | null>;
  /** Every credit unit the subscription holds a ledger account in; empty when it has no ledger. */
  ledgerUnits(subscriptionId: string): Promise<string[]>;
  checkoutPage(args: {
    customerId: string;
    itemPriceId: string;
    quantity?: number;
    /** Where Chargebee sends the browser once the checkout is done. Omit it when Chargebee.js opens the page. */
    redirectUrl?: string;
  }): Promise<Record<string, unknown>>;
  portalSession(args: { customerId: string; redirectUrl: string }): Promise<Record<string, unknown>>;
  /** A hosted page where the customer manages their cards — no cancellation, unlike the portal. */
  managePaymentSourcesPage(args: { customerId: string; redirectUrl: string }): Promise<Record<string, unknown>>;
  grantedCredits(subscriptionId: string, unitId?: string, now?: number): Promise<{ credits: string; blocks: number }>;
  /** Every grant block on the subscription, oldest first, with the invoice that issued each. */
  grantBlocks(subscriptionId: string): Promise<{ blocks: GrantBlock[]; complete: boolean }>;
  /** One page of the subscription's ledger operations, newest first. Read by scripts/e2e-prepaid.ts only. */
  ledgerOperations(subscriptionId: string, limit?: number): Promise<Array<Record<string, any>>>;
  /** One ledger operation by id (GET /ledger_operations/{id}). Null only on a definite 404. */
  ledgerOperation(id: string): Promise<LedgerOperation | null>;
  /** One subscription, any status. Null only on a definite 404; anything else unclear throws. */
  subscription(id: string): Promise<Record<string, unknown> | null>;
  /** One customer. Null only on a definite 404. */
  customer(id: string): Promise<{ id: string } | null>;
  /** Every subscription id the customer has, whatever its status. */
  subscriptionIdsOf(customerId: string): Promise<string[]>;
  /** One plan's details. Null when the id is not in the catalogue. */
  itemPrice(id: string): Promise<ItemPrice | null>;
  activeSubscriptions(customerId: string): Promise<Array<Record<string, any>>>;
  /** Subscribe a customer with no checkout — the free plan only. Idempotent per key. */
  subscribeCustomer(args: {
    customerId: string;
    itemPriceId: string;
    idempotencyKey: string;
  }): Promise<Record<string, unknown>>;
  allocate(args: {
    subscriptionId: string;
    unitId: string;
    amount: string;
    expiresAt: number;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ operationId: string; balanceAfter: string | null; createdAtMs: number | null }>;
  /** Invoice units of a charge item onto a subscription and collect it now. Never retried. */
  chargeItem(args: {
    subscriptionId: string;
    itemPriceId: string;
    /** Units of the charge to sell. Defaults to 1. */
    quantity?: number;
  }): Promise<ChargedInvoice>;
  /** Charge the card on file for an invoice Chargebee has not collected. Never retried. */
  collectInvoice(invoiceId: string): Promise<ChargedInvoice>;
  paidInvoicesFor(customerId: string, itemPriceId: string): Promise<Array<Record<string, any>>>;
  /** The customer's uncollected invoices with a line for this item price, oldest first. */
  unpaidInvoicesFor(customerId: string, itemPriceId: string): Promise<UnpaidInvoice[]>;
  /**
   * Credits Chargebee granted for top-ups whose invoice is NOT paid — for the
   * caller to hold back from the balance and the gateway cap. Plain decimal.
   */
  unpaidTopUpCredits(args: {
    customerId: string;
    subscriptionId: string;
    unitId?: string;
    itemPriceId: string;
    now?: number;
  }): Promise<string>;
  /** One page of payments, newest first, and the opaque cursor for the next (null at the end). */
  transactionsPage(
    customerId: string,
    page?: { limit?: number; offset?: string },
  ): Promise<{ transactions: Transaction[]; nextOffset: string | null }>;
  /** The card on file, or null when the customer has none. */
  paymentSource(customerId: string): Promise<PaymentSource | null>;
  /** One invoice, narrowed to its ownership. Null when Chargebee does not have it. */
  invoice(invoiceId: string): Promise<InvoiceRef | null>;
  /** Mint a download link for an invoice PDF. Null when the invoice is unknown. */
  invoicePdfUrl(invoiceId: string): Promise<InvoiceDownload | null>;
}

export interface ChargebeeOptions {
  /** Where the client reports what it notices but does not throw for. Defaults to `console`. */
  logger?: Logger;
  site?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}
