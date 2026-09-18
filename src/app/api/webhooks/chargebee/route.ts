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
 */

import { NextResponse } from "next/server";

import { webhookAuthorised } from "@/lib/auth";
import { createAccounts } from "@/lib/account";
import { createChargebee } from "@/lib/chargebee";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";

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
  const claimed = await claimEvent(event.id, event.event_type);
  if (!claimed) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    await handle(event);
    await prisma.processedBillingEvent.update({
      where: { eventId: event.id },
      data: { processedAt: new Date() },
    });
  } catch (err) {
    // The claim row stays with processed_at NULL — a crash mid-handler is
    // visible rather than silent, and a human can replay it deliberately.
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

  return NextResponse.json({ received: true });
}

async function claimEvent(eventId: string, eventType: string): Promise<boolean> {
  try {
    await prisma.processedBillingEvent.create({ data: { eventId, eventType } });
    return true;
  } catch {
    return false;
  }
}

async function handle(event: ChargebeeEvent) {
  const config = getConfig();
  const accounts = createAccounts({
    chargebee: createChargebee(),
    usdPerCredit: config.usdPerCredit,
  });

  const subscription = event.content?.subscription;

  switch (event.event_type) {
    // A trial converting to paid arrives as `activated`, and must not re-grant.
    // It cannot: the ledger entry is keyed on the event id.
    case "subscription_created":
    case "subscription_activated":
    case "subscription_changed": {
      if (!subscription?.id || !subscription.customer_id) return;
      const tenantId = await resolveTenant(subscription.customer_id);
      if (!tenantId) return;

      await accounts.syncSubscription({
        tenantId,
        subscriptionId: subscription.id,
        itemPriceId: subscription.subscription_items?.[0]?.item_price_id ?? null,
        termStart: toDate(subscription.current_term_start),
        termEnd: toDate(subscription.current_term_end),
        sourceRef: event.id!,
      });
      return;
    }

    case "subscription_renewed": {
      if (!subscription?.id || !subscription.customer_id) return;
      const tenantId = await resolveTenant(subscription.customer_id);
      if (!tenantId) return;

      await accounts.renew({
        tenantId,
        subscriptionId: subscription.id,
        sourceRef: event.id!,
        termStart: toDate(subscription.current_term_start),
        termEnd: toDate(subscription.current_term_end),
      });
      return;
    }

    case "subscription_cancelled":
    case "subscription_deleted": {
      if (!subscription?.customer_id) return;
      const tenantId = await resolveTenant(subscription.customer_id);
      if (tenantId) await accounts.cancel(tenantId);
      return;
    }

    // Dunning is Chargebee's job, and revoking credits already granted is a
    // business decision, not a webhook handler's. Record and move on.
    case "payment_failed":
    case "alert_status_changed":
      console.warn(
        { metric: `billing.webhook.${event.event_type}`, eventId: event.id },
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
    "Chargebee customer maps to no billing account; event ignored",
  );
  return null;
}

function toDate(seconds?: number): Date | null {
  return seconds ? new Date(seconds * 1000) : null;
}
