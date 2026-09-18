/**
 * Retention of usage-event idempotency keys.
 *
 * A key is needed exactly as long as its span can still be read: the sync
 * never reads a span whose Timestamp is more than the key horizon behind the
 * tenant's cursor. So a key goes only once its span is below that floor — by
 * the cursor's position, never by the clock.
 */

import { describe, expect, it } from "vitest";

import { pruneBilledEventKeys } from "@/lib/retention";
import { AFTER_ALL } from "@/lib/usage-events";
import { createUsageSync } from "@/lib/usage-sync";
import { FakeChargebee, FakeUsageSource, MINUTE, RATE, SLUG, T0, TENANT, makeFakePrisma, quietLogger } from "./harness";

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const OTHER = "22222222-2222-4222-8222-222222222222";

function key(prisma: ReturnType<typeof makeFakePrisma>, tenantId: string, eventKey: string, ingestedAt: number) {
  prisma._billed.set(`${tenantId}|${eventKey}`, { tenantId, eventKey, batchId: null, ingestedAt: new Date(ingestedAt), createdAt: new Date(ingestedAt) });
}

function cursor(prisma: ReturnType<typeof makeFakePrisma>, tenantId: string, at: number) {
  prisma._cursors.set(tenantId, { tenantId, lastProcessedAt: new Date(at), lastEventId: AFTER_ALL, lockedUntil: null, lockedBy: null });
}

describe("pruneBilledEventKeys", () => {
  it("deletes keys below each tenant's floor, and nothing a re-insert could still reach", async () => {
    const prisma = makeFakePrisma();
    cursor(prisma, TENANT, T0);
    key(prisma, TENANT, "old:1", T0 - 8 * DAY);
    key(prisma, TENANT, "old:2", T0 - 7 * DAY - 2 * HOUR);
    key(prisma, TENANT, "edge:1", T0 - 7 * DAY - 30 * MINUTE); // inside the skew margin: kept
    key(prisma, TENANT, "fresh:1", T0 - 6 * DAY);

    const { deleted } = await pruneBilledEventKeys({ prisma: prisma as never, retentionMs: 7 * DAY });

    expect(deleted).toBe(2);
    expect([...prisma._billed.values()].map((b: { eventKey: string }) => b.eventKey)).toEqual(["edge:1", "fresh:1"]);
  });

  it("keeps every key of a tenant whose cursor has stalled, however old", async () => {
    // Held for insufficient credits for a month: its floor has not moved, so
    // its spans are still readable and its keys still needed.
    const prisma = makeFakePrisma();
    cursor(prisma, TENANT, T0);
    cursor(prisma, OTHER, T0 - 30 * DAY);
    key(prisma, OTHER, "stalled:1", T0 - 31 * DAY);
    key(prisma, TENANT, "moving:1", T0 - 31 * DAY);

    await pruneBilledEventKeys({ prisma: prisma as never, retentionMs: 7 * DAY });

    expect([...prisma._billed.values()].map((b: { eventKey: string }) => b.eventKey)).toEqual(["stalled:1"]);
  });

  it("pruning never lets usage behind the cursor be charged again", async () => {
    const prisma = makeFakePrisma({ syncFrom: new Date(T0) });
    const usage = new FakeUsageSource();
    const chargebee = new FakeChargebee();
    let now = T0 + 5 * MINUTE;
    usage.nowMs = now;
    const sync = createUsageSync({ prisma: prisma as never, usage, chargebee, usdPerCredit: RATE, lagMs: 2 * MINUTE, eventKeyRetentionMs: DAY, clock: () => now, logger: quietLogger });

    usage.add("t1:s1", T0 + MINUTE);
    await sync.runTenant(SLUG);
    expect(chargebee.appliedCount).toBe(1);

    now += 3 * DAY;
    usage.nowMs = now;
    await sync.runTenant(SLUG);
    await pruneBilledEventKeys({ prisma: prisma as never, retentionMs: DAY });
    expect(prisma._billed.size).toBe(0);

    usage.add("t1:s1", now - 10 * MINUTE, 0.001, T0 + MINUTE); // re-inserted long after
    now += 10 * MINUTE;
    usage.nowMs = now;
    await sync.runTenant(SLUG);
    expect(chargebee.appliedCount).toBe(1);
  });
});
