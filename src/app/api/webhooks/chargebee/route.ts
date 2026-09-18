/**
 * Chargebee webhook receiver.
 *
 * Chargebee does NOT sign webhooks. It authenticates by sending HTTP Basic
 * credentials you configure alongside the endpoint URL, so those credentials
 * are the only thing standing between the internet and an endpoint that grants
 * credits. Rotate them like a password and rate-limit this route at the edge.
 *
 * Order: authenticate, claim the event id, acknowledge, then process. Claiming
 * BEFORE any effect is what makes a redelivery a no-op — and the ledger's
 * unique index on (tenant_id, source_ref) is the second, independent guard, so
 * the 1,000 credits cannot be granted twice even if the claim were bypassed.
 *
 * The one redelivery that is NOT a no-op: an event whose earlier attempt failed
 * (error recorded, never finished) runs again. Safe because every effect is
 * idempotent on its own — a grant is keyed on its term, a cancel is a status.
 */

import { NextResponse } from "next/server";

import { webhookAuthorised } from "@/lib/auth";
import { createAccounts, termGrantRef } from "@/lib/account";
import { createChargebee } from "@/lib/chargebee";
import { getConfig } from "@/lib/config";
import { isUniqueViolation, prisma } from "@/lib/db";
import { gatewayBudgetHooks } from "@/lib/gateway";

/**
 * Recorded as the event's error when its customer maps to no billing account.
 * Not exported: a Next.js route file may export only its handlers and config.
 */
const UNMAPPED_CUSTOMER = "unmapped customer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ChargebeeEvent {
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

export async function POST(request: Request) {
  if (!webhookAuthorised(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const event = (await request.json().catch(() => null)) as ChargebeeEvent | null;
  if (!event?.id || !event.event_type) {
    return NextResponse.json({ error: "Malformed event" }, { status: 400 });
  }

  // Claim before acting. A duplicate delivery returns 200 without reaching a
  // handler, which is what Chargebee's retries need to see.
  const claim = await claimEvent(event.id, event.event_type);
  if (claim === "duplicate") {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    await handle(event);
    await prisma.processedBillingEvent.update({
      where: { eventId: event.id },
      data: { processedAt: new Date() },
    });
  } catch (err) {
    // The claim row stays with processed_at NULL and the error recorded: the
    // failure is visible, and a redelivery of this event runs it again.
    await prisma.processedBillingEvent.update({
      where: { eventId: event.id },
      data: { error: (err as Error).message.slice(0, 2000) },
    });
    console.error(
      { metric: "billing.webhook.failed", eventId: event.id, eventType: event.event_type, err: (err as Error).message },
      "Chargebee webhook handler failed",
    );
    // Still 200: Chargebee would otherwise retry into the same failure, and the
    // row above is the durable record that something needs attention.
    return NextResponse.json({ received: true, handled: false });
  }

  return NextResponse.json({ received: true, ...(claim === "retrying" ? { retried: true } : {}) });
}

/**
 * `claimed`: first delivery. `retrying`: an earlier attempt failed, run it
 * again. `duplicate`: already handled, or being handled right now.
 *
 * Only a unique violation means "seen before". Any other error is thrown, so
 * Chargebee gets a 500 and retries — swallowing it as a duplicate (as this
 * once did) acknowledged the event and dropped it.
 */
async function claimEvent(eventId: string, eventType: string): Promise<"claimed" | "retrying" | "duplicate"> {
  try {
    await prisma.processedBillingEvent.create({ data: { eventId, eventType } });
    return "claimed";
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  // Compare-and-set on the failed state, so of two concurrent redeliveries
  // exactly one wins; a row with no error is finished or still in flight.
  const { count } = await prisma.processedBillingEvent.updateMany({
    where: { eventId, processedAt: null, error: { not: null } },
    data: { error: null },
  });
  return count === 1 ? "retrying" : "duplicate";
}

async function handle(event: ChargebeeEvent) {
  const config = getConfig();
  const accounts = createAccounts({
    chargebee: createChargebee(),
    usdPerCredit: config.usdPerCredit,
    ...gatewayBudgetHooks(),
  });

  const subscription = event.content?.subscription;

  // Resolved once, and written onto the event row straight away, so webhook
  // history can be read per organisation — including events that fail later.
  const customerId = subscription?.customer_id ?? event.content?.customer?.id;
  const tenantId = customerId ? await resolveTenant(customerId) : null;
  if (tenantId) {
    await prisma.processedBillingEvent.update({ where: { eventId: event.id! }, data: { tenantId } });
  }

  /**
   * For an event we act on, a customer that maps to no account is a failure,
   * not a no-op: it used to be marked processed and vanish. Thrown, it is
   * recorded as `unmapped customer` and runs again if redelivered.
   */
  const mapped = (): string => {
    if (!tenantId) throw new Error(UNMAPPED_CUSTOMER);
    return tenantId;
  };

  switch (event.event_type) {
    // A trial converting to paid arrives as `activated`, and must not re-grant.
    // It cannot: the grant is keyed on the TERM (termGrantRef), not the event,
    // which is also what stops the post-checkout sync granting it a second time.
    case "subscription_created":
    case "subscription_activated":
    case "subscription_changed": {
      if (!subscription?.id || !subscription.customer_id) return;

      await accounts.syncSubscription({
        tenantId: mapped(),
        subscriptionId: subscription.id,
        itemPriceId: subscription.subscription_items?.[0]?.item_price_id ?? null,
        termStart: toDate(subscription.current_term_start),
        termEnd: toDate(subscription.current_term_end),
        sourceRef: termGrantRef(subscription.id, subscription.current_term_start),
      });
      return;
    }

    case "subscription_renewed": {
      if (!subscription?.id || !subscription.customer_id) return;

      await accounts.renew({
        tenantId: mapped(),
        subscriptionId: subscription.id,
        sourceRef: termGrantRef(subscription.id, subscription.current_term_start),
        termStart: toDate(subscription.current_term_start),
        termEnd: toDate(subscription.current_term_end),
      });
      return;
    }

    case "subscription_cancelled":
    case "subscription_deleted": {
      if (!subscription?.customer_id) return;
      await accounts.cancel(mapped());
      return;
    }

    // Dunning is Chargebee's job, and revoking credits already granted is a
    // business decision, not a webhook handler's. Record and move on.
    case "payment_failed":
    case "alert_status_changed":
      if (customerId) mapped();
      console.warn(
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
  const account = await prisma.billingAccount.findUnique({
    where: { chargebeeCustomerId: customerId },
    select: { tenantId: true },
  });
  if (account) return account.tenantId;

  console.error(
    { metric: "billing.webhook.unmapped_customer", customerId },
    "Chargebee customer maps to no billing account",
  );
  return null;
}

function toDate(seconds?: number): Date | null {
  return seconds ? new Date(seconds * 1000) : null;
}
