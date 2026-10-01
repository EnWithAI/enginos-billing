/**
 * Chargebee's self-serve portal for a tenant's customer.
 *
 * Scoped to the customer resolved from the tenant, never from the request, so
 * one org's admin cannot open another org's portal.
 *
 * WHERE THE BILLING ADDRESS IS ENTERED (A29). The billing page opens the
 * portal's billing-address section with Chargebee.js on a session from here,
 * and the address it saves decides the org's currency (billing-address.
 * service.ts). An org asks for that BEFORE it subscribes — a paid checkout
 * needs the address first — so a tenant with no Chargebee customer yet (one
 * onboarding never reached) gets one made here, as checkout used to make it.
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
  /**
   * BILLING_ADDRESS_EDIT_ENABLED. Off, an org that has saved a billing
   * address gets no session: the portal is only where the address is edited,
   * so the first one is added and nothing after. Absent: editing allowed.
   */
  addressEditEnabled?: boolean;
  /**
   * The tenant's Chargebee customer, created if missing (checkout.service
   * customerFor): never twice, and a 404 `tenant-not-found` for a tenant the
   * platform does not know. Absent: a tenant with no customer has nothing to
   * open (404 `no-customer`).
   */
  customerFor?: (tenantId: string) => Promise<string>;
  logger?: Logger;
}) {
  const log = deps.logger ?? console;

  async function open(tenantId: string) {
    if (!deps.enabled) {
      log.warn?.({ metric: "billing.portal.refused", tenantId }, "The self-serve portal is turned off (CHARGEBEE_PORTAL_ENABLED)");
      throw conflict("The billing portal is not available", "portal-off");
    }

    const account = await deps.accounts.findByTenantId(tenantId);
    if (deps.addressEditEnabled === false && account?.billingCountry) {
      log.warn?.({ metric: "billing.portal.address_edit_refused", tenantId }, "Billing address editing is turned off (BILLING_ADDRESS_EDIT_ENABLED)");
      throw conflict("The billing address cannot be changed", "address-edit-off");
    }
    const customerId = account?.chargebeeCustomerId ?? (deps.customerFor ? await deps.customerFor(tenantId) : null);
    if (!customerId) throw notFound("No billing customer yet", "no-customer");

    try {
      return await deps.chargebee.portalSession({
        customerId,
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
