/**
 * Chargebee's self-serve portal for a tenant's customer.
 *
 * Scoped to the customer resolved from the tenant, never from the request, so
 * one org's admin cannot open another org's portal.
 *
 * SHUT UNLESS `enabled`. Customers must not be able to cancel, and the portal
 * offers cancellation unless it is switched off in the Chargebee site's
 * Self-Serve Portal settings, which nothing here can check. enginos-platform
 * proxies this route (POST /billing/portal), so it is reachable whether or not
 * the UI renders a button for it. See `portalEnabled` in config/config.ts.
 */

import type { ChargebeeClient, ChargebeeError } from "../integrations/chargebee";
import type { BillingAccountRepository } from "../repositories/billing-account.repository";
import { conflict, errorMessage, notFound } from "../shared/errors";
import type { Logger } from "../shared/logger";

export function createPortalService(deps: {
  chargebee: ChargebeeClient;
  accounts: BillingAccountRepository;
  /** Where Chargebee returns the browser afterwards. */
  redirectUrl: string;
  /** Set only once portal cancellation is switched off on the Chargebee site. */
  enabled: boolean;
  logger?: Logger;
}) {
  const log = deps.logger ?? console;

  async function open(tenantId: string) {
    if (!deps.enabled) {
      log.warn?.({ metric: "billing.portal.refused", tenantId }, "The self-serve portal is turned off (CHARGEBEE_PORTAL_ENABLED)");
      throw conflict("The billing portal is not available", "portal-off");
    }

    const account = await deps.accounts.findByTenantId(tenantId);

    // A portal with no customer behind it has nothing to show — a "subscribe
    // first" state, not an error.
    if (!account?.chargebeeCustomerId) throw notFound("No billing customer yet", "no-customer");

    try {
      return await deps.chargebee.portalSession({
        customerId: account.chargebeeCustomerId,
        redirectUrl: deps.redirectUrl,
      });
    } catch (err) {
      // A site-configuration problem, not an outage: Chargebee answers
      // `configuration_incompatible` until API access is enabled under
      // Settings > Configure Chargebee > Customer Portal.
      if ((err as ChargebeeError).apiErrorCode === "configuration_incompatible") {
        log.error?.(
          { metric: "billing.portal.disabled", tenantId, err: errorMessage(err) },
          "Chargebee portal API access is disabled for this site",
        );
        throw conflict("Customer portal access is disabled for this Chargebee site", "portal-disabled");
      }
      throw err;
    }
  }

  return { open };
}
