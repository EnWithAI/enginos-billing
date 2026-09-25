/**
 * What each Chargebee webhook event does to a tenant's billing.
 *
 * Chargebee does NOT sign webhooks. It authenticates by sending HTTP Basic
 * credentials configured alongside the endpoint URL, and enginos-platform —
 * which receives the delivery and forwards it here — is what checks them.
 * Those credentials are the only thing standing between the internet and an
 * endpoint that grants credits; this service checks no caller at all.
 *
 * THERE IS NO LOCAL REPLAY GUARD. `processed_billing_event` used to claim each
 * event id before any work, and it is gone. What replaces it is that a
 * subscription event is ONLY A TRIGGER: the body names the customer, and
 * nothing else in it is believed. The handler re-reads that customer's
 * subscriptions from Chargebee and applies what Chargebee says now —
 * `syncFromChargebee`, the same pull the post-checkout callback and the daily
 * reconcile run.
 *
 * That is what makes every delivery convergent, not just a redelivery of the
 * same body. The handlers used to write the body's subscription id, item price
 * and term verbatim, so an OLD body arriving late — a `subscription_created`
 * Chargebee retried after a 500, delivered after the cancellation — re-activated
 * a cancelled account, re-managed its team on a prepaid cap and resumed billing
 * against a cancelled subscription, and a stale term rewound the dates a top-up
 * takes its expiry from. A `subscription_cancelled` for ANY of the customer's
 * subscriptions cancelled the tenant, even when the one it was linked to was
 * still live. Read from Chargebee, a late event finds the state that followed
 * it, and a cancellation cancels only when the linked subscription has ended.
 *
 * The writes that are not merely convergent are guarded where they are:
 *   - the billing cursor is laid create-only, and only moved forward on a
 *     resubscription (account.service.ts), so a replay can never rewind it.
 *   - `applyPaidTopUps` scans the subscription's ledger operations for the
 *     invoice id before allocating, and `allocate` carries a
 *     `chargebee-idempotency-key`, so a paid pack grants once.
 *
 * A FAILED HANDLER THROWS, and the controller answers 500 (see
 * webhook.controller.ts): with no local record of the event, a 200 on failure
 * would be a webhook silently dropped. Chargebee retries a non-2xx and, when it
 * gives up, shows the event as failed in its own dashboard — its delivery log
 * is now the audit trail this service no longer keeps.
 */

import type { BillingAccountRepository } from "../repositories/billing-account.repository";
import type { Logger } from "../shared/logger";
import type { AccountService } from "./account.service";

/** The error a handler throws when the event's customer maps to no billing account. */
const UNMAPPED_CUSTOMER = "unmapped customer";

export interface ChargebeeEvent {
  id?: string;
  event_type?: string;
  content?: {
    customer?: { id?: string };
    subscription?: {
      id?: string;
      customer_id?: string;
      status?: string;
      current_term_start?: number;
      current_term_end?: number;
      subscription_items?: Array<{ item_price_id?: string }>;
    };
  };
}

export function createWebhookService(deps: {
  accountService: AccountService;
  accounts: BillingAccountRepository;
  logger?: Logger;
}) {
  const log = deps.logger ?? console;
  const accounts = deps.accountService;

  async function handle(event: ChargebeeEvent) {
    const subscription = event.content?.subscription;

    const customerId = subscription?.customer_id ?? event.content?.customer?.id;
    const tenantId = customerId ? await resolveTenant(customerId) : null;

    /**
     * For an event we act on, a customer that maps to no account is a failure,
     * not a no-op: thrown, it answers 500 and Chargebee delivers it again.
     */
    const mapped = (): string => {
      if (!tenantId) throw new Error(UNMAPPED_CUSTOMER);
      return tenantId;
    };

    switch (event.event_type) {
      // Every one of these means "this customer's subscriptions changed", and
      // that is all it is taken to mean — see the header. Re-running it is
      // harmless: it re-reads Chargebee and sets the link, the term and the cap
      // to what Chargebee says. Nothing here adds. A trial converting to paid
      // arrives as `activated`; a renewal is recognised by its term moving on.
      case "subscription_created":
      case "subscription_activated":
      case "subscription_changed":
      case "subscription_renewed":
      case "subscription_reactivated":
      case "subscription_resumed":
      case "subscription_cancelled":
      case "subscription_deleted": {
        if (!subscription?.customer_id) return;
        await accounts.syncFromChargebee(mapped());
        return;
      }

      // Dunning is Chargebee's job, and revoking credits already granted is a
      // business decision, not a webhook handler's. Record and move on.
      case "payment_failed":
      case "alert_status_changed":
        if (customerId) mapped();
        log.warn?.(
          { metric: `billing.webhook.${event.event_type}`, eventId: event.id, tenantId },
          "Billing signal received",
        );
        return;

      default:
        return;
    }
  }

  /**
   * The Chargebee customer id IS the tenant id — we supply it at creation. The
   * lookup exists anyway so a customer created by hand in the dashboard, with a
   * Chargebee-generated id, resolves to nothing rather than to the wrong tenant.
   */
  async function resolveTenant(customerId: string): Promise<string | null> {
    const tenantId = await deps.accounts.findTenantIdByCustomerId(customerId);
    if (tenantId) return tenantId;

    log.error?.(
      { metric: "billing.webhook.unmapped_customer", customerId },
      "Chargebee customer maps to no billing account",
    );
    return null;
  }

  return { handle };
}

export type WebhookService = ReturnType<typeof createWebhookService>;

