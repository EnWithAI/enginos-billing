/**
 * A download link for one invoice PDF — and the ownership check that makes it safe.
 *
 * Chargebee invoice ids on this site are small sequential integers, trivially
 * enumerable, and an invoice carries a billing address and amounts. So the id
 * is never trusted: we load the requesting tenant's Chargebee customer, ask
 * Chargebee who owns the invoice, and compare.
 *
 * A mismatch is NOT FOUND, never forbidden. "Forbidden" would confirm the
 * invoice exists, which is half of what an enumeration wants; "not found" and
 * "not yours" must be indistinguishable from outside.
 *
 * A Chargebee failure is UPSTREAM, never not-found: an outage must not read as
 * "that invoice does not exist".
 */

import type { ChargebeeClient, InvoiceDownload } from "../integrations/chargebee";
import type { BillingAccountRepository } from "../repositories/billing-account.repository";
import { errorMessage, notFound, upstream } from "../shared/errors";
import type { Logger } from "../shared/logger";

export function createInvoiceService(deps: {
  chargebee: ChargebeeClient;
  accounts: BillingAccountRepository;
  logger?: Logger;
}) {
  const log = deps.logger ?? console;

  async function downloadLink(tenantId: string, invoiceId: string): Promise<InvoiceDownload> {
    const account = await deps.accounts.findByTenantId(tenantId);
    if (!account?.chargebeeCustomerId) throw notFound("No billing account");

    let owner: Awaited<ReturnType<ChargebeeClient["invoice"]>>;
    try {
      owner = await deps.chargebee.invoice(invoiceId);
    } catch (err) {
      log.error?.(
        { metric: "billing.invoice.lookup_failed", tenantId, invoiceId, err: errorMessage(err) },
        "Could not look up the invoice before minting a download link",
      );
      throw upstream("Could not reach Chargebee");
    }

    // The check. Both branches answer identically on purpose.
    if (!owner || owner.customerId !== account.chargebeeCustomerId) {
      if (owner) {
        // An invoice that exists and is not theirs. Not a typo — the one case
        // here worth alerting on.
        log.error?.(
          {
            metric: "billing.invoice.ownership_denied",
            tenantId,
            invoiceId,
            expectedCustomer: account.chargebeeCustomerId,
          },
          "Tenant asked for an invoice belonging to another customer; refused",
        );
      }
      throw notFound("Not found");
    }

    let download: InvoiceDownload | null;
    try {
      download = await deps.chargebee.invoicePdfUrl(invoiceId);
    } catch (err) {
      log.error?.(
        { metric: "billing.invoice.pdf_failed", tenantId, invoiceId, err: errorMessage(err) },
        "Chargebee would not mint a download link for this invoice",
      );
      throw upstream("Could not prepare the invoice");
    }

    if (!download) throw notFound("Not found");
    return download;
  }

  return { downloadLink };
}
