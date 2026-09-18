/**
 * Billing state for one tenant, for crewpe-ui's billing page.
 *
 * Internal only — the caller is crewpe-ui's server-side proxy, never a browser,
 * and the tenant id comes from the authenticated session on that side. This
 * route therefore trusts the id it is given, which is exactly why it must never
 * be exposed publicly. Keyed on tenant id rather than routing slug because that
 * is what the session already carries; the slug is a gateway concern.
 *
 * The balance is derived from the ledger rather than read from the cached
 * column: a cached balance is a wrong balance the moment a capture lands, and
 * the aggregate is one indexed scan.
 */

import { NextResponse } from "next/server";

import { createAccounts } from "@/lib/account";
import { internalAuthorised } from "@/lib/auth";
import { createChargebee } from "@/lib/chargebee";
import { getConfig } from "@/lib/config";
import { balanceOf, recentEntries } from "@/lib/ledger";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, ctx: { params: Promise<{ tenantId: string }> }) {
  if (!internalAuthorised(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { tenantId } = await ctx.params;

  const config = getConfig();

  // Opening the billing page provisions the local row if it is missing.
  //
  // A GET with a side effect, deliberately: this is the first moment we know a
  // real org is looking at billing, and it is the only lazy hook there is —
  // billing is not wired into tenant provisioning, so nothing else creates the
  // row until someone checks out. Creating it here pins `sync_from` to now and
  // makes "has opened billing" a queryable fact.
  //
  // It is idempotent (upsert on the primary key) and creates NOTHING in
  // Chargebee, so a refresh, a prefetch or two tabs at once cost one no-op
  // write. Failure is swallowed: a page that cannot render because provisioning
  // hiccuped would be a worse bug than a missing row, and the next load retries.
  let account = null;
  try {
    account = await createAccounts({
      chargebee: createChargebee(),
      usdPerCredit: config.usdPerCredit,
    }).ensureLocalAccount(tenantId);
  } catch (err) {
    console.error(
      { metric: "billing.account.autoprovision_failed", tenantId, err: (err as Error).message },
      "Could not create the billing row on page load; rendering unlinked",
    );
    account = await prisma.billingAccount.findUnique({ where: { tenantId } });
  }

  // A tenant with no billing row is a NORMAL state — billing is created lazily
  // on first checkout, so every org starts here. Returning 404 made the page
  // render with no data, which left `site` null, which meant Chargebee.js never
  // loaded, which left the Subscribe button permanently disabled. The customer
  // could see "No subscription" and had no way to fix it.
  //
  // So answer 200 with an unlinked shape that still carries everything the page
  // needs to START a checkout.
  if (!account) {
    return NextResponse.json({
      site: config.chargebee.site,
      plansOffered: config.itemPriceIds,
      status: "unlinked",
      plan: { itemPriceId: config.defaultItemPriceId },
      term: { start: null, end: null },
      credits: { unit: null, granted: "0", allocated: "0", consumed: "0", current: "0" },
      budgetUsd: "0",
      lastSync: null,
      history: [],
    });
  }

  const [balance, entries, lastBatch] = await Promise.all([
    balanceOf(account.tenantId),
    recentEntries(account.tenantId, 25),
    prisma.usageSyncBatch.findFirst({
      where: { tenantId: account.tenantId, status: "captured" },
      orderBy: { windowEnd: "desc" },
      select: { windowEnd: true, billedUsd: true, consumeCredits: true },
    }),
  ]);

  return NextResponse.json({
    // The site name is needed by Chargebee.js in the browser. It is not a
    // secret — hosted pages and the portal authenticate by site name alone,
    // and there is no publishable key in this integration.
    site: config.chargebee.site,
    plansOffered: config.itemPriceIds,
    status: account.status,
    plan: { itemPriceId: account.chargebeeItemPriceId ?? config.defaultItemPriceId },
    term: { start: account.currentTermStart, end: account.currentTermEnd },
    credits: {
      unit: account.ledgerUnitId,
      granted: account.grantedCredits.toString(),
      allocated: balance.allocated,
      consumed: balance.consumed,
      current: balance.current,
    },
    budgetUsd: account.budgetUsd.toString(),
    lastSync: lastBatch
      ? {
          at: lastBatch.windowEnd,
          billedUsd: lastBatch.billedUsd.toString(),
          credits: lastBatch.consumeCredits.toString(),
        }
      : null,
    history: entries.map((entry) => ({
      id: entry.id,
      type: entry.entryType,
      credits: entry.deltaCredits.toString(),
      billedUsd: entry.billedUsd?.toString() ?? null,
      at: entry.occurredAt,
    })),
  });
}
