/**
 * Failure-handling suite.
 *
 * Every test here answers one question: when this breaks, does the customer get
 * charged twice, or does the usage get lost? Those are the only two ways a
 * billing system fails badly. Everything else is recoverable.
 */

import { describe, expect, it } from "vitest";

import {
  CAPTURE_INSUFFICIENT,
  CAPTURE_NO_LEDGER,
  CAPTURE_RETRYABLE,
  CAPTURE_TERMINAL,
  classify,
  createChargebee,
  type ChargebeeError,
} from "@/lib/chargebee";
import { assertSlug, toUsage, usageQuery } from "@/lib/clickhouse";
import { createSync, OUTCOME } from "@/lib/sync";
import { DEFAULT_LAG_MS } from "@/lib/window";
import { FakeChargebee, FakeUsage, MINUTE, RATE, SLUG, T0, TENANT, makeFakePrisma, quietLogger } from "./harness";

const LAG = DEFAULT_LAG_MS;

function rig(opts: { usd?: string; balance?: number } = {}) {
  const prisma = makeFakePrisma();
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
  return { prisma, chargebee, usage, sync, advance: (m: number) => { now = T0 + m * MINUTE + LAG; } };
}

// ── LLM-side failures ──────────────────────────────────────────────────

describe("when the LLM call fails", () => {
  it("bills nothing, because a failed call carries no cost attribute", async () => {
    // The ClickHouse query filters on `gen_ai.cost.total_cost != ''`. A provider
    // error produces a span with no cost, so it never reaches the sum. The
    // window is real and closes normally — it just has nothing in it.
    const r = rig({ usd: "0" });
    r.advance(1);

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.SKIPPED);
    expect(r.chargebee.appliedCount).toBe(0);
    expect(r.prisma._entries).toHaveLength(0);
  });

  it("still bills a fallback that succeeded after a retry", async () => {
    // LiteLLM runs num_retries: 3. A failed attempt costs nothing, but a
    // fallback that reached a second provider DID cost money and must be
    // billed — two costed spans in one window sum to one charge.
    const r = rig();
    r.usage.set(T0, "0.0000254", 2); // two costed spans, one window
    r.advance(1);

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.CAPTURED);
    expect(result.consumeCredits).toBe("0.0254");
    expect(r.chargebee.appliedCount).toBe(1);
  });

  it("does not let an absurd cost through without it being visible", async () => {
    // A runaway or mis-priced model would show up as a huge capture rather than
    // being silently clamped. Clamping would hide the incident; the ledger
    // entry is the alarm.
    const r = rig({ balance: 1_000_000 });
    r.usage.set(T0, "500");
    r.advance(1);

    const result = await r.sync.runTenant(SLUG);
    expect(result.consumeCredits).toBe("500000");
    expect(r.chargebee.balance).toBe(500_000);
  });
});

// ── credit exhaustion ──────────────────────────────────────────────────

describe("when credits run out", () => {
  it("holds the cursor rather than dropping the usage", async () => {
    // The v1 plan uses a CAPPED credit unit (token-test: is_unlimited false),
    // so Chargebee refuses a capture past zero. The usage must not be discarded
    // — the cursor stays put so it is billed once the balance is topped up.
    const r = rig({ usd: "0.25" });
    r.advance(1);
    r.chargebee.fail({ kind: CAPTURE_TERMINAL, error: new Error("insufficient balance") });

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.FAILED);
    expect(r.chargebee.appliedCount).toBe(0);

    // Cursor held: the next sweep retries the SAME window, it does not skip on.
    const batches = [...r.prisma._batches.values()];
    expect(batches).toHaveLength(1);
    expect(batches[0]!.status).toBe("failed");
    expect(batches[0]!.windowStart).toEqual(new Date(T0));
  });

  it("marks the account exhausted and keeps the usage when Chargebee refuses", async () => {
    // MEASURED code from the live site: HTTP 400, ERROR_INSUFFICIENT_BALANCE,
    // "Not enough balance exists in the account." Only fires on a capped credit
    // unit — one with unlimited overdraft silently accrues debt instead.
    const r = rig({ usd: "0.25" });
    r.advance(1);
    r.chargebee.fail({
      kind: CAPTURE_INSUFFICIENT,
      error: Object.assign(new Error("Not enough balance exists in the account."), {
        apiErrorCode: "ERROR_INSUFFICIENT_BALANCE",
        status: 400,
      }) as never,
    });

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.FAILED);
    expect(result.reason).toBe("insufficient credits");
    expect(r.prisma._accounts.get(TENANT)!.status).toBe("exhausted");
    // The usage is retained, not dropped — it bills after a top-up.
    expect([...r.prisma._batches.values()][0]!.status).toBe("failed");
    expect(r.prisma._entries).toHaveLength(0);
  });

  it("classifies the real ERROR_INSUFFICIENT_BALANCE code as insufficient, not generic terminal", async () => {
    const { classify } = await import("@/lib/chargebee");
    const err = Object.assign(new Error("Not enough balance exists in the account."), {
      apiErrorCode: "ERROR_INSUFFICIENT_BALANCE",
      status: 400,
      retryable: false,
    });
    expect(classify(err as never, "b1").kind).toBe(CAPTURE_INSUFFICIENT);
  });

  it("never writes a ledger entry for a charge that did not happen", async () => {
    const r = rig({ usd: "0.25" });
    r.advance(1);
    r.chargebee.fail({ kind: CAPTURE_TERMINAL, error: new Error("insufficient balance") });

    await r.sync.runTenant(SLUG);
    expect(r.prisma._entries).toHaveLength(0);
  });
});

// ── cron / worker failures ─────────────────────────────────────────────

describe("when the cron or worker fails", () => {
  it("a crash before the capture leaves nothing to reconcile", async () => {
    const r = rig({ usd: "0.25" });
    r.advance(1);
    r.usage.throwNext = new Error("worker killed mid-read");

    await expect(r.sync.runTenant(SLUG)).rejects.toThrow();
    expect(r.prisma._batches.size).toBe(0);
    expect(r.chargebee.appliedCount).toBe(0);
  });

  it("a crash after the capture is recovered on the next tick, charging once", async () => {
    const r = rig({ usd: "0.25" });
    r.advance(1);

    const realTx = r.prisma.$transaction;
    r.prisma.$transaction = async () => {
      throw new Error("worker killed mid-write");
    };
    await expect(r.sync.runTenant(SLUG)).rejects.toThrow();

    r.prisma.$transaction = realTx;
    const recovered = await r.sync.runTenant(SLUG);

    expect(recovered.outcome).toBe(OUTCOME.REPLAYED);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.prisma._entries).toHaveLength(1);
  });

  it("one tenant's failure does not abort the sweep for the others", async () => {
    const r = rig({ usd: "0.25" });
    r.advance(1);
    r.usage.throwNext = new Error("clickhouse died for this tenant");

    // runOnce catches per-tenant and keeps going — a broken subscription must
    // not stop everyone else's revenue.
    const summary = await r.sync.runOnce();
    expect(summary.errors).toHaveLength(1);
    expect(summary.tenantsScanned).toBe(1);
  });

  it("gives up after too many unknown outcomes rather than replaying forever", async () => {
    const prisma = makeFakePrisma();
    const chargebee = new FakeChargebee(1000);
    const usage = new FakeUsage("0.25");
    let now = T0 + MINUTE + LAG;
    const sync = createSync({
      prisma: prisma as never,
      usage,
      chargebee,
      usdPerCredit: RATE,
      lagMs: LAG,
      maxAttempts: 3,
      clock: () => now,
      logger: quietLogger,
    });

    for (let i = 0; i < 3; i += 1) {
      chargebee.fail({ kind: CAPTURE_RETRYABLE, error: Object.assign(new Error("503"), { retryable: true }) });
      await sync.runTenant(SLUG);
    }

    const batch = [...prisma._batches.values()][0]!;
    expect(batch.status).toBe("failed");
    expect(chargebee.appliedCount).toBe(0);
  });
});

// ── error classification ───────────────────────────────────────────────

describe("Chargebee error classification", () => {
  const err = (over: Partial<ChargebeeError>): ChargebeeError =>
    Object.assign(new Error("boom"), over) as ChargebeeError;

  it("treats a timeout as UNKNOWN, never as failure", () => {
    // The single most important classification. A timeout says nothing about
    // whether the charge landed — calling it a failure loses the usage, calling
    // it success loses the money. Only a replay can resolve it.
    expect(classify(err({ retryable: true }), "b1").kind).toBe(CAPTURE_RETRYABLE);
  });

  it("treats 5xx and 429 as retryable, 4xx as terminal", () => {
    expect(classify(err({ status: 503, retryable: true }), "b1").kind).toBe(CAPTURE_RETRYABLE);
    expect(classify(err({ status: 429, retryable: true }), "b1").kind).toBe(CAPTURE_RETRYABLE);
    expect(classify(err({ status: 400, retryable: false }), "b1").kind).toBe(CAPTURE_TERMINAL);
  });

  it("treats a missing ledger as skippable, not as a hard failure", () => {
    expect(classify(err({ apiErrorCode: "resource_not_found" }), "b1").kind).toBe(CAPTURE_NO_LEDGER);
  });

  it("surfaces a network error as retryable rather than swallowing it", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const cb = createChargebee({ site: "s", apiKey: "k", fetchImpl, maxAttempts: 1 });
    const result = await cb.capture({
      id: "b1",
      subscriptionId: "sub_1",
      unitId: "token",
      amount: "1",
    });

    expect(result.kind).toBe(CAPTURE_RETRYABLE);
  });
});

// ── ClickHouse query safety ────────────────────────────────────────────

describe("ClickHouse read safety", () => {
  it("refuses a slug that could alter the query", () => {
    // The slug becomes part of a database identifier and cannot be a bound
    // parameter, so it is the one injection surface in the read path.
    expect(() => assertSlug("org_acme; DROP TABLE x")).toThrow(TypeError);
    expect(() => assertSlug("org-acme")).toThrow(TypeError);
    expect(() => assertSlug("../etc")).toThrow(TypeError);
    expect(assertSlug("org_acme_com")).toBe("org_acme_com");
  });

  it("reads the deduplicated table, never the raw trace table", () => {
    const q = usageQuery("org_acme_com");
    expect(q).toContain("span_nodes FINAL");
    expect(q).not.toContain("otel_traces");
    // A union across landing and tenant counts every routed span twice.
    expect(q).not.toContain("merge(");
  });

  it("uses a half-open window so a boundary span bills exactly once", () => {
    const q = usageQuery("org_acme_com");
    expect(q).toContain("Timestamp >= {from:DateTime64(3)}");
    expect(q).toContain("Timestamp <  {to:DateTime64(3)}");
  });

  it("converts float sums to decimal strings immediately", () => {
    // ClickHouse hands back float64. Pinning it once here stops the binary
    // representation drifting through the conversion to credits.
    const u = toUsage({
      spans: 3,
      billed_usd: 1e-7,
      provider_usd: 1e-7,
      margin_usd: 0,
      in_tok: 10,
      out_tok: 5,
    });
    expect(u.billedUsd).toBe("0.0000001");
    expect(typeof u.billedUsd).toBe("string");
  });

  it("treats an empty result as a real zero, not as a failure", () => {
    const u = toUsage({ spans: 0, billed_usd: 0, provider_usd: 0, margin_usd: 0, in_tok: 0, out_tok: 0 });
    expect(u.spans).toBe(0);
    expect(u.billedUsd).toBe("0");
  });
});
