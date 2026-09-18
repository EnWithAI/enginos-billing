/**
 * Manual sweep trigger, for operators and for the smoke test.
 *
 * The Hatchet cron is the normal driver; this exists so a sweep can be run on
 * demand without waiting a minute, and so a specific tenant can be advanced
 * after a failed batch is resolved by hand.
 *
 * It is safe to call at any time: the same unique indexes that make two
 * overlapping cron runs safe make this safe alongside them.
 */

import { NextResponse } from "next/server";

import { internalAuthorised } from "@/lib/auth";
import { createChargebee } from "@/lib/chargebee";
import { createUsageReader } from "@/lib/clickhouse";
import { getConfig } from "@/lib/config";
import { createSync } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!internalAuthorised(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { slugs?: string[] };
  const config = getConfig();

  const sync = createSync({
    usage: createUsageReader(),
    chargebee: createChargebee(),
    usdPerCredit: config.usdPerCredit,
    wholeCreditsOnly: config.wholeCreditsOnly,
    lagMs: config.lagMs,
    maxWindowMs: config.maxWindowMs,
    maxAttempts: config.maxAttempts,
  });

  const summary = await sync.runOnce(body.slugs);
  return NextResponse.json(summary);
}
