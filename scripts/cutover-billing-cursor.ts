/**
 * One-time cutover: window billing → billing_cursor.
 *
 * For each billing account without a cursor:
 *
 *   old position   max(window_end) over its window-era captured / skipped /
 *                  pending batches. Every span with Timestamp in
 *                  [sync_from, old position) was billed (or deliberately
 *                  skipped) by the windows.
 *   new cursor     (old position − MARGIN, ""), in ingested_at terms. Any span
 *                  NOT yet billed has Timestamp >= old position, so its
 *                  ingested_at (>= Timestamp) is after the cursor: nothing
 *                  unbilled is skipped. The margin absorbs clock skew between
 *                  the LLM host (Timestamp) and ClickHouse (ingested_at).
 *   seeds          the keys of every span the windows billed that the cursor
 *                  could still read: Timestamp in [cursor − key horizon, old
 *                  position). That covers spans ingested after the new cursor
 *                  (the margin), and spans a platform rebuild of span_nodes
 *                  would re-insert with a fresh ingested_at. Below the horizon
 *                  the sync never reads (usage-sync.ts), so no key is needed.
 *
 * A tenant with no window history starts at sync_from, as a new tenant would.
 * A tenant with a FAILED window-era batch is refused: that usage was never
 * charged, and deciding what to do with it is a human's call.
 *
 * Idempotent: a tenant that already has a cursor keeps it, and only has its
 * window-era seeds topped up (skipDuplicates). With --delete-skipped, the
 * window era's empty `skipped` rows — pure cursor bookkeeping, no money, no
 * ledger reference — are deleted afterwards.
 *
 *   npx tsx scripts/cutover-billing-cursor.ts [--delete-skipped]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient } from "@clickhouse/client";

function loadEnv(path: string) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}
loadEnv(resolve(__dirname, "../.env"));

const MARGIN_MS = 10 * 60 * 1000;
const deleteSkipped = process.argv.includes("--delete-skipped");

async function main() {
  const { prisma, BATCH } = await import("../src/lib/db");
  const { getConfig } = await import("../src/lib/config");
  const { LLM_SPAN_NAME, assertSlug } = await import("../src/lib/usage-events");

  const { clickhouse, eventKeyRetentionMs } = getConfig();
  const ch = createClient({ url: clickhouse.url, username: clickhouse.user, password: clickhouse.password });

  /** Keys of costed spans with Timestamp in [from, to); none for a tenant with no table yet. */
  async function spanKeys(slug: string, from: Date, to: Date) {
    if (from >= to) return [];
    const exists = await ch.query({ query: `EXISTS TABLE tenant_${slug}.span_nodes`, format: "JSONEachRow" });
    if (Number((await exists.json<{ result: number }>())[0]?.result) !== 1) return [];
    const result = await ch.query({
      query: `
        SELECT concat(TraceId, ':', SpanId) AS key, toUnixTimestamp64Milli(ingested_at) AS ingested_ms
        FROM tenant_${slug}.span_nodes FINAL
        WHERE SpanName = {span:String}
          AND attrs['gen_ai.cost.total_cost'] != ''
          AND Timestamp >= {from:DateTime64(3)}
          AND Timestamp <  {to:DateTime64(3)}
      `,
      query_params: { span: LLM_SPAN_NAME, from, to },
      format: "JSONEachRow",
    });
    return result.json<{ key: string; ingested_ms: string | number }>();
  }

  const asKeys = (tenantId: string, seeds: Array<{ key: string; ingested_ms: string | number }>) =>
    seeds.map((k) => ({ tenantId, eventKey: k.key, batchId: null, ingestedAt: new Date(Number(k.ingested_ms)) }));

  /** The window era's end for a tenant: every span that started before it was the windows' to bill. */
  async function windowEraEnd(tenantId: string) {
    const history = await prisma.usageSyncBatch.aggregate({
      where: { tenantId, cursorToAt: null, status: { in: [BATCH.CAPTURED, BATCH.SKIPPED, BATCH.PENDING] } },
      _max: { windowEnd: true },
    });
    return history._max.windowEnd;
  }

  const accounts = await prisma.billingAccount.findMany();
  let cutover = 0;
  let refused = 0;

  for (const account of accounts) {
    const slug = assertSlug(account.routingSlug);
    const syncFrom = account.syncFrom;

    const existing = await prisma.billingCursor.findUnique({ where: { tenantId: account.tenantId } });
    if (existing) {
      const oldPosition = await windowEraEnd(account.tenantId);
      if (!oldPosition) {
        console.log(`${slug}: already on the cursor, no window history`);
        continue;
      }
      const from = new Date(Math.max(syncFrom.getTime(), existing.lastProcessedAt.getTime() - eventKeyRetentionMs));
      const seeds = await spanKeys(slug, from, oldPosition);
      const { count } = await prisma.billedUsageEvent.createMany({ data: asKeys(account.tenantId, seeds), skipDuplicates: true });
      console.log(`${slug}: already on the cursor — ${count} window-era key(s) added (${seeds.length} span(s) since ${from.toISOString()})`);
      continue;
    }

    const failed = await prisma.usageSyncBatch.count({ where: { tenantId: account.tenantId, cursorToAt: null, status: BATCH.FAILED } });
    if (failed > 0) {
      console.error(`${slug}: REFUSED — ${failed} failed window-era batch(es) hold unbilled usage; resolve them first`);
      refused += 1;
      continue;
    }

    const oldPosition = await windowEraEnd(account.tenantId);
    if (!oldPosition) {
      await prisma.billingCursor.create({ data: { tenantId: account.tenantId, lastProcessedAt: syncFrom, lastEventId: "" } });
      console.log(`${slug}: no window history — cursor at sync_from ${syncFrom.toISOString()}`);
      cutover += 1;
      continue;
    }

    const newAt = new Date(Math.max(oldPosition.getTime() - MARGIN_MS, syncFrom.getTime()));
    const seeds = await spanKeys(slug, new Date(Math.max(syncFrom.getTime(), newAt.getTime() - eventKeyRetentionMs)), oldPosition);

    await prisma.$transaction(async (tx) => {
      if (seeds.length) await tx.billedUsageEvent.createMany({ data: asKeys(account.tenantId, seeds), skipDuplicates: true });
      await tx.billingCursor.create({ data: { tenantId: account.tenantId, lastProcessedAt: newAt, lastEventId: "" } });
    });

    console.log(
      `${slug}: windows billed to ${oldPosition.toISOString()} → cursor ${newAt.toISOString()}, ${seeds.length} already-billed span(s) seeded`,
    );
    cutover += 1;
  }

  if (deleteSkipped) {
    // Only for tenants now on the cursor: these rows were the window cursor.
    const onCursor = (await prisma.billingCursor.findMany({ select: { tenantId: true } })).map((c) => c.tenantId);
    const { count } = await prisma.usageSyncBatch.deleteMany({
      where: { tenantId: { in: onCursor }, cursorToAt: null, status: BATCH.SKIPPED, spanCount: 0 },
    });
    console.log(`deleted ${count} empty window-era 'skipped' batch row(s)`);
  }

  console.log(`\ncut over: ${cutover}, refused: ${refused}, total accounts: ${accounts.length}`);
  await ch.close();
  await prisma.$disconnect();
  if (refused > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
