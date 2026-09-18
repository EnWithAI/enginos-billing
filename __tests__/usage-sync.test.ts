/**
 * The usage sync: ClickHouse → cursor → idempotent capture → ledger.
 *
 * The assertion is almost always the same pair: how many times did money
 * actually move (FakeChargebee.appliedCount / taken), and where is the cursor?
 * A charge twice or a cursor past unbilled usage are the only two ways this
 * fails badly.
 */

import { describe, expect, it } from "vitest";

import { CAPTURE_INSUFFICIENT, CAPTURE_NO_LEDGER, CAPTURE_TERMINAL } from "@/lib/chargebee";
import { createAccounts } from "@/lib/account";
import { pruneBilledEventKeys } from "@/lib/retention";
import { AFTER_ALL } from "@/lib/usage-events";
import { OUTCOME, createUsageSync, type UsageSyncDeps } from "@/lib/usage-sync";
import { FakeChargebee, FakeUsageSource, MINUTE, RATE, SLUG, T0, TENANT, makeFakePrisma, quietLogger } from "./harness";

const LAG = 2 * MINUTE;
const at = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 8, 16, hh, mm, ss);

function rig(opts: { balance?: number; syncFrom?: number; account?: Record<string, unknown> } = {}) {
  const prisma = makeFakePrisma({ syncFrom: new Date(opts.syncFrom ?? at(10, 0)), ...(opts.account ?? {}) });
  const chargebee = new FakeChargebee(opts.balance ?? 1000);
  const usage = new FakeUsageSource();
  const blocked: string[] = [];
  let now = at(10, 0);
  const make = (over: Partial<UsageSyncDeps> = {}) =>
    createUsageSync({
      prisma: prisma as never,
      usage,
      chargebee,
      usdPerCredit: RATE,
      lagMs: LAG,
      clock: () => now,
      logger: quietLogger,
      blockBudget: async (tenantId) => void blocked.push(tenantId),
      ...over,
    });
  const sync = make();
  return {
    prisma,
    chargebee,
    usage,
    sync,
    make,
    blocked,
    /** Move both clocks: the worker's and ClickHouse's. */
    tick(ms: number) {
      now = ms;
      usage.nowMs = ms;
    },
    cursor() {
      const c = prisma._cursors.get(TENANT)!;
      return { at: c.lastProcessedAt.getTime(), id: c.lastEventId };
    },
    batches() {
      return [...prisma._batches.values()];
    },
  };
}

describe("usage sync — the cursor", () => {
  it("normal: cursor 10:00, poll 10:03 → 10:00–10:01 billed, cursor to safe_until", async () => {
    const r = rig();
    r.usage.add("t1:s1", at(10, 0, 30), 0.002);
    r.tick(at(10, 3)); // safe_until = 10:01

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.CAPTURED);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.chargebee.taken).toBe(2); // $0.002 / $0.001 per credit
    expect(r.cursor()).toEqual({ at: at(10, 1), id: AFTER_ALL });
    expect(r.prisma._entries.filter((e: { entryType: string }) => e.entryType === "consume")).toHaveLength(1);
  });

  it("does not read usage ingested within the lag", async () => {
    const r = rig();
    r.usage.add("t1:s1", at(10, 2)); // lands after safe_until
    r.tick(at(10, 3));

    await r.sync.runTenant(SLUG);

    expect(r.chargebee.appliedCount).toBe(0);
    expect(r.cursor().at).toBe(at(10, 1));

    r.tick(at(10, 5)); // now it has aged past the lag
    await r.sync.runTenant(SLUG);
    expect(r.chargebee.appliedCount).toBe(1);
  });

  it("worker downtime: cursor 10:00, back at 10:20 → everything to 10:18 billed in one tick", async () => {
    const r = rig();
    for (let m = 0; m < 18; m++) r.usage.add(`t${m}:s`, at(10, m, 10));
    r.tick(at(10, 20));

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.CAPTURED);
    expect(r.chargebee.taken).toBe(18);
    expect(r.cursor()).toEqual({ at: at(10, 18), id: AFTER_ALL });
  });

  it("a backlog larger than one page is paged, each page one capture, none skipped", async () => {
    const r = rig();
    for (let i = 0; i < 25; i++) r.usage.add(`t${String(i).padStart(2, "0")}:s`, at(10, 0, i));
    r.tick(at(10, 5));
    const sync = r.make({ maxEventsPerCapture: 10 });

    await sync.runTenant(SLUG);

    expect(r.chargebee.appliedCount).toBe(3); // 10 + 10 + 5
    expect(r.chargebee.taken).toBe(25);
    expect(r.prisma._billed.size).toBe(25);
  });

  it("same createdAt: events sharing an instant across a page boundary are none skipped", async () => {
    const r = rig();
    const t = at(10, 0, 30);
    r.usage.add("aaa:1", t).add("bbb:1", t).add("ccc:1", t);
    r.tick(at(10, 3));
    const sync = r.make({ maxEventsPerCapture: 2 });

    await sync.runTenant(SLUG);

    expect(r.chargebee.appliedCount).toBe(2); // [A,B] then [C]
    expect(r.chargebee.taken).toBe(3);
    expect([...r.prisma._billed.values()].map((b: { eventKey: string }) => b.eventKey).sort()).toEqual(["aaa:1", "bbb:1", "ccc:1"]);
  });

  it("a full page entirely inside the cursor's millisecond is captured (zero-width range)", async () => {
    const r = rig();
    const sync = r.make({ maxEventsPerCapture: 2 });
    const t = at(10, 0, 30);
    r.usage.add("a", t).add("b", t).add("c", t).add("d", t).add("e", t);
    r.tick(at(10, 3));

    await sync.runTenant(SLUG);

    // (10:00, "") → (t, b) → (t, d): the second capture starts and ends at t.
    expect(r.batches().map((b) => b.windowStart.getTime() === b.windowEnd.getTime())).toEqual([false, true, false]);
    expect(r.chargebee.appliedCount).toBe(3);
    expect(r.chargebee.taken).toBe(5);
  });

  it("empty window: cursor moves to safe_until with no billing operation", async () => {
    const r = rig();
    r.tick(at(10, 3));

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.IDLE);
    expect(r.chargebee.captures).toHaveLength(0);
    expect(r.batches()).toHaveLength(0);
    expect(r.cursor()).toEqual({ at: at(10, 1), id: AFTER_ALL });
  });

  it("never bills usage from before the account's sync_from", async () => {
    const r = rig({ syncFrom: at(10, 0) });
    // Ingested after the cursor, but the LLM call itself predates the account.
    r.usage.add("old:1", at(10, 0, 30), 0.005, at(9, 59));
    r.usage.add("new:1", at(10, 0, 40), 0.001, at(10, 0, 20));
    r.tick(at(10, 3));

    await r.sync.runTenant(SLUG);

    expect(r.chargebee.taken).toBe(1);
  });

  it("a span the collector re-sent (same key, later ingested_at) is not charged again", async () => {
    const r = rig();
    r.usage.add("dup:1", at(10, 0, 30));
    r.tick(at(10, 3));
    await r.sync.runTenant(SLUG);

    r.usage.add("dup:1", at(10, 2, 0)); // re-sent copy lands later
    r.tick(at(10, 5));
    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.IDLE);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.cursor().at).toBe(at(10, 3));
  });

  it("re-running with no new usage charges nothing more", async () => {
    const r = rig();
    r.usage.add("t1:s1", at(10, 0, 30));
    r.tick(at(10, 3));
    await r.sync.runTenant(SLUG);
    await r.sync.runTenant(SLUG);
    r.tick(at(10, 4));
    await r.sync.runTenant(SLUG);

    expect(r.chargebee.appliedCount).toBe(1);
  });
});

describe("usage sync — failures", () => {
  it("Chargebee timeout: charge landed, response lost → cursor held, next tick finds it, charged once", async () => {
    const r = rig();
    r.usage.add("t1:s1", at(10, 0, 30));
    r.tick(at(10, 3));
    r.chargebee.loseResponseNext = true;

    const first = await r.sync.runTenant(SLUG);
    expect(first.outcome).toBe(OUTCOME.PENDING);
    expect(r.cursor().at).toBe(at(10, 0)); // did NOT advance
    expect(r.batches()[0]!.status).toBe("pending");

    r.tick(at(10, 4));
    const second = await r.sync.runTenant(SLUG);
    expect(second.outcome).toBe(OUTCOME.REPLAYED);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.chargebee.captures.map((c) => c.id)).toEqual([r.batches()[0]!.id, r.batches()[0]!.id]); // same id, both times
    // Settled, then the same tick polled on to the new safe_until.
    expect(r.cursor().at).toBe(at(10, 2));
  });

  it("worker crash before the capture: cursor behind, same events read again, charged once", async () => {
    const r = rig();
    r.usage.add("t1:s1", at(10, 0, 30)).add("t2:s1", at(10, 0, 40));
    r.tick(at(10, 3));
    r.chargebee.crashNext = "before";

    await expect(r.sync.runTenant(SLUG)).rejects.toThrow(/killed/);
    expect(r.cursor().at).toBe(at(10, 0));
    expect(r.chargebee.appliedCount).toBe(0);

    await r.sync.runTenant(SLUG);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.chargebee.taken).toBe(2);
    expect(r.batches()).toHaveLength(1); // the same capture, not a second one
  });

  it("worker crash after the charge landed: replayed, not re-charged", async () => {
    const r = rig();
    r.usage.add("t1:s1", at(10, 0, 30));
    r.tick(at(10, 3));
    r.chargebee.crashNext = "after";

    await expect(r.sync.runTenant(SLUG)).rejects.toThrow(/killed/);
    expect(r.cursor().at).toBe(at(10, 0));

    const result = await r.sync.runTenant(SLUG);
    expect(result.outcome).toBe(OUTCOME.REPLAYED);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.prisma._entries.filter((e: { entryType: string }) => e.entryType === "consume")).toHaveLength(1);
  });

  it("partial processing: page 2 fails → cursor stops at the end of page 1, page 2 retried", async () => {
    const r = rig();
    for (let i = 0; i < 4; i++) r.usage.add(`t${i}:s`, at(10, 0, 10 + i));
    r.tick(at(10, 3));
    const sync = r.make({ maxEventsPerCapture: 2 });

    // First capture succeeds, second times out.
    const original = r.chargebee.captureIdempotent.bind(r.chargebee);
    let n = 0;
    r.chargebee.captureIdempotent = async (args) => {
      n += 1;
      if (n === 2) r.chargebee.loseResponseNext = true;
      return original(args);
    };

    const first = await sync.runTenant(SLUG);
    expect(first.outcome).toBe(OUTCOME.PENDING);
    expect(r.cursor()).toEqual({ at: at(10, 0, 11), id: "t1:s" }); // end of page 1

    await sync.runTenant(SLUG);
    expect(r.chargebee.appliedCount).toBe(2);
    expect(r.chargebee.taken).toBe(4);
    expect(r.cursor()).toEqual({ at: at(10, 1), id: AFTER_ALL });
  });

  it("a ClickHouse failure leaves nothing behind and the cursor where it was", async () => {
    const r = rig();
    r.tick(at(10, 3));
    r.usage.throwNext = new Error("clickhouse down");

    await expect(r.sync.runTenant(SLUG)).rejects.toThrow("clickhouse down");
    expect(r.batches()).toHaveLength(0);
    expect(r.cursor().at).toBe(at(10, 0));
    // The lease was released: the next tick is not locked out.
    expect((await r.sync.runTenant(SLUG)).outcome).toBe(OUTCOME.IDLE);
  });

  it("a terminal refusal fails the capture and holds billing", async () => {
    const r = rig();
    r.usage.add("t1:s1", at(10, 0, 30));
    r.tick(at(10, 3));
    r.chargebee.fail({ kind: CAPTURE_TERMINAL, error: Object.assign(new Error("invalid amount"), { status: 400 }) });

    expect((await r.sync.runTenant(SLUG)).outcome).toBe(OUTCOME.FAILED);
    r.usage.add("t2:s1", at(10, 1, 30));
    r.tick(at(10, 5));
    expect((await r.sync.runTenant(SLUG)).outcome).toBe(OUTCOME.HELD);
    expect(r.chargebee.appliedCount).toBe(0);
    expect(r.cursor().at).toBe(at(10, 0));
  });

  it("no prepaid ledger: nothing charged, recorded loudly, cursor moves on", async () => {
    const r = rig();
    r.usage.add("t1:s1", at(10, 0, 30));
    r.tick(at(10, 3));
    r.chargebee.fail({ kind: CAPTURE_NO_LEDGER, error: new Error("resource_not_found") });

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.NOT_BILLABLE);
    expect(r.batches()[0]!.status).toBe("skipped");
    expect(r.cursor().at).toBe(at(10, 1));
  });

  it("credits used up: capture refused, account exhausted, team blocked, billing held — a top-up resumes it", async () => {
    const r = rig();
    r.usage.add("t1:s1", at(10, 0, 30), 0.005);
    r.tick(at(10, 3));
    r.chargebee.fail({ kind: CAPTURE_INSUFFICIENT, error: new Error("Not enough balance exists in the account.") });

    expect((await r.sync.runTenant(SLUG)).outcome).toBe(OUTCOME.FAILED);
    expect(r.prisma._accounts.get(TENANT)!.status).toBe("exhausted");
    expect(r.blocked).toEqual([TENANT]);
    expect(r.cursor().at).toBe(at(10, 0));

    // A top-up lands: account.ts reopens the refused capture.
    const accounts = createAccounts({
      prisma: r.prisma as never,
      chargebee: { balance: async () => ({ unitId: "token", unitName: "token", usable: "1000", onHold: "0" }), grantedCredits: async () => ({ credits: "1000", blocks: 1 }) } as never,
      usdPerCredit: RATE,
      logger: quietLogger,
    });
    await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "sub:sub_1:2" });

    r.tick(at(10, 4));
    const resumed = await r.sync.runTenant(SLUG);
    expect([OUTCOME.CAPTURED, OUTCOME.REPLAYED]).toContain(resumed.outcome);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.chargebee.taken).toBe(5);
    expect(r.cursor().at).toBe(at(10, 2));
  });

  it("a cancelled account settles what is pending, then bills nothing new", async () => {
    const r = rig();
    r.usage.add("t1:s1", at(10, 0, 30));
    r.tick(at(10, 3));
    r.chargebee.loseResponseNext = true;
    await r.sync.runTenant(SLUG); // pending

    r.prisma._accounts.get(TENANT)!.status = "cancelled";
    r.usage.add("t2:s1", at(10, 3, 0));
    r.tick(at(10, 8));
    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.NOT_BILLABLE);
    expect(r.chargebee.appliedCount).toBe(1); // the pending one, settled
    expect(r.batches()).toHaveLength(1);
  });

  it("the regular pass still resolves a pending capture after the account leaves active", async () => {
    // Otherwise an unknown outcome on a tenant that then cancelled (or went
    // activating) would never be looked up again: a charge with no ledger row.
    const r = rig();
    r.usage.add("t1:s1", at(10, 0, 30));
    r.tick(at(10, 3));
    r.chargebee.loseResponseNext = true;
    await r.sync.runOnce();
    expect(r.batches()[0]!.status).toBe("pending");

    r.prisma._accounts.get(TENANT)!.status = "cancelled";
    r.tick(at(10, 4));
    const summary = await r.sync.runOnce();

    expect(summary.tenantsScanned).toBe(1);
    expect(r.batches()[0]!.status).toBe("captured");
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.prisma._entries).toHaveLength(1);
  });

  it("a tenant with no subscription is never charged", async () => {
    const r = rig({ account: { chargebeeSubscriptionId: null } });
    r.usage.add("t1:s1", at(10, 0, 30));
    r.tick(at(10, 3));

    expect((await r.sync.runTenant(SLUG)).outcome).toBe(OUTCOME.NOT_BILLABLE);
    expect(r.chargebee.captures).toHaveLength(0);
  });
});

describe("usage sync — concurrency", () => {
  it("two workers on one tenant: the lease lets exactly one proceed", async () => {
    const r = rig();
    r.usage.add("t1:s1", at(10, 0, 30));
    r.tick(at(10, 3));
    const a = r.make({ workerId: "A" });
    const b = r.make({ workerId: "B" });

    const [ra, rb] = await Promise.all([a.runTenant(SLUG), b.runTenant(SLUG)]);

    expect([ra.outcome, rb.outcome].sort()).toEqual([OUTCOME.CAPTURED, OUTCOME.LOCKED].sort());
    expect(r.chargebee.appliedCount).toBe(1);
  });

  it("a lease left by a crashed worker expires; the next worker takes over", async () => {
    const r = rig();
    r.usage.add("t1:s1", at(10, 0, 30));
    r.tick(at(10, 3));
    await r.sync.runTenant(SLUG); // creates the cursor
    r.prisma._cursors.get(TENANT)!.lockedBy = "dead-worker";
    r.prisma._cursors.get(TENANT)!.lockedUntil = new Date(at(10, 4));

    r.tick(at(10, 3, 30));
    expect((await r.sync.runTenant(SLUG)).outcome).toBe(OUTCOME.LOCKED);

    r.tick(at(10, 6));
    expect((await r.sync.runTenant(SLUG)).outcome).not.toBe(OUTCOME.LOCKED);
  });

  it("releases the lease after every run", async () => {
    const r = rig();
    r.tick(at(10, 3));
    await r.sync.runTenant(SLUG);

    expect(r.prisma._cursors.get(TENANT)).toMatchObject({ lockedBy: null, lockedUntil: null });
  });
});

describe("usage sync — re-inserted spans (key horizon)", () => {
  // A span re-inserted into span_nodes — a collector re-send, or a platform
  // migration rebuilding the table from otel_traces — comes back with a NEW
  // ingested_at, after the cursor. Within the horizon its key stops it; below
  // the horizon the read floor does.
  const HORIZON = 10 * MINUTE;

  it("a span_nodes rebuild within the horizon re-presents billed spans; their keys skip them", async () => {
    const r = rig();
    const sync = r.make({ eventKeyRetentionMs: HORIZON });
    r.usage.add("t1:s1", at(10, 0, 30));
    r.tick(at(10, 3));
    await sync.runTenant(SLUG);

    r.usage.events = []; // TRUNCATE + INSERT … SELECT: same span, fresh ingested_at
    r.usage.add("t1:s1", at(10, 6), 0.001, at(10, 0, 30));
    r.tick(at(10, 9));
    await sync.runTenant(SLUG);

    expect(r.chargebee.appliedCount).toBe(1);
  });

  it("a rebuild after the key was pruned re-presents a span below the floor; it is never read", async () => {
    const r = rig();
    const sync = r.make({ eventKeyRetentionMs: HORIZON });
    r.usage.add("t1:s1", at(10, 0, 30));
    r.tick(at(10, 3));
    await sync.runTenant(SLUG);
    r.tick(at(14, 0));
    await sync.runTenant(SLUG); // idle: cursor to 13:58

    await pruneBilledEventKeys({ prisma: r.prisma as never, retentionMs: HORIZON });
    expect(r.prisma._billed.size).toBe(0);

    r.usage.events = [];
    r.usage.add("t1:s1", at(14, 1), 0.001, at(10, 0, 30)); // the rebuild
    r.usage.add("t2:s1", at(14, 1, 30)); // and genuinely new usage
    r.tick(at(14, 5));
    await sync.runTenant(SLUG);

    expect(r.chargebee.appliedCount).toBe(2); // t1:s1 once, t2:s1 once
    expect(r.chargebee.taken).toBe(2);
  });

  it("the floor never hides unbilled usage: it trails the cursor, not the clock", async () => {
    // Held for weeks: the cursor stays put, so its floor does too, and usage
    // after it still bills when the hold lifts.
    const r = rig({ syncFrom: at(10, 0) - 30 * 24 * 60 * MINUTE });
    r.prisma._cursors.set(TENANT, { tenantId: TENANT, lastProcessedAt: new Date(at(10, 0) - 20 * 24 * 60 * MINUTE), lastEventId: AFTER_ALL, lockedUntil: null, lockedBy: null });
    r.usage.add("old:1", at(10, 0) - 19 * 24 * 60 * MINUTE);
    r.tick(at(10, 3));

    await r.sync.runTenant(SLUG);

    expect(r.chargebee.taken).toBe(1);
  });
});

describe("usage sync — cutover safety", () => {
  it("refuses to start a cursor for a tenant with window-era billing history", async () => {
    // Starting at sync_from would read — and charge — everything the window
    // era already billed. The cutover script must run first.
    const r = rig();
    r.prisma._batches.set("old", {
      id: "old", tenantId: TENANT, kind: "window", status: "captured", windowStart: new Date(at(9, 0)), windowEnd: new Date(at(9, 1)),
      spanCount: 1n, billedUsd: "0.001", providerUsd: "0.001", marginUsd: "0", consumeCredits: "1", attempts: 0,
      lastError: null, chargebeeOperationId: "old", balanceAfter: null, hatchetRunId: null, capturedAt: new Date(at(9, 2)),
      chargebeeSubscriptionId: "sub_1", ledgerUnitId: "token",
    } as never);
    r.usage.add("t1:s1", at(10, 0, 30));
    r.tick(at(10, 3));

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.HELD);
    expect(r.prisma._cursors.size).toBe(0);
    expect(r.usage.reads).toHaveLength(0);
  });

  it("skips events seeded at cutover as already billed by the window era", async () => {
    const r = rig();
    r.prisma._cursors.set(TENANT, { tenantId: TENANT, lastProcessedAt: new Date(at(9, 50)), lastEventId: "", lockedUntil: null, lockedBy: null });
    r.prisma._billed.set(`${TENANT}|old:1`, { tenantId: TENANT, eventKey: "old:1", batchId: null, ingestedAt: new Date(at(9, 55)) });
    r.usage.add("old:1", at(9, 55)).add("new:1", at(10, 0, 30));
    r.tick(at(10, 3));

    await r.sync.runTenant(SLUG);

    expect(r.chargebee.taken).toBe(1); // only new:1
  });
});

describe("usage sync — money", () => {
  it("sums sub-cent events exactly, as decimals", async () => {
    const r = rig();
    r.usage.add("a:1", at(10, 0, 10), 1e-7).add("b:1", at(10, 0, 20), 2e-7);
    r.tick(at(10, 3));

    await r.sync.runTenant(SLUG);

    expect(r.batches()[0]).toMatchObject({ billedUsd: "0.0000003", consumeCredits: "0.0003" });
  });

  it("zero-cost events are recorded but never sent to Chargebee", async () => {
    const r = rig();
    r.usage.add("free:1", at(10, 0, 30), 0);
    r.tick(at(10, 3));

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.IDLE);
    expect(r.chargebee.captures).toHaveLength(0);
    expect(r.batches()[0]!.status).toBe("skipped");
    expect(r.cursor().at).toBe(at(10, 1));
  });

  it("the ledger always equals what Chargebee took", async () => {
    const r = rig();
    for (let m = 0; m < 6; m++) r.usage.add(`t${m}:s`, at(10, m, 5), 0.0015);
    for (let m = 1; m <= 8; m++) {
      r.tick(at(10, m));
      if (m === 4) r.chargebee.loseResponseNext = true;
      await r.sync.runTenant(SLUG);
    }

    const ledger = r.prisma._entries.filter((e: { entryType: string }) => e.entryType === "consume").reduce((s: number, e: { deltaCredits: string }) => s - Number(e.deltaCredits), 0);
    expect(ledger).toBeCloseTo(r.chargebee.taken, 10);
    expect(r.chargebee.taken).toBeCloseTo(9, 10);
  });

  it("stays pending past maxAttempts and escalates, never failing an unknown", async () => {
    const r = rig();
    r.usage.add("t1:s1", at(10, 0, 30));
    const errors: Array<{ metric?: string }> = [];
    const sync = r.make({ maxAttempts: 2, logger: { ...quietLogger, error: (o: unknown) => errors.push(o as { metric?: string }) } });
    r.tick(at(10, 3));
    for (let i = 0; i < 3; i++) {
      r.chargebee.fail({ kind: "retryable", error: Object.assign(new Error("503"), { retryable: true }) } as never);
      expect((await sync.runTenant(SLUG)).outcome).toBe(OUTCOME.PENDING);
    }
    expect(r.batches()[0]!.status).toBe("pending");
    expect(errors.filter((e) => e.metric === "billing.sync.stuck")).toHaveLength(2);
  });
});
