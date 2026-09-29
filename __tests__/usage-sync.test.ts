/**
 * The cursor, the sync log, and everything that must not move past them.
 *
 * Every test here answers one of two questions: was this usage billed exactly
 * once, and did the cursor end up somewhere that can neither skip usage nor
 * offer it twice. `chargebee.appliedCount` answers the first;
 * `prisma._cursor` answers the second.
 *
 * The two are deliberately separate assertions, because they are separate
 * mechanisms: the cursor is worker progress, the sync row is the Chargebee
 * operation. A change that conflated them again would show up as one of these
 * passing while the other failed.
 */

import { describe, expect, it } from "vitest";

import {
  createChargebee,
  CAPTURE_INSUFFICIENT,
  CAPTURE_NO_LEDGER,
  CAPTURE_RATE_LIMITED,
  CAPTURE_RETRYABLE,
  CAPTURE_TERMINAL,
} from "@/integrations/chargebee";
import { SYNC } from "@/models/sync-status";
import { createUsageSyncService, OUTCOME } from "@/services/usage-sync.service";
import { windowQuery } from "@/integrations/clickhouse/usage-source";

import { FakeChargebee, FakeUsageSource, MINUTE, RATE, SLUG, T0, TENANT, makeFakePrisma, quietLogger } from "./harness";

/** One tenant, activated at T0, nothing owed — the ordinary starting state. */
function setup(opts: { cursorAt?: number | null; account?: Record<string, unknown>; balance?: number } = {}) {
  const prisma = makeFakePrisma(opts.account ?? {}, opts.cursorAt === null ? undefined : (opts.cursorAt ?? T0));
  const usage = new FakeUsageSource();
  const chargebee = new FakeChargebee(opts.balance ?? 1000);
  const blocked: string[] = [];

  const build = (overrides: Record<string, unknown> = {}) =>
    createUsageSyncService({
      prisma: prisma as never,
      usage,
      chargebee,
      usdPerCredit: RATE,
      // The read boundary is now − lag; a test that wants to read what it just
      // added moves `usage.nowMs` forward instead of turning the lag off.
      lagMs: MINUTE,
      clock: () => {
        prisma._now = usage.nowMs;
        return usage.nowMs;
      },
      logger: quietLogger,
      blockBudget: async (tenantId: string) => void blocked.push(tenantId),
      ...overrides,
    });

  return { prisma, usage, chargebee, blocked, build };
}

describe("the ClickHouse query", () => {
  const sql = windowQuery(SLUG);

  it("aggregates over events grouped by TraceId:SpanId, which is the event identity", () => {
    expect(sql).toContain("concat(TraceId, ':', SpanId)                           AS event_key");
    expect(sql).toContain("GROUP BY event_key");
    expect(sql).toContain("FROM tenant_org_acme_com.span_nodes FINAL");
    expect(sql).not.toContain("otel_traces");
  });

  it("totals the cost over DEDUPLICATED events, not over raw rows", () => {
    // The sum is outside the grouping. Summing first and counting distinctly
    // afterwards would charge twice for a span that appears twice.
    const inner = sql.indexOf("GROUP BY event_key");
    const outer = sql.indexOf("sum(billed_usd)");
    expect(outer).toBeLessThan(inner);
    expect(sql).toContain("count()          AS event_count");
  });

  it("reads a half-open window on ingested_at, and never on Timestamp", () => {
    expect(sql).toContain("ingested_at >  {from:DateTime64(3)}");
    expect(sql).toContain("ingested_at <= {to:DateTime64(3)}");
    expect(sql).not.toMatch(/\bTimestamp\b/);
    expect(sql).not.toContain("sync_from");
  });

  it("carries no LIMIT, because the window is bounded by time rather than by rows", () => {
    // The LIMIT is what forced the cursor to carry an event id: a truncated page
    // had to be resumed from the last row it returned. Aggregating removes both.
    expect(sql).not.toContain("LIMIT");
    expect(sql).not.toContain("cursorKey");
  });

  it("does not bill cache hits", () => {
    expect(sql).toContain("JSONExtractString(attrs['hidden_params'], 'cache_key') = ''");
  });

  it("filters the window only AFTER FINAL has picked a span's first copy", () => {
    // span_nodes keeps a span's FIRST copy (tenant migration 030), so a re-send
    // never reaches a later window — but only if the ingested_at filter sees
    // the copy FINAL chose. Exact mode off, or the filter in PREWHERE, lets
    // FINAL choose among the window's copies alone, and the re-send bills
    // again. Both were measured against ClickHouse 26.3.
    expect(sql).toContain("span_nodes FINAL");
    expect(sql).toContain("SETTINGS use_skip_indexes_if_final = 1, use_skip_indexes_if_final_exact_mode = 1");
    expect(sql).not.toContain("PREWHERE");
    expect(sql).not.toMatch(/apply_prewhere_after_final|optimize_move_to_prewhere_if_final|do_not_merge_across_partitions_select_final/);
  });

  it("refuses a slug that could alter the query", () => {
    expect(() => windowQuery("acme; DROP TABLE x")).toThrow(TypeError);
  });
});

// ── §G: normal one-minute sync ────────────────────────────────────────────

describe("the ordinary one-minute tick", () => {
  it("bills the window and moves the cursor to its end", async () => {
    const { prisma, usage, chargebee, build } = setup();
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE; // until = T0 + 1min

    const result = await build().runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.SYNCED);
    expect(chargebee.appliedCount).toBe(1);
    expect(prisma._log).toHaveLength(1);
    expect(prisma._log[0]).toMatchObject({ status: SYNC.SUCCESS, eventCount: 1, amount: "2" });
    expect(prisma._log[0].fromIngestedAt.getTime()).toBe(T0);
    expect(prisma._log[0].toIngestedAt.getTime()).toBe(T0 + MINUTE);
    // §8: the cursor is the window's END, and it moved only because the window
    // resolved.
    expect(prisma._cursor).toBe(T0 + MINUTE);
  });

  it("sends the capture under the row's own id, which is the operation id", async () => {
    const { prisma, usage, chargebee, build } = setup();
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;

    await build().runTenant(SLUG);

    expect(chargebee.captures[0]!.id).toBe(prisma._log[0]!.id);
    expect([...chargebee.applied.keys()]).toEqual([prisma._log[0]!.id]);
  });

  it("does not pay for a lookup on the first send of an id", async () => {
    // The id has never been on the wire, so there is nothing to find. Every
    // path that CAN have sent it goes through recovery, which always asks.
    const { usage, chargebee, build } = setup();
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;

    await build().runTenant(SLUG);

    expect(chargebee.lookups).toEqual([]);
  });

  it("chains windows with no gap between them", async () => {
    const { prisma, usage, build } = setup();
    const sync = build();

    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;
    await sync.runTenant(SLUG);

    usage.add("t2:s1", T0 + 90_000, 0.003);
    usage.nowMs = T0 + 3 * MINUTE;
    await sync.runTenant(SLUG);

    expect(prisma._log).toHaveLength(2);
    // The second window starts exactly where the first ended: no gap, no overlap.
    expect(prisma._log[1]!.fromIngestedAt.getTime()).toBe(prisma._log[0]!.toIngestedAt.getTime());
    expect(prisma._cursor).toBe(T0 + 2 * MINUTE);
  });

  it("does not read usage ingested inside the lag window", async () => {
    const { prisma, usage, chargebee, build } = setup();
    usage.add("t1:s1", T0 + 90_000, 0.002); // inside the lag at now = T0 + 2min
    usage.nowMs = T0 + 2 * MINUTE;

    const result = await build().runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.IDLE);
    expect(chargebee.appliedCount).toBe(0);
    // The cursor still advances over the part of the range that WAS safe to read.
    expect(prisma._cursor).toBe(T0 + MINUTE);
  });
});

// ── §G: no usage events ───────────────────────────────────────────────────

describe("an empty window", () => {
  it("moves the cursor and writes no row at all", async () => {
    const { prisma, chargebee, usage, build } = setup();
    usage.nowMs = T0 + 2 * MINUTE;

    const result = await build().runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.IDLE);
    expect(prisma._log).toHaveLength(0);
    expect(chargebee.appliedCount).toBe(0);
    // This is the one thing the derived cursor could not do: an idle minute had
    // to write a row to record that it had passed.
    expect(prisma._cursor).toBe(T0 + MINUTE);
  });

  it("re-running with no new usage charges nothing more", async () => {
    const { prisma, usage, chargebee, build } = setup();
    const sync = build();
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;
    await sync.runTenant(SLUG);

    await sync.runTenant(SLUG);
    await sync.runTenant(SLUG);

    expect(chargebee.appliedCount).toBe(1);
    expect(prisma._log).toHaveLength(1);
  });
});

// ── §G: multiple and duplicate events ─────────────────────────────────────

describe("several events in one window", () => {
  it("bills them as one capture for the summed amount", async () => {
    const { prisma, usage, chargebee, build } = setup();
    usage.add("t1:s1", T0 + 10_000, 0.001).add("t1:s2", T0 + 20_000, 0.002).add("t2:s1", T0 + 30_000, 0.003);
    usage.nowMs = T0 + 2 * MINUTE;

    const result = await build().runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.SYNCED);
    expect(prisma._log[0]).toMatchObject({ eventCount: 3, amount: "6" });
    expect(chargebee.appliedCount).toBe(1);
    expect(chargebee.taken).toBe(6);
  });
});

describe("duplicate ClickHouse rows", () => {
  it("bills one event when the same TraceId:SpanId comes back twice", async () => {
    // §13: deduplication is the query's job and uses the event identity, which
    // is a different mechanism from the cursor entirely.
    const { prisma, usage, chargebee, build } = setup();
    usage.add("t1:s1", T0 + 30_000, 0.002).add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;

    await build().runTenant(SLUG);

    expect(prisma._log[0]).toMatchObject({ eventCount: 1, amount: "2" });
    expect(chargebee.taken).toBe(2);
  });

  it("does not bill a span again when the collector re-sends it after its window was billed", async () => {
    // Live case C12. The deduplication is per window, so the copy in the SECOND
    // window is the one that would double-charge. It does not, because
    // span_nodes FINAL keeps the FIRST copy (tenant migration 030): the span
    // stays in the window that already billed it, and the re-send's window
    // never sees it.
    const { prisma, usage, chargebee, build } = setup();
    const sync = build();
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;
    await sync.runTenant(SLUG);
    expect(chargebee.taken).toBe(2);

    usage.add("t1:s1", T0 + MINUTE + 30_000, 0.002); // the re-send, one window later
    usage.add("t1:s2", T0 + MINUTE + 40_000, 0.001); // and a genuinely new call beside it
    usage.nowMs = T0 + 3 * MINUTE;
    await sync.runTenant(SLUG);

    expect(prisma._log.map((r: { eventCount: number }) => r.eventCount)).toEqual([1, 1]);
    expect(chargebee.taken).toBe(3);
  });

  it("bills a span in its first copy's window when the re-send lands before that window is read", async () => {
    const { prisma, usage, chargebee, build } = setup();
    usage.add("t1:s1", T0 + 30_000, 0.002).add("t1:s1", T0 + MINUTE + 30_000, 0.002);
    usage.nowMs = T0 + 3 * MINUTE;

    await build().runTenant(SLUG);

    // Both windows were read (the cursor passed the re-send's), and only the
    // first found anything: an empty window writes no row.
    expect(prisma._cursor).toBe(T0 + 2 * MINUTE);
    expect(prisma._log.map((r: { fromIngestedAt: Date; eventCount: number }) => [r.fromIngestedAt.getTime(), r.eventCount])).toEqual([[T0, 1]]);
    expect(chargebee.taken).toBe(2);
  });
});

describe("events sharing one ingested_at", () => {
  it("bills all of them, because a window boundary is a time and cannot split a millisecond", async () => {
    // This is what the (ingested_at, TraceId:SpanId) cursor pair existed for. A
    // time boundary makes it unnecessary: every millisecond belongs whole to
    // exactly one window.
    const { prisma, usage, chargebee, build } = setup();
    const at = T0 + 30_000;
    usage.add("t1:s1", at, 0.001).add("t1:s2", at, 0.001).add("t1:s3", at, 0.001);
    usage.nowMs = T0 + 2 * MINUTE;

    await build().runTenant(SLUG);

    expect(prisma._log[0]).toMatchObject({ eventCount: 3, amount: "3" });
    expect(chargebee.appliedCount).toBe(1);
  });

  it("does not re-bill the cursor's own millisecond on the next tick", async () => {
    const { prisma, usage, chargebee, build } = setup();
    const sync = build();
    // Events exactly ON the window boundary: `> from` excludes them next time.
    usage.add("t1:s1", T0 + MINUTE, 0.001).add("t1:s2", T0 + MINUTE, 0.001);
    usage.nowMs = T0 + 2 * MINUTE;
    await sync.runTenant(SLUG);
    expect(prisma._log[0]).toMatchObject({ eventCount: 2 });

    usage.nowMs = T0 + 3 * MINUTE;
    await sync.runTenant(SLUG);

    expect(chargebee.taken).toBe(2);
    expect(prisma._log).toHaveLength(1);
  });
});

// ── §G: catch-up, and bounded windows ─────────────────────────────────────

describe("a backlog", () => {
  it("drains over several bounded windows within one tick", async () => {
    const { prisma, usage, chargebee, build } = setup();
    for (let i = 1; i <= 3; i += 1) usage.add(`t${i}:s1`, T0 + i * MINUTE - 1_000, 0.001);
    usage.nowMs = T0 + 5 * MINUTE;

    const result = await build({ windowMs: MINUTE }).runTenant(SLUG);

    expect(result.windows).toBe(3);
    expect(chargebee.appliedCount).toBe(3);
    expect(prisma._cursor).toBe(T0 + 4 * MINUTE);
  });

  it("stops at maxWindowsPerTick and resumes there next tick, losing nothing", async () => {
    const { prisma, usage, chargebee, build } = setup();
    for (let i = 1; i <= 4; i += 1) usage.add(`t${i}:s1`, T0 + i * MINUTE - 1_000, 0.001);
    usage.nowMs = T0 + 6 * MINUTE;
    const sync = build({ windowMs: MINUTE, maxWindowsPerTick: 2 });

    await sync.runTenant(SLUG);
    expect(prisma._cursor).toBe(T0 + 2 * MINUTE);

    await sync.runTenant(SLUG);

    expect(prisma._cursor).toBe(T0 + 4 * MINUTE);
    expect(chargebee.appliedCount).toBe(4);
    expect(chargebee.taken).toBe(4);
  });

  it("reads fixed-size windows, so a long outage is never one enormous scan", async () => {
    const { usage, build } = setup();
    usage.nowMs = T0 + 10 * MINUTE;

    await build({ windowMs: 2 * MINUTE, maxWindowsPerTick: 2 }).runTenant(SLUG);

    expect(usage.reads).toEqual([
      { fromMs: T0, toMs: T0 + 2 * MINUTE },
      { fromMs: T0 + 2 * MINUTE, toMs: T0 + 4 * MINUTE },
    ]);
  });

  it("derives a window's end from its start, never from how much happens to be available", async () => {
    // THE anti-race property. Two workers reading the same cursor a few
    // milliseconds apart must compute the SAME window, or the uniqueness index
    // — which is on (tenant_id, from_ingested_at) — cannot tell that they are
    // competing, and one could charge a range the other has already advanced
    // the cursor over.
    const { usage, build } = setup();
    const a = build({ windowMs: MINUTE });
    const b = build({ windowMs: MINUTE });

    usage.nowMs = T0 + 5 * MINUTE;
    await a.runTenant(SLUG);
    const firstOfA = usage.reads[0]!;

    // A second worker, a different `until`, the same cursor.
    const { usage: usage2, build: build2 } = setup();
    usage2.nowMs = T0 + 5 * MINUTE + 137; // a few ms later
    await build2({ windowMs: MINUTE }).runTenant(SLUG);

    expect(usage2.reads[0]).toEqual(firstOfA);
    void b;
  });

  it("leaves a window that does not yet fit inside the safe range alone", async () => {
    // A partial window would have to be re-read later to be complete, and the
    // aggregate is taken once. So it waits.
    const { prisma, usage, build } = setup();
    usage.nowMs = T0 + MINUTE + 30_000; // until = T0 + 30s, half a window

    const result = await build({ windowMs: MINUTE }).runTenant(SLUG);

    expect(usage.reads).toEqual([]);
    expect(result.outcome).toBe(OUTCOME.IDLE);
    expect(prisma._cursor).toBe(T0);
  });
});

// ── §G: recovery of an existing sync ──────────────────────────────────────

describe("recovering an unresolved sync", () => {
  it("retries the SAME row rather than opening a second one for the window", async () => {
    const { prisma, usage, chargebee, build } = setup();
    const sync = build();
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;

    chargebee.fail({ kind: CAPTURE_TERMINAL, error: Object.assign(new Error("bad unit"), { status: 400 }) });
    const first = await sync.runTenant(SLUG);
    expect(first.outcome).toBe(OUTCOME.INVALID);
    const rowId = prisma._log[0]!.id;
    expect(prisma._cursor).toBe(T0); // §8: unresolved, so the cursor stays put

    // Past the INVALID backoff, with whatever was wrong now fixed.
    usage.nowMs = T0 + 90 * MINUTE;
    const second = await sync.runTenant(SLUG);

    expect(second.outcome).toBe(OUTCOME.SYNCED);
    expect(prisma._log.filter((s: { fromIngestedAt: Date }) => s.fromIngestedAt.getTime() === T0)).toHaveLength(1);
    expect(prisma._log[0]!.id).toBe(rowId);
    expect(prisma._log[0]!.attemptCount).toBe(2);
    expect(chargebee.appliedCount).toBe(1);
  });

  it("reads nothing new while a sync is unresolved", async () => {
    const { prisma, usage, chargebee, build } = setup();
    const sync = build();
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;
    chargebee.insufficient = true;
    await sync.runTenant(SLUG);

    // More usage arrives, and more time passes. None of it may be read: an
    // unresolved window sits in front of the cursor.
    usage.add("t2:s1", T0 + 90_000, 0.002);
    usage.nowMs = T0 + 4 * MINUTE;
    const readsBefore = usage.reads.length;
    const result = await sync.runTenant(SLUG);

    expect(result).toMatchObject({ outcome: OUTCOME.EXHAUSTED, syncId: prisma._stuck!.id });
    expect(usage.reads.length).toBe(readsBefore); // nothing new was even read
    expect(prisma._log).toHaveLength(1);
    expect(prisma._cursor).toBe(T0);
  });

  it("always asks Chargebee before re-sending a row that may have been on the wire", async () => {
    const { usage, chargebee, build } = setup();
    const sync = build();
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;
    chargebee.loseResponseNext = true;
    await sync.runTenant(SLUG);
    expect(chargebee.lookups).toEqual([]); // first send: nothing to look up

    usage.nowMs = T0 + 3 * MINUTE;
    await sync.runTenant(SLUG);

    // §25 rule 8: an UNKNOWN is resolved by lookup, never by a blind re-send.
    expect(chargebee.lookups).toHaveLength(1);
    expect(chargebee.appliedCount).toBe(1);
  });
});

// ── §G: cursor advancement, and not advancing ─────────────────────────────

describe("the cursor", () => {
  it("moves only after the window is resolved", async () => {
    const { prisma, usage, chargebee, build } = setup();
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;
    chargebee.fail({ kind: CAPTURE_RATE_LIMITED, error: Object.assign(new Error("429"), { status: 429 }) });

    const result = await build().runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.RATE_LIMITED);
    expect(prisma._stuck?.status).toBe(SYNC.RATE_LIMITING);
    expect(prisma._cursor).toBe(T0);
  });

  it("is a plain timestamp with no event id in it", async () => {
    // §4 and §25 rule 1: time-based, full stop. Identity lives in the query.
    const { prisma, usage, build } = setup();
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;
    await build().runTenant(SLUG);

    const account = prisma._accounts.get(TENANT)!;
    expect(account.lastProcessedIngestedAt).toBeInstanceOf(Date);
    expect(Object.keys(account)).not.toContain("lastProcessedEventKey");
    expect(JSON.stringify(prisma._log[0])).not.toContain("cursorKey");
  });

  it("cannot be rewound by a worker holding a stale position", async () => {
    // Compare-and-set: the update names the value the window opened at, so a
    // late worker matches nothing and changes nothing.
    const { prisma, usage, chargebee, build } = setup();
    const sync = build();
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;
    await sync.runTenant(SLUG);
    expect(prisma._cursor).toBe(T0 + MINUTE);

    // Someone else has already moved billing well past this point.
    prisma._accounts.get(TENANT)!.lastProcessedIngestedAt = new Date(T0 + 10 * MINUTE);
    const row = prisma._log[0]!;
    await prisma.chargebeeSync.update({ where: { id: row.id }, data: { status: SYNC.UNKNOWN, settledAt: null } });
    usage.nowMs = T0 + 12 * MINUTE;
    await sync.runTenant(SLUG);

    expect(prisma._cursor).toBeGreaterThanOrEqual(T0 + 10 * MINUTE);
    expect(chargebee.appliedCount).toBe(1);
  });
});

// ── §G: duplicate cron execution, two workers ─────────────────────────────

describe("two workers on one tenant", () => {
  it("the second is refused by the window index, not by a lease", async () => {
    const { prisma, usage, chargebee, build } = setup();
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;

    // Both read the same cursor, then both try to open the window at it.
    const a = build();
    const b = build();
    const [ra, rb] = await Promise.all([a.runTenant(SLUG), b.runTenant(SLUG)]);

    const outcomes = [ra.outcome, rb.outcome].sort();
    expect(outcomes).toContain(OUTCOME.LOCKED);
    expect(prisma._log.filter((s: { fromIngestedAt: Date }) => s.fromIngestedAt.getTime() === T0)).toHaveLength(1);
    expect(chargebee.appliedCount).toBe(1);
  });

  it("a duplicate cron run charges nothing more", async () => {
    const { prisma, usage, chargebee, build } = setup();
    const sync = build();
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;

    await sync.runTenant(SLUG);
    await sync.runTenant(SLUG); // the same minute, fired twice

    expect(chargebee.appliedCount).toBe(1);
    expect(chargebee.taken).toBe(2);
    expect(prisma._log).toHaveLength(1);
  });
});

// ── zero-cost usage ───────────────────────────────────────────────────────

describe("zero-cost usage", () => {
  it("is recorded as resolved without calling Chargebee, which rejects a zero amount", async () => {
    const { prisma, usage, chargebee, build } = setup();
    usage.add("t1:s1", T0 + 30_000, 0);
    usage.nowMs = T0 + 2 * MINUTE;

    const result = await build().runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.IDLE);
    expect(chargebee.captures).toHaveLength(0);
    expect(prisma._log[0]).toMatchObject({ status: SYNC.SUCCESS, eventCount: 1, amount: "0" });
    expect(prisma._cursor).toBe(T0 + MINUTE);
  });
});

// ── tenants that are not billable ─────────────────────────────────────────

describe("tenants that are not billable", () => {
  it("does not bill a cancelled subscription", async () => {
    const { prisma, usage, chargebee, build } = setup({ account: { status: "cancelled" } });
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;

    const result = await build().runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.NOT_BILLABLE);
    expect(chargebee.appliedCount).toBe(0);
    expect(prisma._cursor).toBe(T0);
  });

  it("still resolves a sync that was in flight when it cancelled", async () => {
    const { prisma, usage, chargebee, build } = setup();
    const sync = build();
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;
    chargebee.loseResponseNext = true;
    await sync.runTenant(SLUG);
    expect(prisma._stuck?.status).toBe(SYNC.UNKNOWN);

    prisma._accounts.get(TENANT)!.status = "cancelled";
    usage.nowMs = T0 + 3 * MINUTE;
    const result = await sync.runTenant(SLUG);

    // The charge had landed; it must be recorded even though the account is gone.
    expect(result.outcome).toBe(OUTCOME.REPLAYED);
    expect(prisma._log[0]!.status).toBe(SYNC.SUCCESS);
    expect(chargebee.appliedCount).toBe(1);
  });

  it("does not bill a tenant with no subscription", async () => {
    const { usage, chargebee, build } = setup({ account: { chargebeeSubscriptionId: null } });
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;

    const result = await build().runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.NOT_BILLABLE);
    expect(chargebee.appliedCount).toBe(0);
  });
});

describe("a tenant with no cursor", () => {
  it("starts at now rather than at ClickHouse's retention horizon", async () => {
    const { prisma, usage, chargebee, build } = setup({ cursorAt: null });
    usage.add("old:s1", T0 - 30 * 24 * 60 * MINUTE, 500); // a month of history
    usage.nowMs = T0 + 2 * MINUTE;

    await build().runTenant(SLUG);

    expect(chargebee.appliedCount).toBe(0);
    expect(prisma._cursor).toBeGreaterThanOrEqual(T0 + MINUTE);
  });
});

// ── the sweep ─────────────────────────────────────────────────────────────

describe("runOnce", () => {
  it("counts each tenant's outcome so a stopped pipeline is visible in one line", async () => {
    const { usage, build } = setup();
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;

    const summary = await build().runOnce();

    expect(summary).toMatchObject({ tenantsScanned: 1, synced: 1, idle: 0, unknown: 0, outOfCredits: 0 });
  });
});

describe("the real Chargebee client", () => {
  it("classifies a 429 as rate limiting rather than as an unknown outcome", async () => {
    let calls = 0;
    const chargebee = createChargebee({
      site: "test",
      apiKey: "key",
      maxAttempts: 2,
      sleep: async () => {},
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ api_error_code: "api_request_limit_exceeded", message: "Too many requests" }), {
          status: 429,
        });
      }) as typeof fetch,
    });

    const result = await chargebee.capture({ id: "op_1", subscriptionId: "sub_1", unitId: "token", amount: "1" });

    // It re-sends in place first — a 429 is refused before it is applied — and
    // only then reports it, as its own state rather than as "we cannot tell".
    expect(calls).toBe(2);
    expect(result.kind).toBe(CAPTURE_RATE_LIMITED);
  });
});

// ── §G: late-arriving ClickHouse events ───────────────────────────────────

describe("late-arriving events", () => {
  it("bills a span that lands long after the call it describes", async () => {
    // §21. The cursor is on INGESTION time, so a span the collector held for an
    // hour lands in front of the cursor and is read like any other. A cursor on
    // the span's own Timestamp would already have passed it — which is what
    // `sync_from` used to do, and why it is gone.
    const { prisma, usage, chargebee, build } = setup();
    const sync = build();
    usage.nowMs = T0 + 2 * MINUTE;
    await sync.runTenant(SLUG);
    expect(prisma._cursor).toBe(T0 + MINUTE);

    // The call happened inside the window just billed; the span only reaches
    // ClickHouse now.
    usage.add("late:s1", T0 + 90_000, 0.002);
    usage.nowMs = T0 + 3 * MINUTE;
    const result = await sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.SYNCED);
    expect(chargebee.taken).toBe(2);
  });

  it("does not read a range that is still expecting events, and bills it on a later tick", async () => {
    // §11, and the reason the lag exists at all: the aggregate over a window is
    // taken ONCE, so a window read before its events have landed is a window
    // that undercounts for ever.
    const { prisma, usage, chargebee, build } = setup();
    const sync = build({ lagMs: 2 * MINUTE });

    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE; // until = T0, nothing safe to read yet
    expect((await sync.runTenant(SLUG)).outcome).toBe(OUTCOME.IDLE);
    expect(usage.reads).toHaveLength(0);
    expect(prisma._cursor).toBe(T0);

    usage.nowMs = T0 + 3 * MINUTE; // until = T0 + 1min — now it is settled
    expect((await sync.runTenant(SLUG)).outcome).toBe(OUTCOME.SYNCED);
    expect(chargebee.taken).toBe(2);
  });
});

// ── §F: recovery, per status ──────────────────────────────────────────────

describe("recovery behaviour by status", () => {
  /** Put the tenant into one unresolved state, with one window owed. */
  async function stuckAt(kind: unknown, status: string) {
    const rig = setup();
    const sync = rig.build();
    rig.usage.add("t1:s1", T0 + 30_000, 0.002);
    rig.usage.nowMs = T0 + 2 * MINUTE;
    rig.chargebee.fail({ kind, error: Object.assign(new Error("refused"), { status: 400 }) } as never);
    await sync.runTenant(SLUG);
    expect(rig.prisma._stuck?.status).toBe(status);
    return { ...rig, sync };
  }

  it("OUT_OF_CREDITS asks Chargebee nothing while the account is exhausted, and a top-up clears it with no requeue step", async () => {
    const { prisma, usage, chargebee, blocked, sync } = await stuckAt(CAPTURE_INSUFFICIENT, SYNC.OUT_OF_CREDITS);
    expect(prisma._accounts.get(TENANT)!.status).toBe("exhausted");

    // The very next minute, still out of credits: held, and Chargebee is not
    // asked — it could only refuse again. The team's block is re-asserted.
    chargebee.insufficient = true;
    const calls = chargebee.captures.length + chargebee.lookups.length;
    const blocks = blocked.length;
    usage.nowMs = T0 + 3 * MINUTE;
    expect(await sync.runTenant(SLUG)).toMatchObject({ outcome: OUTCOME.EXHAUSTED });
    expect(chargebee.captures.length + chargebee.lookups.length).toBe(calls);
    expect(blocked.length).toBe(blocks + 1);

    // The customer tops up, and activate() takes the account out of
    // `exhausted`. Nothing is requeued, because nothing was dequeued: the row
    // is due at once.
    chargebee.insufficient = false;
    chargebee.balance = 1000;
    prisma._accounts.get(TENANT)!.status = "active";
    usage.nowMs = T0 + 4 * MINUTE;
    expect((await sync.runTenant(SLUG)).outcome).toBe(OUTCOME.SYNCED);
    // The held window billed exactly once, and the tick then carried on past
    // it — the backlog that built up while it was stuck drains in the same run.
    expect(chargebee.appliedCount).toBe(1);
    expect(prisma._log[0]!.status).toBe(SYNC.SUCCESS);
    expect(prisma._cursor).toBeGreaterThanOrEqual(T0 + MINUTE);
  });

  it("OUT_OF_CREDITS on an exhausted account is never retried on a timer: a day on, Chargebee has not been asked once", async () => {
    const { prisma, usage, chargebee, sync } = await stuckAt(CAPTURE_INSUFFICIENT, SYNC.OUT_OF_CREDITS);
    const calls = chargebee.captures.length + chargebee.lookups.length;
    const reads = usage.reads.length;

    // Even credits granted by hand in Chargebee do not release it: nothing
    // told billing, so the account is still `exhausted`. Only activate() —
    // a top-up, a renewal, the daily resync — takes it out of that.
    chargebee.balance = 1000;
    for (let m = 3; m <= 24 * 60; m += 10) {
      usage.nowMs = T0 + m * MINUTE;
      expect((await sync.runTenant(SLUG)).outcome).toBe(OUTCOME.EXHAUSTED);
    }
    expect(chargebee.captures.length + chargebee.lookups.length).toBe(calls);
    expect(usage.reads.length).toBe(reads);
    expect(prisma._stuck).toMatchObject({ status: SYNC.OUT_OF_CREDITS, attemptCount: 1 });
    expect(prisma._cursor).toBe(T0);
    expect(prisma._accounts.get(TENANT)!.status).toBe("exhausted");
  });

  it("RATE_LIMITING waits out a backoff instead of hammering Chargebee", async () => {
    const { prisma, usage, chargebee, sync } = await stuckAt(CAPTURE_RATE_LIMITED, SYNC.RATE_LIMITING);
    const sent = chargebee.captures.length;

    // The next tick, seconds later: held, and nothing is sent.
    usage.nowMs = T0 + 2 * MINUTE + 1_000;
    expect((await sync.runTenant(SLUG)).outcome).toBe(OUTCOME.HOLDING);
    expect(chargebee.captures.length).toBe(sent);
    expect(prisma._cursor).toBe(T0);

    // Past the first minute of backoff, it goes again.
    usage.nowMs = T0 + 5 * MINUTE;
    expect((await sync.runTenant(SLUG)).outcome).toBe(OUTCOME.SYNCED);
    expect(chargebee.appliedCount).toBe(1);
  });

  it("INVALID waits much longer, and heals itself once the cause is fixed", async () => {
    // §7: it needs a person, so it is not retried every minute — but it is not
    // abandoned either, because a corrected configuration must start billing
    // again without anyone editing the database.
    const { prisma, usage, chargebee, sync } = await stuckAt(CAPTURE_TERMINAL, SYNC.INVALID);
    const sent = chargebee.captures.length;

    usage.nowMs = T0 + 4 * MINUTE; // inside the 5-minute floor
    expect((await sync.runTenant(SLUG)).outcome).toBe(OUTCOME.HOLDING);
    expect(chargebee.captures.length).toBe(sent);

    usage.nowMs = T0 + 60 * MINUTE;
    expect((await sync.runTenant(SLUG)).outcome).toBe(OUTCOME.SYNCED);
    expect(prisma._log[0]!.status).toBe(SYNC.SUCCESS);
    expect(prisma._cursor).toBeGreaterThanOrEqual(T0 + MINUTE);
  });

  it("a subscription with no prepaid ledger holds the usage instead of skipping past it", async () => {
    // Deliberate change: this used to be `skipped`, which moved billing over
    // revenue that would never be collected. Holding means the usage is still
    // there to bill once someone configures the ledger.
    const { prisma, usage, chargebee, sync } = await stuckAt(CAPTURE_NO_LEDGER, SYNC.INVALID);
    expect(prisma._cursor).toBe(T0);

    usage.nowMs = T0 + 60 * MINUTE;
    await sync.runTenant(SLUG);

    expect(chargebee.taken).toBe(2);
    expect(prisma._cursor).toBeGreaterThanOrEqual(T0 + MINUTE);
  });

  it("an UNKNOWN is retried every tick, because one lookup is all it costs", async () => {
    const { prisma, usage, chargebee, sync } = await stuckAt(CAPTURE_RETRYABLE, SYNC.UNKNOWN);

    usage.nowMs = T0 + 2 * MINUTE + 1_000;
    await sync.runTenant(SLUG);

    expect(chargebee.lookups).toHaveLength(1); // asked immediately, not backed off
    expect(prisma._cursor).toBeGreaterThanOrEqual(T0 + MINUTE);
  });

  it("never turns an unresolved sync into a failure by counting attempts", async () => {
    const { prisma, usage, chargebee, sync } = await stuckAt(CAPTURE_RETRYABLE, SYNC.UNKNOWN);

    for (let i = 1; i <= 5; i += 1) {
      chargebee.lookupThrowsNext = Object.assign(new Error("still down"), { retryable: true });
      usage.nowMs = T0 + (2 + i) * MINUTE;
      expect((await sync.runTenant(SLUG)).outcome).toBe(OUTCOME.UNKNOWN);
    }

    // Only Chargebee can resolve an unknown, so the row waits for it — with the
    // same id, and with the cursor waiting alongside.
    expect(prisma._stuck!.status).toBe(SYNC.UNKNOWN);
    expect(prisma._stuck!.attemptCount).toBe(6);
    expect(prisma._cursor).toBe(T0);
    expect(chargebee.appliedCount).toBe(0);
  });
});

// ── the cursor and the log disagreeing ────────────────────────────────────

describe("when the cursor falls behind a window that was already billed", () => {
  it("moves it past the settled row instead of colliding for ever", async () => {
    // Splitting progress from outcome buys a cursor an idle minute can move,
    // and costs two places that can disagree. This is the reconciliation: the
    // window index refuses the insert, the existing row says SUCCESS, so the
    // cursor is put where that row already reached.
    const { prisma, usage, chargebee, build } = setup();
    const sync = build({ windowMs: MINUTE });
    usage.add("t1:s1", T0 + 30_000, 0.002);
    usage.nowMs = T0 + 2 * MINUTE;
    await sync.runTenant(SLUG);
    expect(prisma._cursor).toBe(T0 + MINUTE);

    // Simulate the divergence: the row stays SUCCESS, the cursor is rewound.
    prisma._accounts.get(TENANT)!.lastProcessedIngestedAt = new Date(T0);

    const result = await sync.runTenant(SLUG);

    expect(result.outcome).not.toBe(OUTCOME.LOCKED);
    expect(prisma._cursor).toBeGreaterThanOrEqual(T0 + MINUTE);
    // And critically: not charged a second time for it.
    expect(chargebee.appliedCount).toBe(1);
    expect(prisma._log).toHaveLength(1);
  });
});
