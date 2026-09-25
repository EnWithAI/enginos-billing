/**
 * Pulling state on demand, instead of waiting for it to be pushed.
 *
 *   /sync-subscription   re-read one tenant's subscription from Chargebee. The
 *                        webhook is the push path and cannot be relied on alone
 *                        — Chargebee cannot reach a developer machine at all,
 *                        and in production a delivery can be delayed or lost.
 *                        The UI calls this, through enginos-platform, right
 *                        after a checkout.
 *
 *   /sync                run the usage sync now — the SAME sync the Hatchet cron
 *                        runs, not a second path. Safe alongside the cron: the
 *                        window index lets one of them open a window, each send
 *                        claims its row first, a row the cron has on the wire is
 *                        left to it until its lease runs out, and the cursor
 *                        moves by compare-and-set. For operators only:
 *                        enginos-platform does not proxy it, so it is reachable
 *                        from the private network and nowhere else.
 */

import { NextResponse } from "next/server";

import { createServices } from "../container";
import { readJson, requireTenantId } from "../http/request";
import { route } from "../http/route";
import { invalid } from "../shared/errors";
import { renderSubscriptionSync } from "../views/responses";

export const postSyncSubscription = route(
  {
    fallback: {
      status: 502,
      body: { error: "Could not sync subscription", code: "subscription-sync-failed" },
      metric: "billing.sync_subscription.failed",
      message: "Could not pull subscription state from Chargebee",
    },
  },
  async (request, { logContext }) => {
    const tenantId = requireTenantId(await readJson(request));
    logContext.tenantId = tenantId;

    const account = await createServices().accounts.syncFromChargebee(tenantId);
    return NextResponse.json(renderSubscriptionSync(account));
  },
);

export const postUsageSync = route(
  {
    fallback: {
      status: 500,
      body: { error: "Usage sync failed", code: "sync-failed" },
      metric: "billing.sync.failed",
      message: "Manual usage sync failed",
    },
  },
  async (request) => {
    const { slugs } = await readJson(request);
    if (slugs !== undefined && !(Array.isArray(slugs) && slugs.every((s) => typeof s === "string"))) {
      throw invalid("slugs must be an array of tenant slugs");
    }

    const summary = await createServices().usageSync().runOnce(slugs as string[] | undefined);
    return NextResponse.json(summary);
  },
);
