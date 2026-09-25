/**
 * Starting a purchase: the subscription checkout, the top-up, and the
 * self-serve portal. Each returns a Chargebee hosted page or session for the
 * browser to open.
 *
 * The `tenantId` in each body is enginos-platform's, taken from the
 * authenticated request, and is trusted as given — nothing here checks the
 * caller (see http/route.ts).
 */

import { NextResponse } from "next/server";

import { createServices } from "../container";
import { optionalString, readJson, requireTenantId } from "../http/request";
import { route } from "../http/route";

export const postCheckout = route(
  {
    fallback: {
      status: 502,
      body: { error: "Could not start checkout", code: "checkout-failed" },
      metric: "billing.checkout.failed",
      message: "Could not create a Chargebee hosted checkout page",
    },
  },
  async (request, { logContext }) => {
    const body = await readJson(request);
    const tenantId = requireTenantId(body);
    logContext.tenantId = tenantId;

    const hostedPage = await createServices().checkout.startSubscription(tenantId, optionalString(body, "itemPriceId"));
    return NextResponse.json({ hostedPage });
  },
);

/**
 * Two actions on one route, because payment and granting are separate events:
 *
 *   POST { tenantId }                  → a hosted page for the one-time charge
 *   POST { tenantId, apply: true }     → grant credits for any PAID pack invoice
 */
export const postTopUp = route(
  {
    fallback: {
      status: 502,
      body: { error: "Top-up failed", code: "topup-failed" },
      metric: "billing.topup.failed",
      message: "Top-up failed",
    },
  },
  async (request, { logContext }) => {
    const body = await readJson(request);
    const tenantId = requireTenantId(body);
    const apply = body.apply === true;
    Object.assign(logContext, { tenantId, apply });

    const { checkout } = createServices();
    return NextResponse.json(apply ? await checkout.applyTopUps(tenantId) : await checkout.startTopUp(tenantId));
  },
);

export const postPortal = route(
  {
    fallback: {
      status: 502,
      body: { error: "Could not open the billing portal", code: "portal-failed" },
      metric: "billing.portal.failed",
      message: "Could not create a Chargebee portal session",
    },
  },
  async (request, { logContext }) => {
    const tenantId = requireTenantId(await readJson(request));
    logContext.tenantId = tenantId;

    const portalSession = await createServices().portal.open(tenantId);
    return NextResponse.json({ portalSession });
  },
);
