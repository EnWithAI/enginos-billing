/**
 * What each Chargebee webhook event does to a tenant's billing.
 *
 * Chargebee does NOT sign webhooks. It authenticates by sending HTTP Basic
 * credentials configured alongside the endpoint URL. Chargebee calls billing
 * directly, and the webhook route checks them before anything reaches this
 * file (controllers/webhook.controller.ts, http/webhook-auth.ts). Those
 * credentials are the only thing standing between the internet and an
 * endpoint that grants credits.
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
 *   - `applyPaidTopUps` claims a `topup_grant` row per paid pack invoice
 *     before allocating, so a pack grants once — however many
 *     `payment_succeeded` deliveries, and page callbacks, ask for it.
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
    invoice?: {
      id?: string;
      line_items?: Array<{ entity_id?: string }>;
    };
    /** `grant_blocks_created`: the blocks, each naming its subscription — and no customer. */
    grant_blocks?: Array<{ subscription_id?: string }>;
  };
}

export function createWebhookService(deps: {
  accountService: AccountService;
  accounts: BillingAccountRepository;
  /** The top-up charge, the credits one unit of it grants, and who grants them (config.ts). */
  topUp: { itemPriceId: string; creditsPerUnit: string; chargebeeGrants?: boolean };
  logger?: Logger;
}) {
  const log = deps.logger ?? console;
  const accounts = deps.accountService;

  async function handle(event: ChargebeeEvent) {
    const subscription = event.content?.subscription;

    const customerId = subscription?.customer_id ?? event.content?.customer?.id;

    // Chargebee's "Test Webhook" button sends SAMPLE data: a demo customer
    // (`cbdemo_tom`) that is no org's. Acknowledged and left alone, so the
    // button reports whether delivery and credentials work — an unknown REAL
    // customer still fails below (500), so Chargebee retries it. Ours never
    // collide: billing creates every customer with the tenant id as its id.
    if (customerId && isChargebeeSample(customerId)) {
      log.log?.(
        { metric: "billing.webhook.sample_event", eventId: event.id, eventType: event.event_type, customerId },
        "Chargebee sample event (Test Webhook); acknowledged, nothing done",
      );
      return;
    }

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

      // A top-up pack was paid. Only a trigger, like the rest: which invoices
      // are paid, and what they bought, is re-read from Chargebee, and the
      // `topup_grant` guard grants each once — so a redelivery, or the page's
      // own apply landing first, grants nothing twice. This is what grants a
      // pack whose buyer closed the tab before the checkout's success callback.
      // Any other payment (the plan, a renewal) is not a top-up: ignored.
      //
      // When Chargebee grants the pack itself, its grant block can trail the
      // payment by a second. Still missing, the delivery is failed on purpose:
      // Chargebee redelivers it later, by when the block is there to record —
      // a 200 now would leave the gateway cap unmoved until the next top-up.
      case "payment_succeeded": {
        const lines = event.content?.invoice?.line_items ?? [];
        if (!lines.some((line) => line?.entity_id === deps.topUp.itemPriceId)) return;
        const result = await accounts.applyPaidTopUps(mapped(), deps.topUp.itemPriceId, deps.topUp.creditsPerUnit, {
          chargebeeGrants: deps.topUp.chargebeeGrants,
        });
        const invoiceId = event.content?.invoice?.id;
        if (invoiceId && result.pending?.includes(String(invoiceId))) {
          throw new Error(`grant block for top-up invoice ${invoiceId} not visible yet`);
        }
        return;
      }

      // Dunning is Chargebee's job, and revoking credits already granted is a
      // business decision, not a webhook handler's. Record and move on.
      // Credits were added to a subscription — ANY credits: a top-up pack's
      // grant, a charge or a grant made by hand in the Chargebee dashboard, a
      // plan's grant at a renewal, billing's own allocate. Re-read the org, so
      // its LiteLLM limit rises (and an exhausted team reopens) within
      // seconds, where a grant made by hand used to wait for the daily
      // resync. The same re-read as a subscription event: idempotent, and a
      // declined top-up's credits stay held back from the limit there.
      //
      // The event names subscriptions, not a customer. One that is no org's
      // CURRENT subscription (an ended one, Chargebee's sample data) has no
      // limit to move: acknowledged and logged, never retried.
      case "grant_blocks_created": {
        const subscriptionIds = [
          ...new Set((event.content?.grant_blocks ?? []).map((b) => b?.subscription_id).filter((id): id is string => !!id)),
        ];
        for (const subscriptionId of subscriptionIds) {
          const owner = isChargebeeSample(subscriptionId) ? null : await deps.accounts.findTenantIdBySubscriptionId(subscriptionId);
          if (!owner) {
            log.warn?.(
              { metric: "billing.webhook.grant_unlinked_subscription", eventId: event.id, subscriptionId },
              "Credits granted on a subscription that is no org's current one; nothing to move",
            );
            continue;
          }
          await accounts.syncFromChargebee(owner);
        }
        return;
      }

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

/** Chargebee's own demo data — what its "Test Webhook" button sends — is under ids prefixed `cbdemo_` (customers and subscriptions alike). */
export function isChargebeeSample(id: string): boolean {
  return id.startsWith("cbdemo_");
}

