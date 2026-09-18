/**
 * Retention for usage-event idempotency keys (billed_usage_event).
 *
 * A key is needed exactly as long as its span can still be read. The sync reads
 * by ingested_at strictly after the cursor, so a billed original is never read
 * again — but a COPY can be: a collector re-send, or a platform migration that
 * rebuilds span_nodes from otel_traces, re-inserts the span with a fresh
 * ingested_at. Only the key stops that copy.
 *
 * The sync never reads a span whose Timestamp is more than the key horizon
 * behind the cursor (usage-sync.ts). So a key is deleted once its span is below
 * that floor — per tenant, by the cursor's position, never by the clock: a
 * tenant held for weeks keeps its floor, so it keeps its keys.
 *
 * The margin covers clock skew between the LLM host (Timestamp) and ClickHouse
 * (ingested_at, which is what the key records).
 */

import { prisma as defaultPrisma } from "./db";

export const DEFAULT_EVENT_KEY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const PRUNE_MARGIN_MS = 60 * 60 * 1000;

export async function pruneBilledEventKeys({
  prisma = defaultPrisma,
  retentionMs = DEFAULT_EVENT_KEY_RETENTION_MS,
}: {
  prisma?: typeof defaultPrisma;
  /** The key horizon. MUST equal the one the usage sync reads with. */
  retentionMs?: number;
} = {}): Promise<{ deleted: number }> {
  const cursors = await prisma.billingCursor.findMany({ select: { tenantId: true, lastProcessedAt: true } });
  let deleted = 0;
  for (const c of cursors) {
    const { count } = await prisma.billedUsageEvent.deleteMany({
      where: { tenantId: c.tenantId, ingestedAt: { lt: new Date(c.lastProcessedAt.getTime() - retentionMs - PRUNE_MARGIN_MS) } },
    });
    deleted += count;
  }
  return { deleted };
}
