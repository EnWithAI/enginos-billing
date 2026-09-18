/**
 * Manual usage-sync trigger, for operators and for the smoke test.
 *
 * The Hatchet cron is the normal driver; this runs the SAME sync on demand —
 * not a second path — so a tenant can be advanced without waiting a minute,
 * e.g. after a failed capture is resolved by hand.
 *
 * Safe alongside the cron: the per-tenant cursor lease lets only one of them
 * process a tenant at a time, and the idempotency keys hold regardless.
 */

import { NextResponse } from "next/server";

import { internalAuthorised } from "@/lib/auth";
import { createChargebee } from "@/lib/chargebee";
import { getConfig } from "@/lib/config";
import { gatewayBudgetHooks } from "@/lib/gateway";
import { createUsageSource } from "@/lib/usage-events";
import { createUsageSync } from "@/lib/usage-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!internalAuthorised(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { slugs?: string[] };
  const config = getConfig();

  const sync = createUsageSync({
    usage: createUsageSource(),
    chargebee: createChargebee(),
    usdPerCredit: config.usdPerCredit,
    wholeCreditsOnly: config.wholeCreditsOnly,
    lagMs: config.lagMs,
    maxEventsPerCapture: config.maxEventsPerCapture,
    maxAttempts: config.maxAttempts,
    eventKeyRetentionMs: config.eventKeyRetentionMs,
    blockBudget: gatewayBudgetHooks().blockBudget,
  });

  const summary = await sync.runOnce(body.slugs);
  return NextResponse.json(summary);
}
