/**
 * Pull subscription state from Chargebee for one tenant.
 *
 * The webhook is the push path and remains the production default. This is the
 * pull path, and it exists because push alone is not enough:
 *
 *   - Chargebee cannot reach a developer machine at all, so locally the webhook
 *     never arrives and a paid customer sees "No subscription" forever.
 *   - Even in production a delivery can be delayed, dropped, or land while we
 *     are mid-deploy.
 *
 * Called by the UI immediately after a successful checkout, so the customer
 * sees their credits without waiting on a notification. Idempotent: the grant
 * is keyed on the subscription's current term, so calling it repeatedly cannot
 * grant twice.
 */

import { NextResponse } from "next/server";

import { internalAuthorised } from "@/lib/auth";
import { createAccounts } from "@/lib/account";
import { createChargebee } from "@/lib/chargebee";
import { getConfig } from "@/lib/config";
import { gatewayBudgetHooks } from "@/lib/gateway";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!internalAuthorised(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { tenantId?: string };
  if (!body.tenantId) {
    return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
  }

  const config = getConfig();
  const accounts = createAccounts({
    chargebee: createChargebee(),
    usdPerCredit: config.usdPerCredit,
    ...gatewayBudgetHooks(),
  });

  try {
    const account = await accounts.syncFromChargebee(body.tenantId);

    // No subscription yet is a real answer, not a failure — the customer may
    // simply not have completed checkout.
    if (!account) {
      return NextResponse.json({ linked: false, reason: "no active subscription" });
    }

    return NextResponse.json({
      linked: true,
      status: account.status,
      subscriptionId: account.chargebeeSubscriptionId,
      grantedCredits: account.grantedCredits.toString(),
      budgetUsd: account.budgetUsd.toString(),
    });
  } catch (err) {
    console.error(
      { metric: "billing.sync_subscription.failed", tenantId: body.tenantId, err: (err as Error).message },
      "Could not pull subscription state from Chargebee",
    );
    return NextResponse.json(
      { error: "Could not sync subscription", code: "subscription-sync-failed" },
      { status: 502 },
    );
  }
}
