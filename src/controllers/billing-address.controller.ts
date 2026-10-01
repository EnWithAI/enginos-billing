/**
 * The org's billing address: entered in Chargebee's own editor, and synced
 * here. Its country decides the currency the org is billed in
 * (services/billing-address.service.ts).
 *
 * The `tenantId` in the body is enginos-platform's, taken from the
 * authenticated request, and is trusted as given — nothing here checks the
 * caller (see http/route.ts).
 */

import { NextResponse } from "next/server";

import { createServices } from "../container";
import { readJson, requireTenantId } from "../http/request";
import { route } from "../http/route";

/**
 * POST { tenantId } → `{ synced, reason, billingCountry, currency,
 * currencySwitch, currencyLocked, waitingOn }`.
 *
 * The page calls it when Chargebee's billing-address editor closes. Nothing
 * else is read from the body: the address is Chargebee's to hold, and is
 * read from there — the browser never gets to say what it is. No address
 * with a country in Chargebee is a 200 `{ synced: false, reason:
 * "no-country" }`, not an error: the org closed the editor without saving.
 *
 * The request is timed from here: a currency switch it starts runs inline
 * only for what is left of BILLING_SWITCH_INLINE_MS, so the platform's
 * 10-second proxy timeout is never what answers. The fallback is a 502 that
 * means NOTHING was kept — once the country is, the answer is 200 whatever
 * its switch did.
 */
export const postBillingAddressSync = route(
  {
    fallback: {
      status: 502,
      body: { error: "Could not sync the billing address", code: "billing-address-sync-failed" },
      metric: "billing.address.sync_failed",
      message: "Could not sync a billing address from Chargebee",
    },
  },
  async (request, { logContext }) => {
    const startedAt = Date.now();
    const tenantId = requireTenantId(await readJson(request));
    logContext.tenantId = tenantId;

    return NextResponse.json(await createServices().billingAddress.syncBillingAddress(tenantId, { startedAt }));
  },
);
