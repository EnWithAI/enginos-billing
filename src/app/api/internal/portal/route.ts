/**
 * Create a Chargebee self-serve portal session for a tenant's customer.
 *
 * Scoped to the customer resolved from the tenant, never from the request body,
 * so one org's admin cannot open another org's portal.
 */

import { NextResponse } from "next/server";

import { internalAuthorised } from "@/lib/auth";
import { createChargebee } from "@/lib/chargebee";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";

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

  const account = await prisma.billingAccount.findUnique({ where: { tenantId: body.tenantId } });

  // A portal with no customer behind it has nothing to show — this is a
  // "subscribe first" state, not an error.
  if (!account?.chargebeeCustomerId) {
    return NextResponse.json(
      { error: "No billing customer yet", code: "no-customer" },
      { status: 404 },
    );
  }

  try {
    const portalSession = await createChargebee().portalSession({
      customerId: account.chargebeeCustomerId,
      redirectUrl: getConfig().appUrl,
    });
    return NextResponse.json({ portalSession });
  } catch (err) {
    const chargebeeCode = (err as { apiErrorCode?: string }).apiErrorCode;

    // A site-configuration problem, not an outage. Chargebee returns
    // `configuration_incompatible` / "Customer portal access via API is
    // disabled." until API access is enabled under
    // Settings > Configure Chargebee > Customer Portal. Surfacing it as a
    // generic failure sends an operator hunting for a bug that is not there.
    if (chargebeeCode === "configuration_incompatible") {
      console.error(
        { metric: "billing.portal.disabled", tenantId: body.tenantId, err: (err as Error).message },
        "Chargebee portal API access is disabled for this site",
      );
      return NextResponse.json(
        {
          error: "Customer portal access is disabled for this Chargebee site",
          code: "portal-disabled",
        },
        { status: 409 },
      );
    }

    console.error(
      { metric: "billing.portal.failed", tenantId: body.tenantId, err: (err as Error).message },
      "Could not create a Chargebee portal session",
    );
    return NextResponse.json(
      { error: "Could not open the billing portal", code: "portal-failed" },
      { status: 502 },
    );
  }
}
