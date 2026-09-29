/**
 * The billing page's reads: the overview, and an invoice download link.
 *
 * Internal only — the caller is enginos-platform, never a browser, and the
 * tenant id in the path is the one the platform took from the authenticated
 * request, not one the user typed. These routes check nothing about the caller
 * and trust the id they are given, which is exactly why they must never be
 * reachable from anywhere but enginos-platform.
 */

import { NextResponse } from "next/server";

import { createServices } from "../container";
import { route } from "../http/route";
import { invalid } from "../shared/errors";
import { renderBillingOverview, renderPaymentsPage } from "../views/billing.view";
import { NO_STORE, renderInvoiceDownload } from "../views/responses";

export const getBillingOverview = route<{ tenantId: string }>(
  {
    fallback: {
      status: 500,
      body: { error: "Could not load billing", code: "billing-unavailable" },
      metric: "billing.page.failed",
      message: "Could not assemble the billing page",
    },
  },
  async (_request, { params, logContext }) => {
    logContext.tenantId = params.tenantId;
    const services = createServices();
    const overview = await services.overview.overview(params.tenantId);
    return NextResponse.json(
      renderBillingOverview(overview, {
        site: services.config.chargebee.site,
        defaultItemPriceId: services.config.defaultItemPriceId,
      }),
    );
  },
);

/**
 * GET ?offset=<cursor> — the page of payments after the one that returned the
 * cursor. The first page comes with the overview; this serves the rest.
 */
export const getPayments = route<{ tenantId: string }>(
  {
    fallback: {
      status: 502,
      body: { error: "Could not load payments", code: "payments-failed" },
      metric: "billing.payments.failed",
      message: "Could not read a page of payments from Chargebee",
    },
  },
  async (request, { params, logContext }) => {
    logContext.tenantId = params.tenantId;
    const offset = new URL(request.url).searchParams.get("offset") ?? undefined;
    // Chargebee's cursors are short; anything longer was not one of them.
    if (offset !== undefined && (offset === "" || offset.length > 512)) {
      throw invalid("Not a page cursor", "payments-offset-invalid");
    }
    const page = await createServices().overview.paymentsPage(params.tenantId, offset);
    return NextResponse.json(renderPaymentsPage(page), { headers: NO_STORE });
  },
);

export const getInvoiceDownload = route<{ tenantId: string; invoiceId: string }>(
  {
    fallback: {
      status: 502,
      body: { error: "Could not prepare the invoice" },
      metric: "billing.invoice.failed",
      message: "Could not mint an invoice download link",
    },
  },
  async (_request, { params, logContext }) => {
    Object.assign(logContext, params);
    const download = await createServices().invoices.downloadLink(params.tenantId, params.invoiceId);
    // The response carries a short-lived credential; no cache should keep it.
    return NextResponse.json(renderInvoiceDownload(download), { headers: NO_STORE });
  },
);
