/**
 * Starting a purchase: the subscription checkout, the top-up, and the
 * self-serve portal. Checkout and portal return a Chargebee hosted page or
 * session for the browser to open; the top-up charges the card on file.
 *
 * The `tenantId` in each body is enginos-platform's, taken from the
 * authenticated request, and is trusted as given — nothing here checks the
 * caller (see http/route.ts).
 */

import { NextResponse } from "next/server";

import { createServices } from "../container";
import { optionalString, readJson, requireBoolean, requireTenantId } from "../http/request";
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
 * Two actions on one route:
 *
 *   POST { tenantId, quantity? }       → charge `quantity` units (default 1) to the
 *                                        card on file, and grant if it was paid
 *   POST { tenantId, apply: true }     → grant credits for any PAID pack invoice
 *
 * `quantity` is passed through as sent, number or not: the service refuses
 * anything that is not a whole number in range, with a named code.
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
    if (apply) return NextResponse.json(await checkout.applyTopUps(tenantId));
    return NextResponse.json(await checkout.startTopUp(tenantId, body.quantity === undefined ? 1 : (body.quantity as number)));
  },
);

/**
 * POST { tenantId } → charge the card on file for every top-up whose card
 * declined and Chargebee has not collected since — the page's "Pay now".
 * Never retried; a card that declines again is 409 `topup-payment-failed`.
 */
export const postPayUnpaidTopUps = route(
  {
    fallback: {
      status: 502,
      body: { error: "Could not collect the unpaid top-up", code: "topup-collect-failed" },
      metric: "billing.topup.collect_failed",
      message: "Could not collect the unpaid top-up",
    },
  },
  async (request, { logContext }) => {
    const tenantId = requireTenantId(await readJson(request));
    logContext.tenantId = tenantId;

    return NextResponse.json(await createServices().checkout.payUnpaidTopUps(tenantId));
  },
);

/**
 * POST { tenantId, adminEmail? } → set up a new org's billing: its Chargebee
 * customer (with `adminEmail` as the billing contact), and the free plan (no
 * checkout, no card) if the free plan is for it — `{ status: "not-eligible" }`
 * otherwise. enginos-platform calls it once an org exists; safe to repeat.
 */
export const postProvision = route(
  {
    fallback: {
      status: 502,
      body: { error: "Could not set up the free plan", code: "free-plan-failed" },
      metric: "billing.free_plan.failed",
      message: "Could not put the org on the free plan",
    },
  },
  async (request, { logContext }) => {
    const body = await readJson(request);
    const tenantId = requireTenantId(body);
    logContext.tenantId = tenantId;

    return NextResponse.json(
      await createServices().checkout.provisionFreePlan(tenantId, { billingEmail: optionalString(body, "adminEmail") }),
    );
  },
);

/**
 * POST { tenantId, enabled } → turn the free plan on or off for one org.
 *
 * FOR OPERATORS ONLY. enginos-platform must never forward an org's request
 * here — an org admin could give their own org the free plan. Call it from
 * inside the private network, as with any other billing route.
 */
export const postFreePlan = route(
  {
    fallback: {
      status: 502,
      body: { error: "Could not change the free plan setting", code: "free-plan-setting-failed" },
      metric: "billing.free_plan.set_failed",
      message: "Could not change an org's free plan setting",
    },
  },
  async (request, { logContext }) => {
    const body = await readJson(request);
    const tenantId = requireTenantId(body);
    logContext.tenantId = tenantId;
    const enabled = requireBoolean(body, "enabled");

    return NextResponse.json(await createServices().checkout.setFreePlan(tenantId, enabled));
  },
);

/** POST { tenantId } → Chargebee's page for adding, replacing or removing the customer's cards. */
export const postPaymentMethod = route(
  {
    fallback: {
      status: 502,
      body: { error: "Could not open the payment method page", code: "payment-method-failed" },
      metric: "billing.payment_method.failed",
      message: "Could not create a Chargebee manage-payment-sources page",
    },
  },
  async (request, { logContext }) => {
    const tenantId = requireTenantId(await readJson(request));
    logContext.tenantId = tenantId;

    const hostedPage = await createServices().paymentMethod.manage(tenantId);
    return NextResponse.json({ hostedPage });
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
