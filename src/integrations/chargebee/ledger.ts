/**
 * Reading Chargebee's ledger records: which grant blocks still count, and
 * which paid invoice issued a grant block.
 */

/**
 * Is this grant block still part of what the customer can spend?
 *
 * Only `status: "available"` is documented, so the test is written the safe way
 * round: a block is live if it does not SAY it is finished and its expiry has
 * not passed. A status Chargebee introduces later that means "gone" would
 * otherwise quietly inflate the LiteLLM cap.
 */
export function isLiveGrantBlock(block: Record<string, any>, now: number = Date.now()): boolean {
  const status = String(block.status ?? "available").toLowerCase();
  if (status === "expired" || status === "invalidated" || status === "cancelled" || status === "deleted") {
    return false;
  }
  const expiresAt = Number(block.expires_at ?? 0);
  if (expiresAt > 0 && expiresAt * 1000 <= now) return false;
  return true;
}

/** What a grant block says about where it came from. */
export interface GrantBlockOrigin {
  /** The invoices (and their line items) whose purchase issued this block. Empty for an allocation or a manual grant. */
  invoices: Array<{ invoiceId: string | null; lineItemId: string | null }>;
  /** The item price whose Credit Grant issued it; null for an allocation or a manual grant. */
  itemPriceId: string | null;
  /** `metadata.done_by`: the API key's name for an allocation, a person's email for a grant made by hand. */
  doneBy: string | null;
}

/**
 * Where a grant block came from, read from its `billing_metadata` and
 * `metadata` — both JSON STRINGS on the wire, and either may be absent or
 * malformed, in which case the block simply names no invoice.
 *
 * MEASURED on the test site (2026-09-24):
 *
 *   issued by an item price's Credit Grant (plan or charge):
 *     billing_metadata = {"line_items":[{"id":"li_AzyXeMVW8T9lrRt8","invoice_number":"85","quantity":1}],
 *                         "item_price_id":"test-top-up-INR"}
 *   made by POST /ledger_operations/allocate:
 *     billing_metadata = {"line_items":null,"item_price_id":null}
 *     metadata         = {"done_by":"full_access_key_v1"}      ← ours is dropped
 *   made by hand in the Chargebee UI:
 *     metadata         = {"done_by":"someone@example.com"}
 *
 * This replaces `allocationInvoiceId()`, which read `metadata.invoice_id` off a
 * ledger operation. Chargebee accepts that metadata on allocate and never
 * returns it — not on the list, not on retrieve — so the top-up guard built on
 * it never matched anything (known defect #1, docs/BILLING-ARCHITECTURE.md §10).
 */
export function grantBlockInvoiceRefs(block: Record<string, any>): GrantBlockOrigin {
  const billing = parseJsonObject(block.billing_metadata);
  const metadata = parseJsonObject(block.metadata);
  const lineItems: Array<Record<string, any>> = Array.isArray(billing.line_items) ? billing.line_items : [];
  return {
    invoices: lineItems
      .filter((li) => li && typeof li === "object")
      .map((li) => ({
        invoiceId: li.invoice_number == null ? null : String(li.invoice_number),
        lineItemId: li.id == null ? null : String(li.id),
      })),
    itemPriceId: billing.item_price_id == null ? null : String(billing.item_price_id),
    doneBy: metadata.done_by == null ? null : String(metadata.done_by),
  };
}

/**
 * Was this grant block issued for a top-up whose invoice is NOT settled —
 * owed, abandoned by dunning, voided or pending (`unsettledInvoiceIds`)?
 *
 * Chargebee grants a pack with its INVOICE, paid or not (MEASURED
 * 2026-09-28), so such a block's credits are not the customer's. The ONE rule
 * for it: unpaidTopUpCredits holds these back from the balance and the cap,
 * and a currency switch leaves them on the old subscription rather than carry
 * them across as paid credits. Takes a raw block's grantBlockInvoiceRefs() and
 * a mapped GrantBlock alike — both carry the item price and the invoices.
 */
export function isUnsettledTopUpGrant(
  block: { itemPriceId: string | null; invoices: Array<{ invoiceId: string | null }> },
  unsettledInvoiceIds: ReadonlySet<string>,
  topUpItemPriceIds: readonly string[],
): boolean {
  return (
    block.itemPriceId != null &&
    topUpItemPriceIds.includes(block.itemPriceId) &&
    block.invoices.some((ref) => ref.invoiceId != null && unsettledInvoiceIds.has(ref.invoiceId))
  );
}

function parseJsonObject(value: unknown): Record<string, any> {
  if (value != null && typeof value === "object") return value as Record<string, any>;
  if (typeof value !== "string" || value === "") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed != null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
