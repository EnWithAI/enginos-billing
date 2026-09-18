/**
 * Top-up: buy more credits without starting a second subscription.
 *
 * Two actions on one route.
 *
 *   POST { tenantId }                  → a hosted page for the one-time charge
 *   POST { tenantId, apply: true }     → grant credits for any PAID pack invoice
 *
 * The split exists because payment and granting are separate events. We create
 * the page, the customer pays on Chargebee's side, and only then — with a paid
 * invoice as proof — are credits allocated. Granting on "checkout opened" would
 * hand out credits for abandoned carts.
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
    apply?: boolean;
  };

  if (!body.tenantId) {
    return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
  }

  const config = getConfig();
  const chargebee = createChargebee();
  const accounts = createAccounts({ chargebee, usdPerCredit: config.usdPerCredit });

  const account = await prisma.billingAccount.findUnique({ where: { tenantId: body.tenantId } });

  // A top-up adds to an existing ledger. Without a subscription there is no
  // ledger to add to — the customer needs to subscribe first.
  if (!account?.chargebeeSubscriptionId) {
    return NextResponse.json(
      { error: "Subscribe before topping up", code: "no-subscription" },
      { status: 409 },
    );
  }

  try {
    if (body.apply) {
      const result = await accounts.applyPaidTopUps(
        body.tenantId,
        config.topUpItemPriceId,
        config.topUpCredits,
      );
      return NextResponse.json(result);
    }

    const hostedPage = await chargebee.checkoutOneTime({
      customerId: account.chargebeeCustomerId!,
      itemPriceId: config.topUpItemPriceId,
    });

    return NextResponse.json({ hostedPage, credits: config.topUpCredits });
  } catch (err) {
    const chargebeeCode = (err as { apiErrorCode?: string }).apiErrorCode;
    const message = (err as Error).message ?? "";

    // A site-configuration problem, not an outage. Chargebee returns
    // `one_time_checkout_not_enabled_in_hp` until one-time checkout is turned on
    // under Settings > Configure Chargebee > Checkout & Self-Serve Portal.
    // Reporting it as a generic failure sends someone hunting for a defect that
    // is not in the code.
    if (chargebeeCode === "invalid_request" && /one time checkout is not enabled/i.test(message)) {
      console.error(
        { metric: "billing.topup.disabled", tenantId: body.tenantId },
        "One-time checkout is disabled for this Chargebee site",
      );
      return NextResponse.json(
        { error: "One-time checkout is disabled for this Chargebee site", code: "topup-disabled" },
        { status: 409 },
      );
    }

    console.error(
      { metric: "billing.topup.failed", tenantId: body.tenantId, apply: !!body.apply, err: message },
      "Top-up failed",
    );
    return NextResponse.json({ error: "Top-up failed", code: "topup-failed" }, { status: 502 });
  }
}
