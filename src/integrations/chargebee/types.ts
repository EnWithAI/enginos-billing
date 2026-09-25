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
  }): Promise<Record<string, unknown>>;
  portalSession(args: { customerId: string; redirectUrl: string }): Promise<Record<string, unknown>>;
  grantedCredits(subscriptionId: string, unitId?: string, now?: number): Promise<{ credits: string; blocks: number }>;
  /** Every grant block on the subscription, oldest first, with the invoice that issued each. */
  grantBlocks(subscriptionId: string): Promise<{ blocks: GrantBlock[]; complete: boolean }>;
  /** Chargebee's own record of what was granted and captured, newest first. */
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
  allocate(args: {
    subscriptionId: string;
    unitId: string;
    amount: string;
    expiresAt: number;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ operationId: string; balanceAfter: string | null; createdAtMs: number | null }>;
  checkoutOneTime(args: { customerId: string; itemPriceId: string; currencyCode?: string }): Promise<Record<string, unknown>>;
  paidInvoicesFor(customerId: string, itemPriceId: string): Promise<Array<Record<string, any>>>;
  /** Payments and refunds for a customer, newest first. */
  transactionsFor(customerId: string, limit?: number): Promise<Transaction[]>;
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
