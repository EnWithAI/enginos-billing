/**
 * Create a Chargebee hosted checkout page for a tenant.
 *
 * The customer is ensured first, with `id = tenantId`, so the resulting
 * subscription belongs to a customer our webhook can map back to a tenant. That
 * is the whole reason this endpoint exists rather than the browser using
 * Chargebee's attribute drop-in: the drop-in sends no customer, Chargebee
 * creates a fresh one per checkout, and the subscription_created webhook would
 * hit `unmapped_customer` and be ignored — the customer pays and receives no
 * credits.
 */

import { NextResponse } from "next/server";

import { internalAuthorised } from "@/lib/auth";
import { createAccounts } from "@/lib/account";
import { createChargebee } from "@/lib/chargebee";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!internalAuthorised(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    tenantId?: string;
    itemPriceId?: string;
  };

  if (!body.tenantId) {
    return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
  }

  const config = getConfig();
  const itemPriceId = body.itemPriceId ?? config.defaultItemPriceId;

  // The allowlist is a security control, not a menu. Without it a tampered
  // request could subscribe this tenant to any item price in the catalogue.
  if (!config.itemPriceIds.includes(itemPriceId)) {
    return NextResponse.json(
      { error: "Unknown plan", code: "plan-not-offered" },
      { status: 400 },
    );
  }

  const chargebee = createChargebee();
  const accounts = createAccounts({ chargebee, usdPerCredit: config.usdPerCredit });

  const account = await prisma.billingAccount.findUnique({ where: { tenantId: body.tenantId } });

  try {
    // Idempotent on both counts: bootstrapFromTenant upserts the local row, and
    // the Chargebee customer id is the tenant id, so a repeat call finds the
    // existing customer rather than creating a second one.
    //
    // Bootstrapping here rather than at tenant provisioning is deliberate:
    // billing is a separate service and the platform does not know it exists.
    // First checkout is the earliest moment we are certain the tenant wants to
    // be billed, and it is the only point where a missing row would otherwise
    // be a dead end.
    const linked = account
      ? await accounts.ensureCustomer({
          tenantId: account.tenantId,
          routingSlug: account.routingSlug,
          billingEmail: account.billingEmail ?? undefined,
        })
      : await accounts.bootstrapFromTenant(body.tenantId);

    if (!linked) {
      // No such tenant in the platform's own table — not our row to invent.
      return NextResponse.json(
        { error: "Unknown tenant", code: "tenant-not-found" },
        { status: 404 },
      );
    }

    if (!linked.chargebeeCustomerId) {
      return NextResponse.json(
        { error: "Could not create the billing customer", code: "customer-unavailable" },
        { status: 502 },
      );
    }

    const hostedPage = await chargebee.checkoutPage({
      customerId: linked.chargebeeCustomerId,
      itemPriceId,
    });

    return NextResponse.json({ hostedPage });
  } catch (err) {
    console.error(
      { metric: "billing.checkout.failed", tenantId: body.tenantId, err: (err as Error).message },
      "Could not create a Chargebee hosted checkout page",
    );
    return NextResponse.json(
      { error: "Could not start checkout", code: "checkout-failed" },
      { status: 502 },
    );
  }
}
