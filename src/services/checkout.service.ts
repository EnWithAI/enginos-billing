/**
 * Buying: the subscription checkout, and the top-up that adds credits to it.
 *
 * SUBSCRIPTION. The customer is ensured first, with `id = tenantId`, so the
 * subscription belongs to a customer our webhook can map back to a tenant.
 * That is the whole reason checkout is created server-side rather than with
 * Chargebee's attribute drop-in: the drop-in sends no customer, Chargebee
 * creates a fresh one, and the webhook cannot tell whose credits they are.
 *
 * TOP-UP. Payment and granting are separate events. We create the page, the
 * customer pays on Chargebee's side, and only then — with a paid invoice as
 * proof — are credits allocated (`applyTopUps`). Granting on "checkout opened"
 * would hand out credits for abandoned carts.
 */

import type { ChargebeeClient, ChargebeeError } from "../integrations/chargebee";
import { ACCOUNT } from "../models/account-status";
import type { BillingAccount, BillingAccountRepository } from "../repositories/billing-account.repository";
import { conflict, invalid, notFound, upstream } from "../shared/errors";
import type { Logger } from "../shared/logger";
import type { AccountService } from "./account.service";

export function createCheckoutService(deps: {
  chargebee: ChargebeeClient;
  accountService: AccountService;
  accounts: BillingAccountRepository;
  /** The plans checkout may sell. An allowlist, not a menu — see config/config.ts. */
  itemPriceIds: string[];
  defaultItemPriceId: string;
  topUpItemPriceId: string;
  topUpCredits: string;
  logger?: Logger;
}) {
  const log = deps.logger ?? console;

  async function startSubscription(tenantId: string, requestedItemPriceId?: string) {
    const itemPriceId = requestedItemPriceId ?? deps.defaultItemPriceId;

    // A security control, not a menu. Without it a tampered request could
    // subscribe this tenant to any item price in the catalogue.
    if (!deps.itemPriceIds.includes(itemPriceId)) throw invalid("Unknown plan", "plan-not-offered");

    // Idempotent on both counts: the local row is upserted, and the Chargebee
    // customer id is the tenant id, so a repeat finds the existing customer.
    // First checkout is the earliest moment we are certain the tenant wants to
    // be billed — the platform does not know this service exists.
    const existing = await deps.accounts.findByTenantId(tenantId);
    const linked = existing
      ? await deps.accountService.ensureCustomer({
          tenantId: existing.tenantId,
          routingSlug: existing.routingSlug,
          billingEmail: existing.billingEmail ?? undefined,
        })
      : await deps.accountService.bootstrapFromTenant(tenantId);

    // No such tenant in the platform's own table — not our row to invent.
    if (!linked) throw notFound("Unknown tenant", "tenant-not-found");
    if (!linked.chargebeeCustomerId) {
      throw upstream("Could not create the billing customer", "customer-unavailable");
    }

    return deps.chargebee.checkoutPage({ customerId: linked.chargebeeCustomerId, itemPriceId });
  }

  async function startTopUp(tenantId: string) {
    const account = await subscribedAccount(tenantId);

    try {
      const hostedPage = await deps.chargebee.checkoutOneTime({
        customerId: account.chargebeeCustomerId!,
        itemPriceId: deps.topUpItemPriceId,
      });
      return { hostedPage, credits: deps.topUpCredits };
    } catch (err) {
      // A site-configuration problem, not an outage: Chargebee refuses until
      // one-time checkout is turned on under Settings > Configure Chargebee >
      // Checkout & Self-Serve Portal. Reporting it as a generic failure sends
      // someone hunting for a defect that is not in the code.
      if (isOneTimeCheckoutDisabled(err as ChargebeeError)) {
        log.error?.({ metric: "billing.topup.disabled", tenantId }, "One-time checkout is disabled for this Chargebee site");
        throw conflict("One-time checkout is disabled for this Chargebee site", "topup-disabled");
      }
      // Also a catalogue problem, not an outage. MEASURED on the test site: the
      // pack's item price carries its own Credit Grant, and Chargebee refuses
      // a hosted one-off checkout for a charge with a grant. The fix is in the
      // catalogue (docs/BILLING-ARCHITECTURE.md §10), and until it is made no
      // customer can buy a pack — so it is named, not a generic 502.
      if (isChargeWithGrant(err as ChargebeeError)) {
        log.error?.(
          { metric: "billing.topup.pack_carries_grant", tenantId, itemPriceId: deps.topUpItemPriceId },
          "The top-up item price carries its own Credit Grant, which one-off checkout refuses. Remove the grant from the pack in the Chargebee catalogue",
        );
        throw conflict("Top-ups are not configured correctly; please contact support", "topup-misconfigured");
      }
      throw err;
    }
  }

  /**
   * Grant credits for every PAID top-up invoice not yet applied.
   *
   * A CANCELLED account is still refused with the 409 — but only after the
   * account service has looked for packs paid anyway. A customer who opened
   * the top-up checkout before the cancellation and paid after it has given
   * us money for nothing, and that is raised as an error naming the invoices
   * (`billing.topup.refused_cancelled`) so someone refunds it, rather than
   * disappearing into a 409.
   */
  async function applyTopUps(tenantId: string) {
    const account = await deps.accounts.findByTenantId(tenantId);
    if (!account?.chargebeeSubscriptionId) throw noSubscription();
    // applyPaidTopUps allocates nothing to a cancelled account; it raises the alert.
    const result = await deps.accountService.applyPaidTopUps(tenantId, deps.topUpItemPriceId, deps.topUpCredits);
    if (account.status === ACCOUNT.CANCELLED) throw subscriptionCancelled();
    return result;
  }

  /**
   * A top-up adds to an existing ledger; without a live subscription there is
   * none to add to.
   *
   * A CANCELLED account still carries its subscription id, so the id alone
   * would let it buy credits — and the allocation's activate() would reopen a
   * LiteLLM team whose usage the sync no longer bills, because it skips
   * cancelled accounts. Refused before the customer pays, with its own code so
   * the page can offer the plans again instead of "Buy more credits".
   */
  async function subscribedAccount(tenantId: string): Promise<BillingAccount> {
    const account = await deps.accounts.findByTenantId(tenantId);
    if (!account?.chargebeeSubscriptionId) throw noSubscription();
    if (account.status === ACCOUNT.CANCELLED) throw subscriptionCancelled();
    return account;
  }

  return { startSubscription, startTopUp, applyTopUps };
}

const noSubscription = () => conflict("Subscribe before topping up", "no-subscription");
const subscriptionCancelled = () =>
  conflict("Your subscription has ended — subscribe again to add credits", "subscription-cancelled");

function isOneTimeCheckoutDisabled(err: ChargebeeError): boolean {
  return err.apiErrorCode === "invalid_request" && /one time checkout is not enabled/i.test(err.message ?? "");
}

/** "Charges with grants are not supported for customer one off charges" — measured, 2026-09-24. */
function isChargeWithGrant(err: ChargebeeError): boolean {
  return /charges with grants are not supported/i.test(err.message ?? "");
}

export type CheckoutService = ReturnType<typeof createCheckoutService>;
