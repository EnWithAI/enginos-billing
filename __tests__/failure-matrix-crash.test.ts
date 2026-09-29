/**
 * FAILURE MATRIX — crash and concurrency (C02–C07, C22–C27, C31–C33, C55, C56).
 *
 * Every test kills or stalls ONE step of a tick at an exact point, then runs
 * the NEXT tick as a fresh process (a new createUsageSyncService) over the same
 * persisted fakes, and asks the same questions each time:
 *
 *   chargebee.applied      each operation id moved money at most once, and the
 *                          total equals the usage (credits = USD / 0.001)
 *   captures / posts(id)   how many capture POSTs an id received — the fake
 *                          quietly dedupes a reused id, so "money moved once"
 *                          alone cannot tell a second send happened
 *   prisma._log / cursor   every window resolved, none overlapping, and the
 *                          cursor never ahead of settled usage — audit()
 *
 * ALREADY COVERED ELSEWHERE (this file restates each case so the matrix is
 * self-contained):
 *   C02  failures › "a crash while reading leaves nothing to reconcile" (asserts no next tick)
 *   C03  none directly (compound-flows' multi-window crash dies AFTER a capture)
 *   C04  failures › "a crash after the capture is recovered on the next tick, charging once"
 *   C05  compound-flows › "BILLING_WINDOW_MS changed…" rewinds the cursor by hand after SUCCESS
 *   C06  usage-sync › "two workers on one tenant" (simultaneous start only); compound-flows ›
 *        "the cron and the manual sync route running together" (simultaneous start only)
 *   C07  compound-flows › "a crash part-way through draining a backlog" (one crash, one restart)
 *   C24  usage-sync › "when the cursor falls behind a window that was already billed" (by hand)
 *   C25  usage-sync › "the cursor › moves only after the window is resolved" (429 only)
 *   C26  usage-sync › "recovering an unresolved sync" (INVALID/OUT_OF_CREDITS rows, never PENDING)
 *   C27  usage-sync › "a duplicate cron run charges nothing more" (sequential only)
 *   C32  failures › "surfaces a network error as retryable…", captureIdempotent against Chargebee
 *        (real client, one call at a time — never across ticks)
 *   C33  compound-flows › "a crash part-way through draining a backlog" (same instance reused)
 *   C56  usage-sync › "always asks Chargebee before re-sending a row that may have been on the wire";
 *        compound-flows › "crosses RATE_LIMITING → UNKNOWN → SUCCESS"
 *   C22, C23, C31, C55 — no existing test. None of the suites stagger two workers, so the
 *        recovery-steal (C06/C27/C31/C55) and the window-size overlap (C55) were untested.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CAPTURE_INSUFFICIENT,
  CAPTURE_NO_LEDGER,
  CAPTURE_RETRYABLE,
  CAPTURE_TERMINAL,
} from "@/integrations/chargebee";
import type { UsageSource } from "@/integrations/clickhouse/usage-source";
import { PROCESSING_LEASE_MS, SYNC } from "@/models/sync-status";
import { OUTCOME } from "@/services/usage-sync.service";

import {
  ChargebeeHttpSim,
  Gate,
  audit,
  faultyPrisma,
  isCursorCas,
  jittered,
  killable,
  maxPostsPerId,
  patchLookup,
  prng,
  rig,
  slowChargebee,
  stallAfterRead,
  toStatus,
  watchCursor,
  type Rig,
  type SyncRow,
} from "./failure-matrix-crash-and-concurrency.helpers";
import { MINUTE, SLUG, T0, TENANT } from "./harness";

/** One costed call, 2 credits, in the first window (T0, T0+1min]. */
function oneEvent(r: Rig) {
  r.usage.add("t1:s1", T0 + 30_000, 0.002);
}

/** `n` one-credit calls, one in the middle of each of the first `n` windows. */
function backlog(r: Rig, n: number) {
  for (let m = 0; m < n; m += 1) r.usage.add(`t${m}:s1`, T0 + m * MINUTE + 30_000, 0.001);
}

const row0 = (r: Rig): SyncRow => r.prisma._log[0]!;

/**
 * Minutes a PROCESSING row belongs to the worker that claimed it
 * (models/sync-status.ts). A test that kills a worker mid-send starts the next
 * one after this: a live sender and a dead one look the same from the row, so
 * the row is left alone until its sender cannot still be alive — the price a
 * crash pays in production, and the reason a second caller never re-sends a
 * capture that is still on the wire.
 */
const LEASE = PROCESSING_LEASE_MS / MINUTE;
const readsOf = (r: Rig, fromMin: number) => r.usage.reads.filter((a) => a.fromMs === T0 + fromMin * MINUTE).length;

// ── C02 ───────────────────────────────────────────────────────────────────

describe("C02 — worker crashes before the ClickHouse query", () => {
  it("C02 killed at the ClickHouse read: the next cron run reads the SAME window and bills it once", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    r.usage.throwNext = new Error("worker killed before the ClickHouse read returned");
    const first = await r.build({ hatchetRunId: "run-1" }).runOnce();

    expect(first.errors).toHaveLength(1);
    expect(r.usage.reads).toEqual([{ fromMs: T0, toMs: T0 + MINUTE }]);
    expect(r.prisma._log).toHaveLength(0);
    expect(r.prisma._cursor).toBe(T0);
    expect(r.chargebee.captures).toHaveLength(0);

    r.at(3);
    const second = await r.build({ hatchetRunId: "run-2" }).runOnce();

    expect(second.synced).toBe(1);
    expect(r.usage.reads[1]).toEqual({ fromMs: T0, toMs: T0 + MINUTE });
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.chargebee.taken).toBe(2);
    expect(r.cursorMin()).toBe(2);
    expect(audit(r)).toEqual([]);
  });

  it("C02 killed before ANY ClickHouse call (now() never answers): nothing moves, next run bills the window", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    const kp = killable(r, (name) => name === "clickhouse.now", "before");
    await expect(r.build(kp.deps).runTenant(SLUG)).rejects.toThrow("killed before clickhouse.now");
    expect(r.usage.reads).toHaveLength(0);
    expect(r.prisma._log).toHaveLength(0);
    expect(r.prisma._cursor).toBe(T0);

    r.at(3);
    expect((await r.build().runTenant(SLUG)).outcome).toBe(OUTCOME.SYNCED);
    expect(r.usage.reads[0]).toEqual({ fromMs: T0, toMs: T0 + MINUTE });
    expect(audit(r)).toEqual([]);
  });
});

// ── C03 ───────────────────────────────────────────────────────────────────

describe("C03 — worker crashes after the ClickHouse query, before Chargebee", () => {
  it("C03 dies before the sync row commits: nothing persisted, next run re-reads and bills once", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    const { prisma } = faultyPrisma(r.prisma, [{ model: "chargebeeSync", method: "create", mode: "before" }]);
    await expect(r.build({ prisma }).runTenant(SLUG)).rejects.toThrow(/chargebeeSync.create/);
    expect(r.prisma._log).toHaveLength(0);
    expect(r.chargebee.captures).toHaveLength(0);
    expect(r.prisma._cursor).toBe(T0);

    r.at(3);
    expect((await r.build().runTenant(SLUG)).outcome).toBe(OUTCOME.SYNCED);
    expect(readsOf(r, 0)).toBe(2); // read, lost, read again
    expect(r.chargebee.appliedCount).toBe(1);
    expect(audit(r)).toEqual([]);
  });

  it("C03 dies after the PENDING row commits, before PROCESSING: next run sends that row once, same id, no re-read", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    const { prisma } = faultyPrisma(r.prisma, [
      { model: "chargebeeSync", method: "updateMany", when: toStatus(SYNC.PROCESSING), mode: "before" },
    ]);
    await expect(r.build({ prisma }).runTenant(SLUG)).rejects.toThrow();
    const id = row0(r).id;
    expect(row0(r).status).toBe(SYNC.PENDING);
    expect(r.chargebee.captures).toHaveLength(0);

    r.at(3);
    const next = await r.build().runTenant(SLUG);

    expect(next.outcome).toBe(OUTCOME.SYNCED);
    expect(r.prisma._log).toHaveLength(1);
    expect(row0(r).id).toBe(id);
    expect(r.posts(id)).toBe(1);
    expect(r.chargebee.lookups).toEqual([]); // PENDING = never on the wire, sent without a lookup
    expect(readsOf(r, 0)).toBe(1); // the row carried the amount; ClickHouse was not asked again
    expect(audit(r)).toEqual([]);
  });

  it("C03 dies after PROCESSING, before the request leaves: next run looks up (404) and re-sends the SAME id once", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    const killedBeforeSend = {
      capture: async () => {
        throw new Error("worker killed before the capture request left");
      },
      captureIdempotent: async () => {
        throw new Error("worker killed before the capture request left");
      },
    };
    await expect(r.build({ chargebee: killedBeforeSend }).runTenant(SLUG)).rejects.toThrow();
    const id = row0(r).id;
    expect(row0(r).status).toBe(SYNC.PROCESSING);
    expect(r.chargebee.captures).toHaveLength(0);

    r.at(2 + LEASE);
    expect((await r.build().runTenant(SLUG)).outcome).toBe(OUTCOME.SYNCED);
    expect(r.chargebee.lookups).toEqual([id]);
    expect(r.posts(id)).toBe(1);
    expect([...r.chargebee.applied.keys()]).toEqual([id]);
    expect(audit(r)).toEqual([]);
  });
});

// ── C04 ───────────────────────────────────────────────────────────────────

describe("C04 — worker crashes after Chargebee succeeds", () => {
  it("C04 killed right after Chargebee applied the capture: next run finds the operation by id, settles, no second capture", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    r.chargebee.crashNext = "after";
    await expect(r.build({ hatchetRunId: "run-1" }).runTenant(SLUG)).rejects.toThrow("worker killed after the capture landed");
    const id = row0(r).id;
    expect(r.chargebee.applied.get(id)).toBe("2");
    expect(row0(r).status).toBe(SYNC.PROCESSING);
    expect(r.prisma._cursor).toBe(T0);

    // A minute later the row is still inside its sender's lease: from the row,
    // a dead worker and one still waiting on Chargebee look the same.
    r.at(3);
    expect((await r.build({ hatchetRunId: "run-2" }).runTenant(SLUG)).outcome).toBe(OUTCOME.HOLDING);
    expect(r.chargebee.lookups).toEqual([]);

    r.at(2 + LEASE);
    const summary = await r.build({ hatchetRunId: "run-3" }).runOnce();

    expect(summary.replayed).toBe(1);
    expect(r.chargebee.lookups).toEqual([id]);
    expect(r.posts(id)).toBe(1);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.chargebee.taken).toBe(2);
    expect(row0(r)).toMatchObject({ status: SYNC.SUCCESS, attemptCount: 2 });
    expect(r.cursorMin()).toBe(1 + LEASE);
    expect(audit(r)).toEqual([]);
  });
});

// ── C05 ───────────────────────────────────────────────────────────────────

describe("C05 — worker crashes during PostgreSQL settlement", () => {
  it("C05 the SUCCESS write never commits: the row stays PROCESSING and the next run settles it by lookup", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    const { prisma, control } = faultyPrisma(r.prisma, [
      { model: "chargebeeSync", method: "updateMany", when: toStatus(SYNC.SUCCESS), mode: "before" },
    ]);
    await expect(r.build({ prisma }).runTenant(SLUG)).rejects.toThrow();
    expect(control.faults[0]!.fired).toBe(1);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(row0(r).status).toBe(SYNC.PROCESSING);
    expect(r.prisma._cursor).toBe(T0);

    r.at(2 + LEASE);
    expect((await r.build().runTenant(SLUG)).outcome).toBe(OUTCOME.REPLAYED);
    expect(r.posts(row0(r).id)).toBe(1);
    expect(r.cursorMin()).toBe(1 + LEASE);
    expect(audit(r)).toEqual([]);
  });

  it("C05 SUCCESS commits, the worker dies before the cursor moves: the next run repairs the cursor from the settled row", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    const { prisma } = faultyPrisma(r.prisma, [{ model: "billingAccount", method: "updateMany", when: isCursorCas, mode: "before" }]);
    await expect(r.build({ prisma }).runTenant(SLUG)).rejects.toThrow();
    expect(row0(r).status).toBe(SYNC.SUCCESS);
    expect(r.prisma._cursor).toBe(T0); // ledger says settled, cursor says not yet — inconsistent

    r.at(3);
    await r.build().runTenant(SLUG);

    expect(r.metrics()).toContain("billing.sync.cursor_repaired");
    expect(r.posts(row0(r).id)).toBe(1);
    expect(r.prisma._log).toHaveLength(1);
    expect(r.cursorMin()).toBe(2); // consistent again
    expect(audit(r)).toEqual([]);
  });

  it("C05 the UNKNOWN write fails after a lost response: row is left PROCESSING and is still recovered by lookup", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    r.chargebee.loseResponseNext = true; // it landed; the answer did not
    const { prisma } = faultyPrisma(r.prisma, [
      { model: "chargebeeSync", method: "updateMany", when: toStatus(SYNC.UNKNOWN), mode: "before" },
    ]);
    await expect(r.build({ prisma }).runTenant(SLUG)).rejects.toThrow();
    expect(row0(r).status).toBe(SYNC.PROCESSING);
    expect(r.chargebee.appliedCount).toBe(1);

    r.at(2 + LEASE);
    expect((await r.build().runTenant(SLUG)).outcome).toBe(OUTCOME.REPLAYED);
    expect(r.posts(row0(r).id)).toBe(1);
    expect(audit(r)).toEqual([]);
  });
});

// ── C06 ───────────────────────────────────────────────────────────────────

describe("C06 — two workers run at the same time", () => {
  it("C06 two workers started together on one window: one opens it, the other is LOCKED, one capture", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    const [a, b] = await Promise.all([r.build().runTenant(SLUG), r.build().runTenant(SLUG)]);

    expect([a.outcome, b.outcome].sort()).toEqual([OUTCOME.LOCKED, OUTCOME.SYNCED].sort());
    expect(r.prisma._log).toHaveLength(1);
    expect(r.posts(row0(r).id)).toBe(1);
    expect(audit(r)).toEqual([]);
  });

  it("C06 two workers under 150 random interleavings of a 4-window backlog: money moves once per window, log contiguous", async () => {
    const problems: string[] = [];
    let seedsWithDoublePost = 0;
    let seedsWithRejectedWorker = 0;
    let seedsWithLiveRecovery = 0;
    const rejections = new Map<string, number>();

    for (let seed = 1; seed <= 150; seed += 1) {
      const rand = prng(seed);
      const r = rig();
      backlog(r, 4);
      patchLookup(r, rand);
      r.at(6);

      // Worker 2 starts 0–80 scheduler turns after worker 1: sometimes together,
      // sometimes while worker 1 is mid-window.
      const delay = Math.floor(rand() * 80);
      const settled = await Promise.allSettled([
        r.build(jittered(r, rand)).runTenant(SLUG),
        (async () => {
          for (let i = 0; i < delay; i += 1) await Promise.resolve();
          return r.build(jittered(r, rand)).runTenant(SLUG);
        })(),
      ]);
      if (settled.some((s) => s.status === "rejected")) seedsWithRejectedWorker += 1;
      for (const s of settled) {
        if (s.status === "rejected") {
          const msg = String((s.reason as Error).message);
          rejections.set(msg, (rejections.get(msg) ?? 0) + 1);
        }
      }
      if (r.metrics().includes("billing.sync.recover")) seedsWithLiveRecovery += 1;

      // Drain whatever a LOCKED or failed worker left, as the next cron minute would.
      r.at(7);
      for (let i = 0; i < 3; i += 1) await r.build().runTenant(SLUG);

      const found = audit(r);
      if (found.length || r.cursorMin() !== 6) problems.push(`seed ${seed}: ${found.join("; ")} cursor=${r.cursorMin()}`);
      if (maxPostsPerId(r.chargebee) > 1) seedsWithDoublePost += 1;
    }

    // Evidence for the report; C06 "only one processes the batch" is also asserted separately below.
    console.log(
      `[C06] 150 seeds: money/coverage problems=${problems.length}, ` +
        `seeds where one worker recovered a row the other had opened=${seedsWithLiveRecovery}, ` +
        `seeds where one operation id was POSTed twice=${seedsWithDoublePost}, ` +
        `seeds where a worker threw=${seedsWithRejectedWorker} ${JSON.stringify([...rejections])}`,
    );
    expect(problems).toEqual([]);
    // The claim makes these hold on EVERY interleaving, not just the lucky ones:
    // one POST per operation id, and no late write tripping the settled-when-SUCCESS CHECK.
    expect(seedsWithDoublePost).toBe(0);
    expect(seedsWithRejectedWorker).toBe(0);
  });

  /** Worker 1 is mid-capture (request not yet at Chargebee) when worker 2 starts. */
  async function stealWhileInFlight() {
    const r = rig();
    oneEvent(r);
    r.at(2);
    const gate = new Gate();
    const w1 = r.build({ chargebee: slowChargebee(r.chargebee, gate, { phase: "request" }), hatchetRunId: "w1" });
    const p1 = w1.runTenant(SLUG);
    await gate.reached;
    const id = row0(r).id;
    const w2 = await r.build({ hatchetRunId: "w2" }).runTenant(SLUG);
    gate.open();
    const w1Result = await p1;
    return { r, id, w1Result, w2 };
  }

  it("C06 worker 2 starting while worker 1 is mid-capture: worker 2 leaves the row to its sender, and the log stays consistent", async () => {
    const { r, w1Result, w2 } = await stealWhileInFlight();

    // Worker 1's row is PROCESSING and inside its lease: worker 2 holds rather
    // than recovering a row whose sender is still alive.
    expect(w2).toMatchObject({ outcome: OUTCOME.HOLDING, reason: SYNC.PROCESSING });
    expect(w1Result.outcome).toBe(OUTCOME.SYNCED);
    expect(r.chargebee.lookups).toEqual([]); // nobody had to ask
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.metrics()).not.toContain("billing.sync.cursor_race");
    expect(audit(r)).toEqual([]);
  });

  // FIXED (was DEFECT): a second worker used to re-drive a batch another live worker
  // was still sending — retryDelayMs was 0 for PROCESSING, so a row on the wire RIGHT
  // NOW looked abandoned, and recover() → send() POSTed the same operation id again.
  // A PROCESSING row now belongs to its claimant for PROCESSING_LEASE_MS.
  it("C06 only one worker processes the batch: a batch in flight on worker 1 is not POSTed again by worker 2", async () => {
    const { r, id } = await stealWhileInFlight();
    expect(r.posts(id)).toBe(1);
  });

  // FIXED (was DEFECT): the worse form — a PENDING row belonging to a live worker was
  // sent BLIND by a second one, both POSTing the id with no lookup. Sending now starts
  // with a compare-and-set claim from the state the row was READ in, so exactly one of
  // the two claims the PENDING row; the other is told it is taken and sends nothing.
  it("C06 a PENDING row another live worker is about to send is not sent blind by a second worker", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    // Worker 1 stalls after its INSERT, before its PROCESSING write.
    const beforeProcessing = new Gate();
    const w1Prisma = new Proxy(r.prisma, {
      get(target: any, key: string) {
        if (key !== "chargebeeSync") return target[key];
        return new Proxy(target.chargebeeSync, {
          get(sync: any, method: string) {
            if (method !== "updateMany") return sync[method];
            return async (args: any) => {
              if (args.data?.status === SYNC.PROCESSING) await beforeProcessing.pass();
              return sync.updateMany(args);
            };
          },
        });
      },
    });
    const p1 = r.build({ prisma: w1Prisma as never }).runTenant(SLUG);
    await beforeProcessing.reached;
    const id = row0(r).id;
    expect(row0(r).status).toBe(SYNC.PENDING);

    // Worker 2 recovers the PENDING row; its request is slow to arrive.
    const w2Request = new Gate();
    const p2 = r.build({ chargebee: slowChargebee(r.chargebee, w2Request, { phase: "request" }) }).runTenant(SLUG);
    await w2Request.reached;

    beforeProcessing.open();
    await p1;
    w2Request.open();
    await p2;

    expect(r.chargebee.lookups).toEqual([]); // PENDING = never sent, so the one claimant sends it without asking
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.posts(id)).toBe(1); // worker 1's claim failed: it never sent
    expect(r.metrics()).toContain("billing.sync.raced");
    expect(audit(r)).toEqual([]);
  });
});

// ── C07 ───────────────────────────────────────────────────────────────────

describe("C07 — worker restarts repeatedly", () => {
  it("C07 restarted at a different crash point on seven consecutive runs: completes, each window charged once, none lost", async () => {
    const r = rig();
    backlog(r, 5);
    r.at(7);

    const crashes: Array<[string, () => Record<string, unknown>]> = [
      ["ClickHouse read dies", () => ((r.usage.throwNext = new Error("killed mid-read")), {})],
      ["INSERT dies", () => ({ prisma: faultyPrisma(r.prisma, [{ model: "chargebeeSync", method: "create", mode: "before" }]).prisma })],
      [
        "dies before PROCESSING",
        () => ({
          prisma: faultyPrisma(r.prisma, [
            { model: "chargebeeSync", method: "updateMany", when: toStatus(SYNC.PROCESSING), mode: "before" },
          ]).prisma,
        }),
      ],
      ["dies after Chargebee applied", () => ((r.chargebee.crashNext = "after"), {})],
      [
        "dies writing SUCCESS",
        () => ({
          prisma: faultyPrisma(r.prisma, [{ model: "chargebeeSync", method: "updateMany", when: toStatus(SYNC.SUCCESS), mode: "before" }])
            .prisma,
        }),
      ],
      [
        "dies moving the cursor",
        () => ({
          prisma: faultyPrisma(r.prisma, [{ model: "billingAccount", method: "updateMany", when: isCursorCas, mode: "before" }]).prisma,
        }),
      ],
      ["dies after the next window's capture landed", () => ((r.chargebee.crashAfterCaptures = r.chargebee.appliedCount + 1), {})],
    ];

    // Each restart comes one lease after the last, as it would after a real
    // crash: a PROCESSING row a dead worker left is its sender's until then.
    const trail: string[] = [];
    for (const [i, [label, arm]] of crashes.entries()) {
      r.at(7 + i * LEASE);
      const outcome = await r
        .build({ ...arm(), hatchetRunId: `restart-${i}` })
        .runTenant(SLUG)
        .then((res) => res.outcome, (err: Error) => `threw: ${err.message}`);
      trail.push(`${label} → ${outcome} | rows=${JSON.stringify(r.rows())} cursor=${r.cursorMin()} applied=${r.chargebee.appliedCount}`);
    }
    console.log(`[C07] restart trail:\n  ${trail.join("\n  ")}`);

    const finalAt = 7 + crashes.length * LEASE;
    r.at(finalAt);
    const final = await r.build({ hatchetRunId: "restart-final", maxWindowsPerTick: 100 }).runTenant(SLUG);

    expect(final.outcome).toBe(OUTCOME.SYNCED);
    expect(r.chargebee.appliedCount).toBe(5);
    expect(r.chargebee.taken).toBe(5);
    expect(maxPostsPerId(r.chargebee)).toBe(1);
    expect(r.rows()).toEqual([
      [0, 1, SYNC.SUCCESS],
      [1, 2, SYNC.SUCCESS],
      [2, 3, SYNC.SUCCESS],
      [3, 4, SYNC.SUCCESS],
      [4, 5, SYNC.SUCCESS],
    ]);
    expect(r.cursorMin()).toBe(finalAt - 1);
    expect(audit(r)).toEqual([]);
  });

  it("C07 killed at a random step on 3–6 consecutive runs, 200 seeds: always converges, charged once, nothing lost", async () => {
    const problems: string[] = [];
    let kills = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = prng(seed);
      const r = rig();
      backlog(r, 4);
      r.at(6);

      const restarts = 3 + Math.floor(rand() * 4);
      for (let i = 0; i < restarts; i += 1) {
        const kp = killable(r, 1 + Math.floor(rand() * 20), rand() < 0.5 ? "before" : "after");
        await r
          .build({ ...kp.deps, hatchetRunId: `s${seed}-r${i}` })
          .runOnce()
          .catch(() => undefined);
        if (kp.state.killed) kills += 1;
      }

      // Drained once every lease a killed run may have left has run out.
      r.at(6 + LEASE);
      for (let i = 0; i < 3; i += 1) await r.build().runOnce();

      const found = audit(r);
      if (found.length || r.cursorMin() !== 5 + LEASE || maxPostsPerId(r.chargebee) > 1) {
        problems.push(`seed ${seed}: ${found.join("; ")} cursor=${r.cursorMin()} maxPosts=${maxPostsPerId(r.chargebee)}`);
      }
    }
    console.log(`[C07] 200 seeds, ${kills} kills landed mid-run, problems=${problems.length}`);
    expect(kills).toBeGreaterThan(300);
    expect(problems).toEqual([]);
  });
});

// ── C22 ───────────────────────────────────────────────────────────────────

describe("C22 — PostgreSQL is down before Chargebee", () => {
  it("C22 Postgres down when the tick starts: the run fails before ClickHouse or Chargebee is touched; bills once when back", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    const { prisma, control } = faultyPrisma(r.prisma);
    control.down = true;
    await expect(r.build({ prisma }).runOnce()).rejects.toThrow(/Can't reach database server/);
    expect(r.usage.reads).toHaveLength(0);
    expect(r.chargebee.captures).toHaveLength(0);
    expect(r.chargebee.lookups).toHaveLength(0);

    control.down = false;
    r.at(3);
    expect((await r.build({ prisma }).runOnce()).synced).toBe(1);
    expect(audit(r)).toEqual([]);
  });

  it("C22 Postgres goes away after the ClickHouse read: no sync row can be written, so Chargebee is never called", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    const { prisma, control } = faultyPrisma(r.prisma);
    const usage: UsageSource = {
      now: () => r.usage.now(),
      readWindow: async (slug, a) => {
        const out = await r.usage.readWindow(slug, a);
        control.down = true;
        return out;
      },
    };
    await expect(r.build({ prisma, usage }).runTenant(SLUG)).rejects.toThrow(/Can't reach database server/);
    // The window's first statement: the check that the cursor still sits at its start.
    expect(control.calls.at(-1)).toBe("billingAccount.updateMany");
    expect(control.calls).not.toContain("chargebeeSync.create");
    expect(r.chargebee.captures).toHaveLength(0);
    expect(r.prisma._log).toHaveLength(0);
    expect(r.prisma._cursor).toBe(T0);

    control.down = false;
    r.at(3);
    expect((await r.build().runTenant(SLUG)).outcome).toBe(OUTCOME.SYNCED);
    expect(audit(r)).toEqual([]);
  });

  it("C22 Postgres fails reading the owed row: no lookup and no capture for it until the database answers", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);
    r.chargebee.fail({ kind: CAPTURE_RETRYABLE, error: Object.assign(new Error("timeout"), { retryable: true }) });
    expect((await r.build().runTenant(SLUG)).outcome).toBe(OUTCOME.UNKNOWN);
    const sent = r.chargebee.captures.length;

    const { prisma } = faultyPrisma(r.prisma, [{ model: "chargebeeSync", method: "findFirst", mode: "before", times: 2 }]);
    r.at(3);
    await expect(r.build({ prisma }).runTenant(SLUG)).rejects.toThrow();
    await expect(r.build({ prisma }).runTenant(SLUG)).rejects.toThrow();
    expect(r.chargebee.lookups).toHaveLength(0);
    expect(r.chargebee.captures).toHaveLength(sent);

    expect((await r.build({ prisma }).runTenant(SLUG)).outcome).toBe(OUTCOME.SYNCED);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(audit(r)).toEqual([]);
  });
});

// ── C23 ───────────────────────────────────────────────────────────────────

describe("C23 — PostgreSQL fails after Chargebee", () => {
  it("C23 Postgres drops the moment Chargebee applies the capture: the batch stays PROCESSING; the next run settles it, no second charge", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    const { prisma, control } = faultyPrisma(r.prisma);
    const dropAfterCapture = {
      capture: async (a: Parameters<typeof r.chargebee.capture>[0]) => {
        const out = await r.chargebee.capture(a);
        control.down = true;
        return out;
      },
      captureIdempotent: (a: Parameters<typeof r.chargebee.capture>[0]) => r.chargebee.captureIdempotent(a),
    };
    await expect(r.build({ prisma, chargebee: dropAfterCapture }).runTenant(SLUG)).rejects.toThrow(/Can't reach database/);
    const id = row0(r).id;
    expect(r.chargebee.applied.get(id)).toBe("2");
    expect(row0(r).status).toBe(SYNC.PROCESSING);
    expect(r.prisma._cursor).toBe(T0);

    // Still down on the next minute: nothing is sent or looked up.
    r.at(3);
    await expect(r.build({ prisma }).runOnce()).rejects.toThrow(/Can't reach database/);
    expect(r.chargebee.lookups).toHaveLength(0);
    expect(r.posts(id)).toBe(1);

    control.down = false;
    r.at(2 + LEASE);
    const summary = await r.build({ prisma }).runOnce();
    expect(summary.replayed).toBe(1);
    expect(r.chargebee.lookups).toEqual([id]);
    expect(r.posts(id)).toBe(1);
    expect(r.cursorMin()).toBe(1 + LEASE);
    expect(audit(r)).toEqual([]);
  });

  it("C23 the SUCCESS write commits but its reply is lost: the next run repairs the cursor and does not charge again", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    const { prisma } = faultyPrisma(r.prisma, [{ model: "chargebeeSync", method: "updateMany", when: toStatus(SYNC.SUCCESS), mode: "after" }]);
    await expect(r.build({ prisma }).runTenant(SLUG)).rejects.toThrow();
    expect(row0(r).status).toBe(SYNC.SUCCESS);
    expect(r.prisma._cursor).toBe(T0);

    r.at(3);
    await r.build().runTenant(SLUG);
    expect(r.metrics()).toContain("billing.sync.cursor_repaired");
    expect(r.posts(row0(r).id)).toBe(1);
    expect(r.cursorMin()).toBe(2);
    expect(audit(r)).toEqual([]);
  });
});

// ── C24 ───────────────────────────────────────────────────────────────────

describe("C24 — cursor update fails", () => {
  it("C24 the cursor compare-and-set fails after a successful capture: the same window is retried and settles without a second capture", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    const { prisma } = faultyPrisma(r.prisma, [{ model: "billingAccount", method: "updateMany", when: isCursorCas, mode: "before" }]);
    await expect(r.build({ prisma }).runTenant(SLUG)).rejects.toThrow(/billingAccount.updateMany/);
    const id = row0(r).id;
    expect(row0(r).status).toBe(SYNC.SUCCESS);
    expect(r.prisma._cursor).toBe(T0);

    r.at(3);
    const next = await r.build().runTenant(SLUG);

    expect(readsOf(r, 0)).toBe(2); // the same window was offered again
    expect(next.outcome).toBe(OUTCOME.IDLE);
    expect(r.metrics()).toContain("billing.sync.cursor_repaired");
    expect(r.prisma._log).toHaveLength(1); // the window index refused a second row
    expect(r.posts(id)).toBe(1);
    expect(r.chargebee.lookups).toHaveLength(0);
    expect(r.cursorMin()).toBe(2);
    expect(audit(r)).toEqual([]);
  });

  it("C24 the cursor write keeps failing for three runs: still one capture, and it converges once the write works", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    const { prisma, control } = faultyPrisma(r.prisma, [
      { model: "billingAccount", method: "updateMany", when: isCursorCas, mode: "before", times: 3 },
    ]);
    for (const m of [2, 3, 4]) {
      r.at(m);
      await expect(r.build({ prisma }).runTenant(SLUG)).rejects.toThrow();
    }
    expect(control.faults[0]!.fired).toBe(3);
    expect(r.prisma._cursor).toBe(T0);

    r.at(5);
    await r.build({ prisma }).runTenant(SLUG);
    expect(r.posts(row0(r).id)).toBe(1);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.cursorMin()).toBe(4);
    expect(audit(r)).toEqual([]);
  });

  it("C24 the cursor write commits but the worker dies before hearing so: the next run carries on from the stored cursor", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);

    const { prisma } = faultyPrisma(r.prisma, [{ model: "billingAccount", method: "updateMany", when: isCursorCas, mode: "after" }]);
    await expect(r.build({ prisma }).runTenant(SLUG)).rejects.toThrow();
    expect(r.cursorMin()).toBe(1);

    r.at(3);
    await r.build().runTenant(SLUG);
    expect(readsOf(r, 0)).toBe(1);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.cursorMin()).toBe(2);
    expect(audit(r)).toEqual([]);
  });
});

// ── C25 ───────────────────────────────────────────────────────────────────

describe("C25 — cursor advances too early", () => {
  // Optional third element: what clears the failure. Only out of credits
  // needs one — the tenant is held until a top-up, and activate() taking the
  // account out of `exhausted` is what a top-up does here.
  const failures: Array<[string, (r: Rig) => void, ((r: Rig) => void)?]> = [
    ["timeout before landing", (r) => r.chargebee.fail({ kind: CAPTURE_RETRYABLE, error: Object.assign(new Error("timeout"), { retryable: true }) })],
    ["response lost after landing", (r) => void (r.chargebee.loseResponseNext = true)],
    ["429", (r) => void (r.chargebee.rateLimitNext = true)],
    [
      "out of credits",
      (r) => r.chargebee.fail({ kind: CAPTURE_INSUFFICIENT, error: Object.assign(new Error("no balance"), { status: 400 }) }),
      (r) => void (r.prisma._accounts.get(TENANT)!.status = "active"),
    ],
    ["terminal 400", (r) => r.chargebee.fail({ kind: CAPTURE_TERMINAL, error: Object.assign(new Error("bad"), { status: 400 }) })],
    ["no prepaid ledger", (r) => r.chargebee.fail({ kind: CAPTURE_NO_LEDGER, error: Object.assign(new Error("none"), { status: 404 }) })],
    ["killed before the request left", (r) => void (r.chargebee.crashNext = "before")],
    ["killed after Chargebee applied it", (r) => void (r.chargebee.crashNext = "after")],
  ];

  it("C25 checked at EVERY cursor write under eight capture failures: the cursor never passes usage that is not settled", async () => {
    const seen: string[] = [];
    for (const [label, arm, heal] of failures) {
      const r = rig();
      backlog(r, 2);
      r.at(3); // windows (0,1] and (1,2] are due
      const watch = watchCursor(r);

      arm(r);
      await r
        .build({ prisma: watch.prisma })
        .runTenant(SLUG)
        .catch(() => undefined);
      // The failed capture was the FIRST window's, so nothing may have moved at all.
      expect(r.prisma._cursor, label).toBe(T0);
      expect(row0(r).status, label).not.toBe(SYNC.SUCCESS);

      heal?.(r);
      r.at(12); // past every backoff (INVALID's first is 5 min)
      await r.build({ prisma: watch.prisma }).runTenant(SLUG);

      expect(watch.violations, label).toEqual([]);
      expect(audit(r), label).toEqual([]);
      expect(r.cursorMin(), label).toBe(11);
      seen.push(`${label}: ${row0(r).status} after ${row0(r).attemptCount} attempts, advances ${JSON.stringify(watch.advances.slice(0, 3))}`);
    }
    console.log(`[C25]\n  ${seen.join("\n  ")}`);
  });

  it("C25 the matrix DETECTS an early advance: a cursor moved at PROCESSING is flagged, and the owed row is still recovered", async () => {
    // The mutant the case describes — cursor moved as the request leaves, before
    // Chargebee has answered — injected from outside, because the product never does it.
    const r = rig();
    oneEvent(r);
    r.at(2);
    const earlyAdvance = new Proxy(r.prisma, {
      get(target: any, key: string) {
        if (key !== "chargebeeSync") return target[key];
        return new Proxy(target.chargebeeSync, {
          get(sync: any, method: string) {
            if (method !== "updateMany") return sync[method];
            return async (args: any) => {
              const out = await sync.updateMany(args);
              if (args.data?.status === SYNC.PROCESSING && out.count === 1) {
                target._accounts.get(TENANT).lastProcessedIngestedAt = target._syncs.get(args.where.id).toIngestedAt;
              }
              return out;
            };
          },
        });
      },
    });
    r.chargebee.fail({ kind: CAPTURE_INSUFFICIENT, error: Object.assign(new Error("no balance"), { status: 400 }) });
    expect((await r.build({ prisma: earlyAdvance as never }).runTenant(SLUG)).outcome).toBe(OUTCOME.OUT_OF_CREDITS);

    expect(r.cursorMin()).toBe(1);
    expect(audit(r)).toContain("event t1:s1 @0.5min covered by 0 settled rows");

    // Second line of defence: the unresolved row, not the cursor, is what holds
    // the usage. A top-up takes the account out of `exhausted`, so it is retried.
    r.prisma._accounts.get(TENANT)!.status = "active";
    r.at(7);
    await r.build().runTenant(SLUG);
    expect(r.metrics()).toContain("billing.sync.cursor_race");
    expect(r.chargebee.taken).toBe(2);
    expect(audit(r)).toEqual([]);
  });
});

// ── C26 ───────────────────────────────────────────────────────────────────

describe("C26 — a pending batch exists", () => {
  it("C26 a PENDING batch left by a crash is found by the cron's tenant scan and sent on the next run", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);
    const { prisma } = faultyPrisma(r.prisma, [
      { model: "chargebeeSync", method: "updateMany", when: toStatus(SYNC.PROCESSING), mode: "before" },
    ]);
    await r.build({ prisma }).runOnce();
    expect(row0(r).status).toBe(SYNC.PENDING);

    r.at(3);
    const summary = await r.build().runOnce();
    expect(summary.tenantsScanned).toBe(1);
    expect(summary.synced).toBe(1);
    expect(r.posts(row0(r).id)).toBe(1);
    expect(audit(r)).toEqual([]);
  });

  it("C26 a PENDING batch created by hand is recovered before any new window is read", async () => {
    const r = rig();
    oneEvent(r);
    r.usage.add("t2:s1", T0 + MINUTE + 30_000, 0.001);
    const manual = "0b6f6a1e-0000-4000-8000-00000000c026";
    await r.prisma.chargebeeSync.create({
      data: {
        id: manual,
        tenantId: TENANT,
        chargebeeSubscriptionId: "sub_1",
        ledgerUnitId: "token",
        fromIngestedAt: new Date(T0),
        toIngestedAt: new Date(T0 + MINUTE),
        status: SYNC.PENDING,
        amount: "2",
        billedUsd: "0.002",
        eventCount: 1,
        error: null,
        settledAt: null,
        hatchetRunId: null,
      },
    });

    r.at(3);
    await r.build().runTenant(SLUG);

    expect(r.chargebee.captures[0]!.id).toBe(manual); // first thing sent
    expect(readsOf(r, 0)).toBe(0); // its window was never re-read
    expect(r.posts(manual)).toBe(1);
    expect(r.chargebee.taken).toBe(3);
    expect(r.cursorMin()).toBe(2);
    expect(audit(r)).toEqual([]);
  });

  it("C26 a pending batch on an account that has since cancelled is still visited and resolved", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);
    const { prisma } = faultyPrisma(r.prisma, [
      { model: "chargebeeSync", method: "updateMany", when: toStatus(SYNC.PROCESSING), mode: "before" },
    ]);
    await r.build({ prisma }).runOnce();
    r.prisma._accounts.get(TENANT)!.status = "cancelled";

    r.at(3);
    const summary = await r.build().runOnce();
    expect(summary.tenantsScanned).toBe(1);
    expect(r.prisma._stuck).toBeUndefined();
    expect(r.chargebee.appliedCount).toBe(1);
  });
});

// ── C27 ───────────────────────────────────────────────────────────────────

describe("C27 — the same batch processed twice", () => {
  it("C27 the same tick run twice after success: the second sends nothing, looks nothing up, writes nothing", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);
    const w = r.build();
    await w.runTenant(SLUG);
    const before = { captures: r.chargebee.captures.length, rows: r.prisma._log.length };

    const again = await w.runTenant(SLUG);
    expect(again.outcome).toBe(OUTCOME.IDLE);
    expect(r.chargebee.captures).toHaveLength(before.captures);
    expect(r.chargebee.lookups).toHaveLength(0);
    expect(r.prisma._log).toHaveLength(before.rows);
    expect(audit(r)).toEqual([]);
  });

  it("C27 a settled batch driven through recovery again (status knocked back to UNKNOWN): reconciled by lookup, never re-charged", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);
    await r.build().runTenant(SLUG);
    const id = row0(r).id;
    await r.prisma.chargebeeSync.update({ where: { id }, data: { status: SYNC.UNKNOWN, settledAt: null } });

    r.at(3);
    expect((await r.build().runTenant(SLUG)).outcome).toBe(OUTCOME.REPLAYED);
    expect(r.chargebee.lookups).toEqual([id]);
    expect(r.posts(id)).toBe(1);
    expect(audit(r)).toEqual([]);
  });

  it("C27 a second row for the same window is refused by the window index", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);
    await r.build().runTenant(SLUG);
    const { id: _id, ...copy } = row0(r) as SyncRow & Record<string, unknown>;

    await expect(
      r.prisma.chargebeeSync.create({ data: { ...copy, status: SYNC.PENDING, settledAt: null } }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(r.prisma._log).toHaveLength(1);
  });

  // FIXED (was DEFECT): two runs recovering the SAME unresolved row at once both
  // passed the lookup (404) and both POSTed it — recover() had no claim step and
  // captureIdempotent is check-then-act. Run A now claims the row (UNKNOWN → PROCESSING,
  // compare-and-set on status and attempt count) before its lookup, so run B finds a
  // PROCESSING row inside A's lease and holds.
  it("C27 the same UNKNOWN batch recovered by two runs at once is POSTed to Chargebee once", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);
    r.chargebee.fail({ kind: CAPTURE_RETRYABLE, error: Object.assign(new Error("timeout"), { retryable: true }) });
    await r.build().runTenant(SLUG); // the POST never landed; row UNKNOWN
    const id = row0(r).id;
    const postsBefore = r.posts(id);

    // Hold run A between its lookup (404) and its send, while run B does both.
    const betweenLookupAndSend = new Gate();
    const lookup = r.chargebee.findOperation.bind(r.chargebee);
    let first = true;
    r.chargebee.findOperation = async (opId: string) => {
      const out = await lookup(opId);
      if (first) {
        first = false;
        await betweenLookupAndSend.pass();
      }
      return out;
    };

    r.at(3);
    const a = r.build().runTenant(SLUG);
    await betweenLookupAndSend.reached;
    await r.build().runTenant(SLUG);
    betweenLookupAndSend.open();
    await a;

    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.posts(id) - postsBefore).toBe(1);
    expect(r.prisma._log[0]).toMatchObject({ status: SYNC.SUCCESS, attemptCount: 2 });
  });
});

// ── C31 ───────────────────────────────────────────────────────────────────

describe("C31 — billing worker is slow", () => {
  it("C31 the cron is configured so a slow run cannot overlap the next: maxRuns 1, CANCEL_NEWEST, no in-task retry", () => {
    const src = readFileSync(fileURLToPath(new URL("../worker/hatchet-worker.ts", import.meta.url)), "utf8");
    const syncBlock = src.slice(src.indexOf("const sync = hatchet.workflow("), src.indexOf("workflows.push(sync)"));

    expect(syncBlock).toMatch(/onCrons:\s*\[BILLING_SYNC_CRON\]/);
    expect(syncBlock).toMatch(/maxRuns:\s*1/);
    expect(syncBlock).toMatch(/limitStrategy:\s*ConcurrencyLimitStrategy\.CANCEL_NEWEST/);
    expect(syncBlock).toMatch(/retries:\s*0/);
    expect(syncBlock).toMatch(/executionTimeout:\s*"5m"/);
  });

  /** Tick A hangs on its first capture (request not yet at Chargebee) past the next minute; tick B runs. */
  async function hungTick(phase: "request" | "response") {
    const r = rig();
    backlog(r, 3);
    r.at(2);
    const gate = new Gate();
    const a = r.build({ chargebee: slowChargebee(r.chargebee, gate, { phase }), hatchetRunId: "tick-A" }).runTenant(SLUG);
    await gate.reached;
    const id = row0(r).id;

    r.at(4); // two minutes later
    const b = await r.build({ hatchetRunId: "tick-B" }).runTenant(SLUG);
    gate.open();
    const aResult = await a;
    return { r, id, a: aResult, b };
  }

  it("C31 a tick whose capture hangs past the next minute: the next tick opens no overlapping window; windows stay ordered and billed once", async () => {
    const { r, a, b } = await hungTick("request");

    // Tick B finds tick A's row on the wire and inside its lease: it waits.
    expect(b).toMatchObject({ outcome: OUTCOME.HOLDING, reason: SYNC.PROCESSING });
    expect(a.outcome).toBe(OUTCOME.SYNCED);
    expect(r.rows()).toEqual([[0, 1, SYNC.SUCCESS]]);

    // The next tick bills what tick A's range did not reach.
    await r.build({ hatchetRunId: "tick-C" }).runTenant(SLUG);
    expect(r.rows()).toEqual([
      [0, 1, SYNC.SUCCESS],
      [1, 2, SYNC.SUCCESS],
      [2, 3, SYNC.SUCCESS],
    ]);
    expect(r.chargebee.appliedCount).toBe(3);
    expect(r.chargebee.taken).toBe(3);
    expect(r.cursorMin()).toBe(3);
    expect(audit(r)).toEqual([]);
  });

  it("C31 a tick whose capture RESPONSE is slow (already applied): the next tick neither looks it up nor re-sends it", async () => {
    const { r, id, a, b } = await hungTick("response");
    expect(b.outcome).toBe(OUTCOME.HOLDING);
    expect(a.outcome).toBe(OUTCOME.SYNCED);
    expect(r.chargebee.lookups).toEqual([]);
    expect(r.posts(id)).toBe(1);
    expect(audit(r)).toEqual([]);
  });

  // FIXED (was DEFECT): the tick that ran while the slow one was still sending
  // re-drove the slow tick's in-flight batch (retryDelayMs was 0 for PROCESSING).
  // Hatchet's maxRuns 1 prevents the overlap only while the slow run is counted as
  // running — past executionTimeout "5m" the task fn is not force-killed — and the
  // manual /api/internal/sync route overlaps the cron by design. The PROCESSING
  // lease now covers both.
  it("C31 the next tick does not send the slow tick's in-flight operation a second time", async () => {
    const { r, id } = await hungTick("request");
    expect(r.posts(id)).toBe(1);
  });
});

// ── C32 ───────────────────────────────────────────────────────────────────

describe("C32 — network connection lost (real Chargebee client over a simulated wire)", () => {
  function realRig() {
    const r = rig();
    oneEvent(r);
    const sim = new ChargebeeHttpSim();
    const build = () => r.build({ chargebee: sim.client() });
    return { r, sim, build };
  }

  it("C32 connection drops after Chargebee applied the capture: UNKNOWN, then settled by GET /ledger_operations/{id}, one operation", async () => {
    const { r, sim, build } = realRig();
    r.at(2);
    sim.dropNextPost = "after";

    const first = await build().runTenant(SLUG);
    expect(first.outcome).toBe(OUTCOME.UNKNOWN);
    expect(first.error).toMatch(/socket hang up/);
    const id = row0(r).id;
    expect(row0(r).status).toBe(SYNC.UNKNOWN);
    expect(r.prisma._cursor).toBe(T0);
    expect(sim.ops.size).toBe(1);

    r.at(3);
    expect((await build().runTenant(SLUG)).outcome).toBe(OUTCOME.REPLAYED);
    expect(sim.gets).toEqual([id]);
    expect(sim.postsFor(id)).toBe(1);
    expect(sim.ops.size).toBe(1);
    expect(sim.balance).toBe(998);
    expect(row0(r).status).toBe(SYNC.SUCCESS);
    expect(r.cursorMin()).toBe(2);
  });

  it("C32 connection refused before the capture left: the next run's lookup says 404 and the SAME id is sent once", async () => {
    const { r, sim, build } = realRig();
    r.at(2);
    sim.dropNextPost = "before";

    expect((await build().runTenant(SLUG)).outcome).toBe(OUTCOME.UNKNOWN);
    const id = row0(r).id;
    expect(sim.ops.size).toBe(0);

    r.at(3);
    expect((await build().runTenant(SLUG)).outcome).toBe(OUTCOME.SYNCED);
    expect(sim.gets).toEqual([id]);
    expect([...sim.ops.keys()]).toEqual([id]);
    expect(sim.balance).toBe(998);
    expect(r.cursorMin()).toBe(2);
  });

  it("C32 the network stays down for the lookups too: stays UNKNOWN, nothing sent blind, cursor held; settles once it returns", async () => {
    const { r, sim, build } = realRig();
    r.at(2);
    sim.dropNextPost = "after";
    await build().runTenant(SLUG);
    const id = row0(r).id;

    sim.lookupsDown = true;
    for (const m of [3, 4, 5]) {
      r.at(m);
      expect((await build().runTenant(SLUG)).outcome).toBe(OUTCOME.UNKNOWN);
    }
    expect(sim.postsFor(id)).toBe(1); // only the original send
    expect(sim.gets).toHaveLength(9); // 3 ticks × 3 attempts each
    expect(row0(r)).toMatchObject({ status: SYNC.UNKNOWN, attemptCount: 4 });
    expect(r.prisma._cursor).toBe(T0);

    sim.lookupsDown = false;
    r.at(6);
    expect((await build().runTenant(SLUG)).outcome).toBe(OUTCOME.REPLAYED);
    expect(sim.postsFor(id)).toBe(1);
    expect(sim.balance).toBe(998);
    expect(r.cursorMin()).toBe(5);
  });

  it("C32 the ClickHouse connection drops mid-read: nothing written, next run reads the window again and bills it", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);
    r.usage.throwNext = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    await expect(r.build().runTenant(SLUG)).rejects.toThrow("ECONNRESET");
    expect(r.prisma._log).toHaveLength(0);

    r.at(3);
    expect((await r.build().runTenant(SLUG)).outcome).toBe(OUTCOME.SYNCED);
    expect(readsOf(r, 0)).toBe(2);
    expect(audit(r)).toEqual([]);
  });
});

// ── C33 ───────────────────────────────────────────────────────────────────

describe("C33 — billing server restarts", () => {
  it("C33 restarted mid-backlog: the new process resumes at the owed window, re-reads nothing settled, bills each window once", async () => {
    const r = rig();
    backlog(r, 5);
    r.at(7);

    r.chargebee.crashAfterCaptures = 3; // the whole process dies after its third capture landed
    await expect(r.build({ hatchetRunId: "process-1" }).runTenant(SLUG)).rejects.toThrow();
    expect(r.cursorMin()).toBe(2);
    expect(r.rows()[2]).toEqual([2, 3, SYNC.PROCESSING]);
    const readsBeforeRestart = r.usage.reads.length;
    const owed = r.prisma._log[2]!.id;

    r.chargebee.crashAfterCaptures = null;
    r.at(7 + LEASE); // the dead process's PROCESSING row is recovered once its lease is over
    await r.build({ hatchetRunId: "process-2" }).runTenant(SLUG);

    const readsAfter = r.usage.reads.slice(readsBeforeRestart).map((a) => (a.fromMs - T0) / MINUTE);
    // Continued from the persisted point, nothing re-read: minutes 3 … 5 + LEASE.
    expect(readsAfter).toEqual(Array.from({ length: LEASE + 3 }, (_, i) => 3 + i));
    expect(r.chargebee.lookups).toEqual([owed]);
    expect(r.prisma._log.map((s: SyncRow) => s.hatchetRunId)).toEqual([
      "process-1",
      "process-1",
      "process-1",
      "process-2",
      "process-2",
    ]);
    expect(maxPostsPerId(r.chargebee)).toBe(1);
    expect(r.chargebee.taken).toBe(5);
    expect(r.cursorMin()).toBe(6 + LEASE);
    expect(audit(r)).toEqual([]);
  });

  it("C33 restarted while a capture was in flight (it never reached Chargebee): the new process re-sends the same id once", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);
    const neverReturns = new Gate();
    void r.build({ chargebee: slowChargebee(r.chargebee, neverReturns, { phase: "request" }) }).runTenant(SLUG);
    await neverReturns.reached; // the old process is gone: its request never leaves
    const id = row0(r).id;
    expect(row0(r).status).toBe(SYNC.PROCESSING);

    r.at(2 + LEASE);
    expect((await r.build().runTenant(SLUG)).outcome).toBe(OUTCOME.SYNCED);
    expect(r.chargebee.lookups).toEqual([id]);
    expect(r.posts(id)).toBe(1);
    expect(audit(r)).toEqual([]);
  });
});

// ── C55 ───────────────────────────────────────────────────────────────────

describe("C55 — worker version changes", () => {
  it("C55 old and new worker (same BILLING_WINDOW_MS) overlapping on one batch: money once, log contiguous", async () => {
    const r = rig();
    backlog(r, 2);
    r.at(3);
    const gate = new Gate();
    const old = r.build({ chargebee: slowChargebee(r.chargebee, gate, { phase: "request" }), hatchetRunId: "v1" }).runTenant(SLUG);
    await gate.reached;
    await r.build({ hatchetRunId: "v2" }).runTenant(SLUG);
    gate.open();
    await old;

    expect(r.chargebee.appliedCount).toBe(2);
    expect(r.rows()).toEqual([
      [0, 1, SYNC.SUCCESS],
      [1, 2, SYNC.SUCCESS],
    ]);
    expect(audit(r)).toEqual([]);
  });

  // FIXED (was DEFECT): both versions settled the same batch — v2 re-drove v1's
  // in-flight row, both POSTed it and both wrote SUCCESS. See C06: v2 now leaves the
  // row to its claimant, and a SUCCESS is written only under the claim that sent it.
  it("C55 only one version settles each batch: one capture POST and one SUCCESS write per batch", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);
    const v1 = faultyPrisma(r.prisma);
    const v2 = faultyPrisma(r.prisma);
    const gate = new Gate();
    const old = r.build({ prisma: v1.prisma, chargebee: slowChargebee(r.chargebee, gate, { phase: "request" }) }).runTenant(SLUG);
    await gate.reached;
    const id = row0(r).id;
    await r.build({ prisma: v2.prisma }).runTenant(SLUG);
    gate.open();
    await old;

    const successWrites = [...v1.control.statements, ...v2.control.statements].filter(
      (s) => s.name === "chargebeeSync.updateMany" && s.args.where.id === id && s.args.data.status === SYNC.SUCCESS,
    ).length;
    expect({ posts: r.posts(id), successWrites }).toEqual({ posts: 1, successWrites: 1 });
  });

  /**
   * The deploy changes BILLING_WINDOW_MS. The worker with the LONGER window has
   * read the cursor and its ClickHouse window, then stalls; the one with the
   * shorter window passes an empty minute (no row), then bills the next one.
   */
  async function windowSizeDeploy(slowMs: number, fastMs: number) {
    const r = rig();
    r.usage.add("t1:s1", T0 + 90_000, 0.002); // one call, in (1min, 2min]
    r.at(3);
    const gate = new Gate();
    const slow = r
      .build({ windowMs: slowMs, usage: stallAfterRead(r.usage, gate), hatchetRunId: `window-${slowMs / 1000}s` })
      .runTenant(SLUG);
    await gate.reached;
    await r.build({ windowMs: fastMs, hatchetRunId: `window-${fastMs / 1000}s` }).runTenant(SLUG);
    gate.open();
    await slow;
    return r;
  }

  // FIXED (was DEFECT — a DOUBLE CHARGE): an empty window advanced the cursor with no
  // row, and the window end is cursor + THIS worker's windowMs, so a 120s row (0,2min]
  // and a 60s row (1min,2min] had different `from` and BOTH inserted and captured.
  // A window is now written only while the cursor still sits at its start
  // (openWindow), and an empty window is passed only while no row owns it
  // (advancePastEmptyWindow) — both under the account row's lock. Here the 120s
  // worker finds the cursor already at 2min and writes nothing.
  it("C55 a deploy that changes BILLING_WINDOW_MS 60s→120s while the old worker runs: usage in the overlap is charged once", async () => {
    const r = await windowSizeDeploy(2 * MINUTE, MINUTE);
    console.log(
      `[C55] 120s worker stalled after its read: rows=${JSON.stringify(r.rows())} ` +
        `applied=${JSON.stringify([...r.chargebee.applied.values()])} taken=${r.chargebee.taken} cursor=${r.cursorMin()} ` +
        `metrics=${JSON.stringify(r.metrics().filter((m) => m !== "billing.sync.window_read"))} audit=${JSON.stringify(audit(r))}`,
    );
    expect(r.chargebee.taken).toBe(2);
    expect(r.rows()).toEqual([[1, 2, SYNC.SUCCESS]]);
    expect(r.metrics()).toContain("billing.sync.raced");
    expect(audit(r)).toEqual([]);
  });

  it("C55 the other order: the 120s worker writes its row while the 60s worker is between its read and its move — the 60s worker will not step over the window it owns", async () => {
    const r = rig();
    r.usage.add("t1:s1", T0 + 90_000, 0.002); // one call, in (1min, 2min]
    r.at(3);

    // The 60s worker has found nothing held and read an empty first minute…
    const narrowRead = new Gate();
    const narrow = r
      .build({ windowMs: MINUTE, usage: stallAfterRead(r.usage, narrowRead), hatchetRunId: "window-60s" })
      .runTenant(SLUG);
    await narrowRead.reached;

    // …when the 120s worker opens (0,2min] and puts its capture on the wire.
    const wideSend = new Gate();
    const wide = r
      .build({ windowMs: 2 * MINUTE, chargebee: slowChargebee(r.chargebee, wideSend, { phase: "request" }), hatchetRunId: "window-120s" })
      .runTenant(SLUG);
    await wideSend.reached;
    expect(r.rows()).toEqual([[0, 2, SYNC.PROCESSING]]);

    // The 60s worker's empty minute starts where the 120s row does: it must not move.
    narrowRead.open();
    expect((await narrow).outcome).toBe(OUTCOME.LOCKED);
    expect(r.prisma._cursor).toBe(T0);

    wideSend.open();
    expect((await wide).outcome).toBe(OUTCOME.SYNCED);
    expect(r.rows()).toEqual([[0, 2, SYNC.SUCCESS]]);
    expect(r.cursorMin()).toBe(2);
    expect(r.chargebee.taken).toBe(2);
    expect(audit(r)).toEqual([]);
  });

  it("C55 a 60s worker meeting a SETTLED 120s row at its empty first minute steps over it rather than wedging", async () => {
    const r = rig();
    r.usage.add("t1:s1", T0 + 90_000, 0.002);
    r.at(3);
    // The 120s worker bills (0,2min] and dies before moving the cursor.
    const { prisma } = faultyPrisma(r.prisma, [{ model: "billingAccount", method: "updateMany", when: isCursorCas, mode: "before" }]);
    await expect(r.build({ prisma, windowMs: 2 * MINUTE }).runTenant(SLUG)).rejects.toThrow();
    expect(r.rows()).toEqual([[0, 2, SYNC.SUCCESS]]);
    expect(r.prisma._cursor).toBe(T0);

    await r.build({ windowMs: MINUTE }).runTenant(SLUG);

    expect(r.metrics()).toContain("billing.sync.cursor_repaired");
    expect(r.cursorMin()).toBe(2);
    expect(r.chargebee.taken).toBe(2);
    expect(audit(r)).toEqual([]);
  });

  // FIXED (was DEFECT): the other interleaving — the SHORT-window worker is the slow
  // one. The 120s worker read cursor 0 before the 60s worker's empty-minute move, then
  // billed (0,2min] while the 60s worker, stalled after reading (1min,2min], billed that
  // minute again. Now the 120s worker's window is refused (the cursor is no longer 0).
  it("C55 a deploy that changes BILLING_WINDOW_MS, the 60s worker stalled mid-tick: usage in the overlap is charged once", async () => {
    const r = rig();
    r.usage.add("t1:s1", T0 + 90_000, 0.002); // one call, in (1min, 2min]
    r.at(3);

    const wideHasReadCursor = new Gate();
    const wide = r
      .build({
        windowMs: 2 * MINUTE,
        hatchetRunId: "window-120s",
        usage: {
          now: async () => {
            await wideHasReadCursor.pass(); // after findBySlug: cursor 0 is in hand
            return r.usage.now();
          },
          readWindow: (slug, a) => r.usage.readWindow(slug, a),
        },
      })
      .runTenant(SLUG);
    await wideHasReadCursor.reached;

    const narrowStalled = new Gate();
    const narrow = r
      .build({ windowMs: MINUTE, hatchetRunId: "window-60s", usage: stallAfterRead(r.usage, narrowStalled, 2) })
      .runTenant(SLUG);
    await narrowStalled.reached; // it has moved the cursor over (0,1min] and read (1min,2min]

    wideHasReadCursor.open();
    await wide;
    narrowStalled.open();
    await narrow;

    console.log(`[C55] 60s-stalled interleaving: rows=${JSON.stringify(r.rows())} taken=${r.chargebee.taken} cursor=${r.cursorMin()}`);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.chargebee.taken).toBe(2);
    expect(audit(r)).toEqual([]);
  });

  // The interleaving only the account row's LOCK rules out. The fake used to run
  // a transaction with no lock at all, so nothing here could show the lock was
  // doing anything; FakePrisma now holds each account row a transaction updates
  // until it ends, as Postgres does. Paused INSIDE advancePastEmptyWindow —
  // after it has looked for an owner and found none, before it moves — the 60s
  // worker holds the row, so the 120s worker's openWindow waits at its own
  // compare-and-set and then finds the cursor gone. Without the lock (drop the
  // compare-and-set of the cursor onto itself that opens the transaction) the
  // 120s row is written in that gap, the 60s move lands anyway, and (1min,2min]
  // is charged twice.
  it("C55 the empty-window move paused between its owner lookup and its move: a wider window cannot be opened in the gap", async () => {
    const r = rig();
    r.usage.add("t1:s1", T0 + 90_000, 0.002); // one call, in (1min, 2min]
    r.at(3);

    const narrowLooked = new Gate();
    const narrow = r
      .build({ windowMs: MINUTE, prisma: pauseAfterOwnerLookup(r.prisma, narrowLooked), hatchetRunId: "window-60s" })
      .runTenant(SLUG);
    await narrowLooked.reached;
    expect(r.prisma._rowLocked()).toBe(true);

    const wideSend = new Gate();
    const wide = r
      .build({ windowMs: 2 * MINUTE, chargebee: slowChargebee(r.chargebee, wideSend, { phase: "request" }), hatchetRunId: "window-120s" })
      .runTenant(SLUG);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The 120s worker has read cursor 0 and a billable (0,2min], and is waiting on the row.
    expect(r.rows()).toEqual([]);
    expect(r.chargebee.captures).toEqual([]);

    narrowLooked.open();
    await narrow;
    wideSend.open();
    expect((await wide).outcome).toBe(OUTCOME.LOCKED);

    expect(r.rows()).toEqual([[1, 2, SYNC.SUCCESS]]);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.chargebee.taken).toBe(2);
    expect(r.cursorMin()).toBe(2);
    expect(audit(r)).toEqual([]);
  });
});

// ── C56 ───────────────────────────────────────────────────────────────────

describe("C56 — Chargebee operation lookup after a lost response", () => {
  it("C56 lost response on a capture that landed (fake): the worker retrieves the operation and settles with no second charge", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);
    r.chargebee.loseResponseNext = true;
    expect((await r.build().runTenant(SLUG)).outcome).toBe(OUTCOME.UNKNOWN);
    const id = row0(r).id;
    expect(r.chargebee.applied.has(id)).toBe(true);

    r.at(3);
    expect((await r.build().runTenant(SLUG)).outcome).toBe(OUTCOME.REPLAYED);
    expect(r.chargebee.lookups).toEqual([id]);
    expect(r.posts(id)).toBe(1);
    expect(audit(r)).toEqual([]);
  });

  it("C56 real client: Chargebee applies, the gateway answers 504 → UNKNOWN; the next run's GET finds the capture → SUCCESS, no POST", async () => {
    const r = rig();
    oneEvent(r);
    const sim = new ChargebeeHttpSim();
    r.at(2);
    sim.gatewayTimeoutAfterApply = true;
    expect((await r.build({ chargebee: sim.client() }).runTenant(SLUG)).outcome).toBe(OUTCOME.UNKNOWN);
    const id = row0(r).id;
    expect(sim.postsFor(id)).toBe(1); // a 5xx on a capture is NOT re-sent in place

    r.at(3);
    expect((await r.build({ chargebee: sim.client() }).runTenant(SLUG)).outcome).toBe(OUTCOME.REPLAYED);
    expect(sim.gets).toEqual([id]);
    expect(sim.postsFor(id)).toBe(1);
    expect(sim.ops.size).toBe(1);
    expect(row0(r).status).toBe(SYNC.SUCCESS);
  });

  it("C56 real client: the lost capture never landed → GET 404 → the same id is sent once and settles", async () => {
    const r = rig();
    oneEvent(r);
    const sim = new ChargebeeHttpSim();
    r.at(2);
    sim.dropNextPost = "before";
    await r.build({ chargebee: sim.client() }).runTenant(SLUG);
    const id = row0(r).id;

    r.at(3);
    expect((await r.build({ chargebee: sim.client() }).runTenant(SLUG)).outcome).toBe(OUTCOME.SYNCED);
    expect(sim.gets).toEqual([id]);
    expect([...sim.ops.keys()]).toEqual([id]);
  });

  it("C56 the lookup itself fails (fake): the row stays UNKNOWN and nothing is sent blind", async () => {
    const r = rig();
    oneEvent(r);
    r.at(2);
    r.chargebee.loseResponseNext = true;
    await r.build().runTenant(SLUG);
    const id = row0(r).id;

    r.chargebee.lookupThrowsNext = Object.assign(new Error("lookup timed out"), { retryable: true });
    r.at(3);
    expect((await r.build().runTenant(SLUG)).outcome).toBe(OUTCOME.UNKNOWN);
    expect(r.posts(id)).toBe(1);
    expect(r.prisma._cursor).toBe(T0);

    r.at(4);
    expect((await r.build().runTenant(SLUG)).outcome).toBe(OUTCOME.REPLAYED);
    expect(r.posts(id)).toBe(1);
    expect(audit(r)).toEqual([]);
  });
});

/**
 * A worker whose empty-window move stalls INSIDE its transaction: after the
 * look for a row owning the window, before the move. Only that lookup — the
 * one shaped `{ tenantId, fromIngestedAt }` — is paused, once.
 */
function pauseAfterOwnerLookup(prisma: Rig["prisma"], gate: Gate): Rig["prisma"] {
  let paused = false;
  const syncs = new Proxy(prisma.chargebeeSync, {
    get(target: any, key: string) {
      const original = target[key];
      if (key !== "findFirst") return typeof original === "function" ? original.bind(target) : original;
      return async (args: any) => {
        const out = await original.call(target, args);
        if (!paused && args?.where?.fromIngestedAt instanceof Date && args.where.status == null) {
          paused = true;
          await gate.pass();
        }
        return out;
      };
    },
  });
  return new Proxy(prisma, {
    get(target: any, key: string) {
      return key === "chargebeeSync" ? syncs : target[key];
    },
  }) as Rig["prisma"];
}
