/**
 * COMPOUND flows: several ticks, several statuses, crashes mid-chain.
 *
 * The other suites test one thing going wrong once. This one tests SEQUENCES —
 * a tenant that is throttled, then loses the response, then runs out of
 * credits, then tops up, then cancels — because that is the shape of a real
 * incident, and because a state machine can be correct in every single
 * transition and still be wrong in a chain.
 *
 * Two assertions recur, and they are the only two that matter:
 *
 *   chargebee.appliedCount / taken   the customer was charged ONCE, for exactly
 *                                    what they used
 *   coverage of the sync log         every ClickHouse range the cursor passed
 *                                    over was covered by a SUCCESS row
 *
 * The second is checked by `billedRanges()` rather than by eyeballing the
 * cursor, because "the cursor moved" and "the usage under it was billed" are
 * exactly the two things this refactor separated.
 */

import { describe, expect, it } from "vitest";

import { PROCESSING_LEASE_MS, SYNC } from "@/models/sync-status";
import { createUsageSyncService, OUTCOME } from "@/services/usage-sync.service";

import { FakeChargebee, FakeUsageSource, MINUTE, RATE, SLUG, T0, TENANT, makeFakePrisma, quietLogger } from "./harness";

/** windowMs = lagMs = one minute, so a window at cursor C is due at C + 2 min. */
const LAG = MINUTE;

function rig(opts: { balance?: number; account?: Record<string, unknown>; cursorAt?: number } = {}) {
  const prisma = makeFakePrisma(opts.account ?? {}, opts.cursorAt ?? T0);
  const usage = new FakeUsageSource();
  const chargebee = new FakeChargebee(opts.balance ?? 1000);
  const blocked: Array<{ tenantId: string; reason?: string }> = [];
  let now = T0;

  const build = (overrides: Record<string, unknown> = {}) =>
    createUsageSyncService({
      prisma: prisma as never,
      usage,
      chargebee,
      usdPerCredit: RATE,
      lagMs: LAG,
      windowMs: MINUTE,
      clock: () => now,
      logger: quietLogger,
      blockBudget: async (tenantId, reason) => void blocked.push({ tenantId, reason }),
      ...overrides,
    });

  const worker = build();

  return {
    prisma,
    usage,
    chargebee,
    blocked,
    build,
    worker,
    /** Move every clock to T0 + m minutes. */
    at(m: number) {
      now = T0 + m * MINUTE;
      usage.nowMs = now;
      prisma._now = now;
      return this;
    },
    tick: () => worker.runTenant(SLUG),
    /** Where the worker is, in whole minutes past T0. */
    cursorMin: () => (prisma._cursor == null ? null : (prisma._cursor - T0) / MINUTE),
    /**
     * Every range a SUCCESS row covers, in minutes past T0.
     *
     * The invariant this exists for: the cursor may only be at minute N if the
     * ranges [0,N) are covered contiguously by settled rows or were genuinely
     * empty. Comparing this with `cursorMin()` catches a cursor that moved over
     * usage nobody billed — which "the cursor advanced" alone cannot.
     */
    billedRanges: () =>
      prisma._log
        .filter((s: { status: string }) => s.status === SYNC.SUCCESS)
        .map((s: { fromIngestedAt: Date; toIngestedAt: Date }) => [
          (s.fromIngestedAt.getTime() - T0) / MINUTE,
          (s.toIngestedAt.getTime() - T0) / MINUTE,
        ]),
  };
}

// ── a chain across three different failure states ─────────────────────────

describe("a window that is throttled, then lost, then finally lands", () => {
  it("crosses RATE_LIMITING → UNKNOWN → SUCCESS on one row, charging once", async () => {
    // Three DIFFERENT Chargebee answers for the same window, on three ticks,
    // each with its own retry policy. The row, the id and the amount must be
    // the same throughout — a new row at any step would be a second charge.
    const r = rig();
    r.usage.add("t1:s1", T0 + 30_000, 0.002);

    // Tick 1 — throttled. Refused before it was applied.
    r.at(2);
    r.chargebee.rateLimitNext = true;
    expect((await r.tick()).outcome).toBe(OUTCOME.RATE_LIMITED);
    const rowId = r.prisma._stuck!.id;
    expect(r.chargebee.appliedCount).toBe(0);

    // Tick 2 — inside the 1-minute backoff. Nothing is sent at all.
    r.at(2.5);
    const sentBefore = r.chargebee.captures.length;
    expect((await r.tick()).outcome).toBe(OUTCOME.HOLDING);
    expect(r.chargebee.captures.length).toBe(sentBefore);

    // Tick 3 — past the backoff. It goes, lands, and the response is lost.
    r.at(4);
    r.chargebee.loseResponseNext = true;
    expect((await r.tick()).outcome).toBe(OUTCOME.UNKNOWN);
    expect(r.chargebee.appliedCount).toBe(1); // the money HAS moved
    expect(r.prisma._stuck!.id).toBe(rowId);
    expect(r.cursorMin()).toBe(0); // and we do not know it, so nothing advances

    // Tick 4 — the lookup finds it. Settled without a second send.
    r.at(5);
    const done = await r.tick();
    expect(done.outcome).toBe(OUTCOME.REPLAYED);

    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.chargebee.taken).toBe(2);
    expect(r.prisma._log).toHaveLength(1);
    expect(r.prisma._log[0]!.id).toBe(rowId);
    expect(r.prisma._log[0]!.status).toBe(SYNC.SUCCESS);
    expect(r.billedRanges()).toContainEqual([0, 1]);
  });
});

// ── a backlog that builds behind a hold, then drains in order ──────────────

describe("credits run out, usage keeps arriving, then a top-up", () => {
  it("drains the whole backlog in window order with no gap and no repeat", async () => {
    // THE case the "no requeue step" claim rests on. Usage accrues for four
    // minutes while Chargebee refuses; the cursor holds at the first window,
    // and after the top-up every minute must be billed exactly once, in order.
    const r = rig({ balance: 0 });
    for (let m = 0; m < 4; m += 1) r.usage.add(`t${m}:s1`, T0 + m * MINUTE + 30_000, 0.001);

    r.at(2);
    r.chargebee.insufficient = true;
    expect((await r.tick()).outcome).toBe(OUTCOME.OUT_OF_CREDITS);
    expect(r.prisma._accounts.get(TENANT)!.status).toBe("exhausted");
    expect(r.blocked).toEqual([{ tenantId: TENANT, reason: "exhausted" }]);

    // Three more ticks, still exhausted, more usage piling up behind it. The
    // tenant is held whole: Chargebee is not asked, since it could only refuse.
    const sent = r.chargebee.captures.length;
    for (const m of [3, 4, 5]) {
      r.at(m);
      expect(await r.tick()).toMatchObject({ outcome: OUTCOME.EXHAUSTED });
      expect(r.cursorMin()).toBe(0);
    }
    expect(r.chargebee.captures.length).toBe(sent);
    expect(r.prisma._log).toHaveLength(1); // ONE row, held — not four

    // The customer tops up, and activate() takes the account out of
    // `exhausted`. Nothing is requeued because nothing was dequeued.
    r.chargebee.insufficient = false;
    r.chargebee.balance = 1000;
    r.prisma._accounts.get(TENANT)!.status = "active";
    r.at(6);
    const drained = await r.tick();

    expect(drained.outcome).toBe(OUTCOME.SYNCED);
    // Four minutes of usage, four captures, four contiguous windows.
    expect(r.chargebee.appliedCount).toBe(4);
    expect(r.chargebee.taken).toBe(4);
    expect(r.billedRanges()).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    // Past the last billed minute, because the empty minute behind it is a
    // RESOLVED window too — it was read and found to contain nothing.
    expect(r.cursorMin()).toBe(5);
    expect(r.prisma._stuck).toBeUndefined();
  });
});

// ── a crash in the middle of a multi-window catch-up ───────────────────────

describe("a crash part-way through draining a backlog", () => {
  it("resumes at the window it died on, billing each window exactly once", async () => {
    // maxWindowsPerTick means a tick can bill several windows. Dying inside
    // that loop is the case where "how far did it get" and "what did Chargebee
    // take" can most easily disagree.
    const r = rig();
    for (let m = 0; m < 5; m += 1) r.usage.add(`t${m}:s1`, T0 + m * MINUTE + 30_000, 0.001);
    r.at(7); // everything up to minute 6 is now safe to read

    // Die on the THIRD window, after Chargebee has already taken it.
    r.chargebee.crashAfterCaptures = 3;
    await expect(r.tick()).rejects.toThrow();

    expect(r.chargebee.appliedCount).toBe(3);
    // Two windows settled and moved the cursor; the third is owed.
    expect(r.cursorMin()).toBe(2);
    expect(r.prisma._stuck!.status).toBe(SYNC.PROCESSING);

    // Restart. The owed window is PROCESSING, and a PROCESSING row belongs to
    // its sender until its lease runs out — the dead worker looks, from the
    // row, exactly like one still waiting on Chargebee. So the restart one
    // minute later holds, and nothing is sent or read.
    r.chargebee.crashAfterCaptures = null;
    r.at(8);
    expect((await r.tick()).outcome).toBe(OUTCOME.HOLDING);
    expect(r.chargebee.appliedCount).toBe(3);

    // Once the lease is over the owed window is recovered by lookup, then the rest drains.
    const lease = PROCESSING_LEASE_MS / MINUTE;
    r.at(7 + lease);
    const resumed = await r.tick();

    expect(resumed.outcome).toBe(OUTCOME.SYNCED);
    expect(r.chargebee.appliedCount).toBe(5); // five windows, five operations
    expect(r.chargebee.taken).toBe(5);
    expect(r.billedRanges()).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
    // Five billed minutes, then the empty ones behind them up to the lag.
    expect(r.cursorMin()).toBe(6 + lease);
  });
});

// ── two drivers, interleaved, over several ticks ───────────────────────────

describe("the cron and the manual sync route running together", () => {
  it("never bills a window twice however they interleave", async () => {
    // /api/internal/sync runs the SAME sync on demand and can overlap the cron.
    // Run them concurrently on every tick for several minutes.
    const r = rig();
    for (let m = 0; m < 4; m += 1) r.usage.add(`t${m}:s1`, T0 + m * MINUTE + 30_000, 0.001);

    const cron = r.build();
    const manual = r.build();

    for (const m of [2, 3, 4, 5, 6]) {
      r.at(m);
      await Promise.all([cron.runTenant(SLUG), manual.runTenant(SLUG)]);
    }

    // Four minutes of usage: four operations, four windows, no duplicates.
    expect(r.chargebee.appliedCount).toBe(4);
    expect(r.chargebee.taken).toBe(4);
    const ranges = r.billedRanges();
    expect(ranges).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    // No window appears twice in the log at all, settled or not.
    const starts = r.prisma._log.map((s: { fromIngestedAt: Date }) => s.fromIngestedAt.getTime());
    expect(new Set(starts).size).toBe(starts.length);
  });
});

// ── the whole life of an incident ──────────────────────────────────────────

describe("a full incident, start to finish", () => {
  it("quiet → billing → throttled → recovered → refused → topped up → cancelled, charging once per minute", async () => {
    // Two credits, and three billable minutes of usage: the third must be the
    // one that runs the customer out, so the chain passes through a recovery
    // and a refusal in the SAME tick.
    const r = rig({ balance: 2 });

    // Minute 0-1: quiet. The cursor moves, nothing is written.
    r.at(2);
    expect((await r.tick()).outcome).toBe(OUTCOME.IDLE);
    expect(r.prisma._log).toHaveLength(0);
    expect(r.cursorMin()).toBe(1);

    // Minute 1-2: usage, billed normally.
    r.usage.add("a:1", T0 + MINUTE + 30_000, 0.001);
    r.at(3);
    expect((await r.tick()).outcome).toBe(OUTCOME.SYNCED);
    expect(r.cursorMin()).toBe(2);

    // Minute 2-3: usage, but Chargebee throttles us. The cursor holds.
    r.usage.add("b:1", T0 + 2 * MINUTE + 30_000, 0.001);
    r.at(4);
    r.chargebee.rateLimitNext = true;
    expect((await r.tick()).outcome).toBe(OUTCOME.RATE_LIMITED);
    expect(r.cursorMin()).toBe(2);
    expect(r.chargebee.appliedCount).toBe(1);

    // Minute 3-4 accrues while we are still held behind minute 2-3.
    r.usage.add("c:1", T0 + 3 * MINUTE + 30_000, 0.001);

    // Past the backoff. ONE tick now does two things: it recovers the throttled
    // window — which takes the last credit — and then immediately runs out on
    // the window behind it.
    r.at(6);
    expect((await r.tick()).outcome).toBe(OUTCOME.OUT_OF_CREDITS);
    expect(r.chargebee.appliedCount).toBe(2);
    expect(r.chargebee.balance).toBe(0);
    expect(r.prisma._accounts.get(TENANT)!.status).toBe("exhausted");
    // Blocked TWICE in one tick, by the two independent paths that reach it:
    // the capture that left the Chargebee balance at zero, and the refusal of
    // the window behind it. Blocking is idempotent and best-effort, so the
    // duplicate is correct — but it must actually happen from both, because
    // either one alone can be the first to notice.
    expect(r.blocked).toEqual([
      { tenantId: TENANT, reason: "exhausted" },
      { tenantId: TENANT, reason: "exhausted" },
    ]);
    // The recovered window moved the cursor; the refused one did not.
    expect(r.cursorMin()).toBe(3);

    // Top-up, and activate() takes the account out of `exhausted`. The held
    // minute goes through on the next ordinary tick, with no requeue step,
    // because it was never taken off the queue.
    r.chargebee.balance = 100;
    r.prisma._accounts.get(TENANT)!.status = "active";
    r.at(7);
    expect((await r.tick()).outcome).toBe(OUTCOME.SYNCED);
    expect(r.cursorMin()).toBe(6);

    // The customer cancels. Usage after it is not ours to charge.
    r.prisma._accounts.get(TENANT)!.status = "cancelled";
    r.usage.add("d:1", T0 + 6 * MINUTE + 30_000, 0.001);
    r.at(9);
    expect((await r.tick()).outcome).toBe(OUTCOME.NOT_BILLABLE);

    // Three billable minutes happened; three operations exist; each covers its
    // own minute and no other. The minute after cancellation is billed by
    // nobody.
    expect(r.chargebee.appliedCount).toBe(3);
    expect(r.chargebee.taken).toBe(3);
    expect(r.billedRanges()).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(r.prisma._log).toHaveLength(3);
  });
});

// ── the subscription changing underneath an owed window ───────────────────

describe("a subscription change while a window is still owed", () => {
  it("settles the owed window against the subscription that incurred the usage", async () => {
    // `chargebee_sync.chargebee_subscription_id` is pinned when the row is
    // created, and the schema says that is so a mid-term change still settles
    // against the right subscription. Nothing tested the claim.
    const r = rig();
    r.usage.add("t1:s1", T0 + 30_000, 0.002);

    r.at(2);
    r.chargebee.loseResponseNext = true;
    expect((await r.tick()).outcome).toBe(OUTCOME.UNKNOWN);
    const owed = r.prisma._stuck!;
    expect(owed.chargebeeSubscriptionId).toBe("sub_1");

    // The customer upgrades. The account now points somewhere else — and the
    // usage in that owed window was incurred under the OLD subscription.
    r.prisma._accounts.get(TENANT)!.chargebeeSubscriptionId = "sub_2";
    r.usage.add("t2:s1", T0 + MINUTE + 30_000, 0.003);

    r.at(4);
    await r.tick();

    const [first, second] = r.prisma._log;
    expect(first!.chargebeeSubscriptionId).toBe("sub_1"); // pinned, not re-read
    expect(second!.chargebeeSubscriptionId).toBe("sub_2"); // the new one, going forward
    expect(r.chargebee.appliedCount).toBe(2);
    expect(r.chargebee.taken).toBe(5);
    expect(r.billedRanges()).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it("does not lose the owed window when the subscription is unlinked entirely", async () => {
    // Cancellation clears nothing on the owed row, so the charge that may
    // already have landed can still be resolved. Losing it would leave money
    // taken and no record of it.
    const r = rig();
    r.usage.add("t1:s1", T0 + 30_000, 0.002);

    r.at(2);
    r.chargebee.loseResponseNext = true;
    expect((await r.tick()).outcome).toBe(OUTCOME.UNKNOWN);
    expect(r.chargebee.appliedCount).toBe(1); // it DID land

    r.prisma._accounts.get(TENANT)!.status = "cancelled";
    r.at(3);
    const settled = await r.tick();

    expect(settled.outcome).toBe(OUTCOME.REPLAYED);
    expect(r.prisma._log[0]!.status).toBe(SYNC.SUCCESS);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.prisma._stuck).toBeUndefined();
  });
});

// ── the window size changing between deploys ──────────────────────────────

describe("BILLING_WINDOW_MS changed while a settled row was owed", () => {
  it("follows the cursor the database committed, not the window it asked for", async () => {
    // FOUND BY AUDIT. The repair path moves the cursor to the SETTLED ROW's end,
    // which is not the end of the window the loop asked for once the two were
    // written under different window sizes. The loop used to carry on from its
    // own arithmetic regardless, leaving the in-memory cursor permanently ahead
    // of the stored one — and every window after that overlapped a range that
    // had already been billed. Silently, and for real money.
    const r = rig();
    r.usage.add("a:1", T0 + 30_000, 0.002);

    // Deploy 1: a one-minute window, billed, but the cursor advance is lost —
    // a crash between the SUCCESS write and the compare-and-set.
    r.at(2);
    await r.tick();
    expect(r.billedRanges()).toEqual([[0, 1]]);
    r.prisma._accounts.get(TENANT)!.lastProcessedIngestedAt = new Date(T0);

    // Deploy 2 raises the window to two minutes. The worker now asks for
    // (0, 2min] while a settled row covers only (0, 1min].
    const wide = r.build({ windowMs: 2 * MINUTE });
    r.usage.add("b:1", T0 + 90_000, 0.002);
    r.usage.add("c:1", T0 + 150_000, 0.002);
    r.at(8);
    await wide.runTenant(SLUG);

    // Every range billed exactly once, and no two of them overlap.
    const ranges = r.billedRanges();
    for (let i = 1; i < ranges.length; i += 1) {
      expect(ranges[i]![0]).toBeGreaterThanOrEqual(ranges[i - 1]![1]);
    }
    // Three events at 2 credits each, billed once each.
    expect(r.chargebee.taken).toBe(6);
    expect(r.chargebee.appliedCount).toBe(ranges.length);
  });

  it("stops rather than charging on when another worker already moved the cursor", async () => {
    // The same divergence from the other direction: the compare-and-set finds
    // the cursor already moved, so this worker's position is stale and it must
    // not open the next window from it.
    const r = rig();
    r.usage.add("a:1", T0 + 30_000, 0.002);
    r.usage.add("b:1", T0 + 90_000, 0.002);
    r.at(4);

    const sync = r.build({
      // Simulate the race: something moves the cursor between the capture
      // landing and our compare-and-set.
      prisma: new Proxy(r.prisma, {
        get(target: any, prop: string) {
          if (prop !== "chargebeeSync") return target[prop];
          return new Proxy(target.chargebeeSync, {
            get(sync: any, key: string) {
              if (key !== "updateMany") return sync[key];
              return async (args: any) => {
                const out = await sync.updateMany(args);
                if (args.data?.status === SYNC.SUCCESS && out.count === 1) {
                  target._accounts.get(TENANT)!.lastProcessedIngestedAt = new Date(T0 + 10 * MINUTE);
                }
                return out;
              };
            },
          });
        },
      }) as never,
    });

    await sync.runTenant(SLUG);

    // One capture, and the loop did NOT open a second window from a position
    // the database never held.
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.prisma._log).toHaveLength(1);
  });
});
