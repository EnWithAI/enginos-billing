/**
 * The idempotency scenarios. These are the tests that matter — everything else
 * in this service is ordinary.
 *
 * Each one maps to a failure case in the design document. The assertion is
 * almost always the same: how many times did money actually move?
 */

import { beforeEach, describe, expect, it } from "vitest";

import { CAPTURE_RETRYABLE, CAPTURE_TERMINAL, CAPTURE_NO_LEDGER } from "@/lib/chargebee";
import { createSync, OUTCOME } from "@/lib/sync";
import { DEFAULT_LAG_MS } from "@/lib/window";
import {
  FakeChargebee,
  FakeUsage,
  MINUTE,
  RATE,
  SLUG,
  T0,
  TENANT,
  makeFakePrisma,
  quietLogger,
} from "./harness";

const LAG = DEFAULT_LAG_MS;

function rig(opts: { usd?: string; balance?: number; accountStatus?: string } = {}) {
  const prisma = makeFakePrisma(opts.accountStatus ? { status: opts.accountStatus } : {});
  const chargebee = new FakeChargebee(opts.balance ?? 1000);
  const usage = new FakeUsage(opts.usd ?? "0");
  let now = T0;

  const sync = createSync({
    prisma: prisma as never,
    usage,
    chargebee,
    usdPerCredit: RATE,
    lagMs: LAG,
    maxWindowMs: 60 * MINUTE,
    clock: () => now,
    logger: quietLogger,
  });

  return {
    prisma,
    chargebee,
    usage,
    sync,
    /** Move the clock so a window ending `minutes` after T0 has closed. */
    advance(minutes: number) {
      now = T0 + minutes * MINUTE + LAG;
    },
  };
}

describe("billing sync", () => {
  let r: ReturnType<typeof rig>;

  beforeEach(() => {
    r = rig({ usd: "0.25" });
  });

  it("1 · bills a window once and draws the exact credits", async () => {
    r.advance(1);
    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.CAPTURED);
    // $0.25 at $0.001/credit = 250 credits.
    expect(result.consumeCredits).toBe("250");
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.chargebee.balance).toBe(750);
    expect(r.prisma._entries).toHaveLength(1);
    expect(r.prisma._entries[0]!.deltaCredits).toBe("-250");
  });

  it("2 · re-running with no new usage charges nothing more", async () => {
    r.advance(1);
    await r.sync.runTenant(SLUG);

    // The $10 -> $12 case from the brief: a later run bills the delta, never the
    // running total. With no new traffic and no newly-closed window there is
    // nothing to do at all — and crucially, no second charge.
    r.usage.defaultUsd = "0";
    const second = await r.sync.runTenant(SLUG);
    const third = await r.sync.runTenant(SLUG);

    expect(second.outcome).toBe(OUTCOME.IDLE);
    expect(third.outcome).toBe(OUTCOME.IDLE);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.chargebee.balance).toBe(750);

    // And once a window HAS closed with no traffic in it, it is skipped rather
    // than sent to Chargebee, which rejects a zero amount.
    r.advance(2);
    const fourth = await r.sync.runTenant(SLUG);
    expect(fourth.outcome).toBe(OUTCOME.SKIPPED);
    expect(r.chargebee.appliedCount).toBe(1);
  });

  it("2b · bills only the increment when usage grows", async () => {
    r.usage.set(T0, "0.010"); // first window: $0.010 -> 10 credits
    r.advance(1);
    await r.sync.runTenant(SLUG);

    r.usage.set(T0 + MINUTE, "0.002"); // next window: $0.002 -> 2 credits
    r.advance(2);
    await r.sync.runTenant(SLUG);

    expect(r.chargebee.captures.map((c) => c.amount)).toEqual(["10", "2"]);
    expect(r.chargebee.balance).toBe(988);
  });

  it("3 · a crash after capture but before the local write charges once", async () => {
    r.advance(1);

    // Chargebee accepts the charge, then our transaction fails.
    const original = r.prisma.$transaction;
    r.prisma.$transaction = async () => {
      throw new Error("connection reset");
    };
    await expect(r.sync.runTenant(SLUG)).rejects.toThrow("connection reset");

    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.prisma._entries).toHaveLength(0); // nothing recorded locally yet

    // Next tick finds the pending batch and replays it with the SAME id.
    r.prisma.$transaction = original;
    const recovered = await r.sync.runTenant(SLUG);

    expect(recovered.outcome).toBe(OUTCOME.REPLAYED);
    expect(r.chargebee.appliedCount).toBe(1); // money moved exactly once
    expect(r.chargebee.balance).toBe(750);
    expect(r.prisma._entries).toHaveLength(1);
    expect(r.chargebee.captures).toHaveLength(2); // but we did try twice
    expect(r.chargebee.captures[0]!.id).toBe(r.chargebee.captures[1]!.id);
  });

  it("4 · a Chargebee 500 leaves the batch pending and holds the cursor", async () => {
    r.advance(1);
    r.chargebee.fail({ kind: CAPTURE_RETRYABLE, error: Object.assign(new Error("503"), { retryable: true }) });

    const first = await r.sync.runTenant(SLUG);
    expect(first.outcome).toBe(OUTCOME.PENDING);
    expect(first.attempts).toBe(1);
    expect(r.chargebee.appliedCount).toBe(0);

    const second = await r.sync.runTenant(SLUG);
    expect(second.outcome).toBe(OUTCOME.CAPTURED);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.prisma._entries).toHaveLength(1);
  });

  it("5 · concurrent runs produce exactly one capture", async () => {
    r.advance(1);
    const [a, b] = await Promise.all([r.sync.runTenant(SLUG), r.sync.runTenant(SLUG)]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toContain(OUTCOME.CAPTURED);
    expect(outcomes).toContain(OUTCOME.CONTENDED);
    expect(r.chargebee.appliedCount).toBe(1);
  });

  it("6 · a zero-spend window is skipped and the cursor still advances", async () => {
    const quiet = rig({ usd: "0" });
    quiet.advance(1);

    const first = await quiet.sync.runTenant(SLUG);
    expect(first.outcome).toBe(OUTCOME.SKIPPED);
    expect(quiet.chargebee.captures).toHaveLength(0);

    // The cursor moved, so a later window is reachable — a quiet tenant must
    // not wedge the pipeline behind an un-billable window.
    quiet.usage.set(T0 + MINUTE, "0.001");
    quiet.advance(2);
    const second = await quiet.sync.runTenant(SLUG);
    expect(second.outcome).toBe(OUTCOME.CAPTURED);
  });

  it("7 · a terminal 4xx fails the batch and holds the cursor", async () => {
    r.advance(1);
    r.chargebee.fail({ kind: CAPTURE_TERMINAL, error: new Error("invalid unit_id") });

    const result = await r.sync.runTenant(SLUG);
    expect(result.outcome).toBe(OUTCOME.FAILED);
    expect(r.chargebee.appliedCount).toBe(0);

    // Cursor held: nothing after the failed window bills until a human resolves
    // it. Silent accumulation is acceptable for a ticket sync, not for money.
    const batches = [...r.prisma._batches.values()];
    expect(batches).toHaveLength(1);
    expect(batches[0]!.status).toBe("failed");
  });

  it("8 · a subscription with no prepaid ledger is skipped, loudly", async () => {
    r.advance(1);
    r.chargebee.fail({ kind: CAPTURE_NO_LEDGER, error: new Error("resource_not_found") });

    const result = await r.sync.runTenant(SLUG);
    expect(result.outcome).toBe(OUTCOME.NOT_BILLABLE);
    expect(result.reason).toBe("no prepaid ledger");
    expect(r.chargebee.appliedCount).toBe(0);
  });

  it("9 · nothing is billed before the lag buffer has elapsed", async () => {
    // Steady state on a fast cron: idle, not an error, and no ClickHouse read.
    const result = await r.sync.runTenant(SLUG);
    expect(result.outcome).toBe(OUTCOME.IDLE);
    expect(r.usage.reads).toHaveLength(0);
  });

  it("10 · a ClickHouse failure leaves no batch behind", async () => {
    r.advance(1);
    r.usage.throwNext = new Error("clickhouse unreachable");

    await expect(r.sync.runTenant(SLUG)).rejects.toThrow("clickhouse unreachable");

    // No batch, no cursor movement, no charge — the next tick simply retries.
    expect(r.prisma._batches.size).toBe(0);
    expect(r.chargebee.appliedCount).toBe(0);
  });

  it("11 · a cancelled account drains what is pending, then stops", async () => {
    r.advance(1);
    r.chargebee.fail({ kind: CAPTURE_RETRYABLE, error: Object.assign(new Error("503"), { retryable: true }) });
    await r.sync.runTenant(SLUG); // leaves a pending batch

    r.prisma._accounts.get(TENANT)!.status = "cancelled";

    const drained = await r.sync.runTenant(SLUG);
    expect(drained.outcome).toBe(OUTCOME.CAPTURED); // the pending batch settles

    const after = await r.sync.runTenant(SLUG);
    expect(after.outcome).toBe(OUTCOME.NOT_BILLABLE);
    expect(after.reason).toBe("subscription cancelled");
  });

  it("12 · a tenant with no subscription is never charged", async () => {
    const unlinked = rig({ usd: "0.25" });
    unlinked.prisma._accounts.get(TENANT)!.chargebeeSubscriptionId = null;
    unlinked.advance(1);

    const result = await unlinked.sync.runTenant(SLUG);
    expect(result.outcome).toBe(OUTCOME.NOT_BILLABLE);
    expect(unlinked.chargebee.captures).toHaveLength(0);
  });

  it("13 · the ledger balance always equals what Chargebee took", async () => {
    for (let minute = 0; minute < 5; minute += 1) {
      r.usage.set(T0 + minute * MINUTE, "0.01"); // 10 credits per window
      r.advance(minute + 1);
      await r.sync.runTenant(SLUG);
    }

    const consumed = r.prisma._entries.reduce(
      (sum: number, e: { deltaCredits: string }) => sum + Number(e.deltaCredits),
      0,
    );
    expect(consumed).toBe(-50);
    expect(r.chargebee.balance).toBe(950);
    expect(1000 + consumed).toBe(r.chargebee.balance);
  });
});
