/**
 * Chargebee's Manage Payment Sources page for a tenant's customer: add,
 * replace or remove a card. Renewals and saved-card top-ups charge whichever
 * card it leaves as primary.
 *
 * This and not the self-serve portal, which stays shut because it offers
 * cancellation (portal.service.ts). This page offers card management only.
 *
 * Scoped to the customer resolved from the tenant, never from the request, so
 * one org's admin cannot reach another org's cards.
 */
import type { ChargebeeClient } from "../integrations/chargebee";
import type { BillingAccountRepository } from "../repositories/billing-account.repository";
import { notFound } from "../shared/errors";

export function createPaymentMethodService(deps: {
  chargebee: ChargebeeClient;
  accounts: BillingAccountRepository;
  /** Where Chargebee sends the browser back to — the billing page. Port 80, 443, 8080 or 8443 only. */
  redirectUrl: string;
}) {
  async function manage(tenantId: string) {
    const account = await deps.accounts.findByTenantId(tenantId);
    // No customer means no cards to manage — a "subscribe first" state, not an error.
    if (!account?.chargebeeCustomerId) throw notFound("No billing customer yet", "no-customer");

    return deps.chargebee.managePaymentSourcesPage({
      customerId: account.chargebeeCustomerId,
      redirectUrl: deps.redirectUrl,
    });
  }

  return { manage };
}
