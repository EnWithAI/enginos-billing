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
  CAPTURE_OK,
  CAPTURE_REPLAYED,
  CAPTURE_RETRYABLE,
  CAPTURE_TERMINAL,
  classify,
  createChargebee,
  type ChargebeeError,
} from "@/lib/chargebee";
import { assertSlug, eventsQuery } from "@/lib/usage-events";
import { OUTCOME, createUsageSync } from "@/lib/usage-sync";
import { FakeChargebee, FakeUsageSource, MINUTE, RATE, SLUG, T0, TENANT, makeFakePrisma, quietLogger } from "./harness";

const LAG = 2 * MINUTE;

/** One tenant, sync_from T0; `usd` is one costed event ingested at T0 + 30s. */
function rig(opts: { usd?: number; balance?: number } = {}) {
  const prisma = makeFakePrisma();
  const chargebee = new FakeChargebee(opts.balance ?? 1000);
  const usage = new FakeUsageSource();
  if (opts.usd !== undefined) usage.add("t1:s1", T0 + 30_000, opts.usd);
  const blocked: Array<{ tenantId: string; reason?: string }> = [];
  let now = T0;
  const sync = createUsageSync({
    prisma: prisma as never,
    usage,
    chargebee,
    usdPerCredit: RATE,
    lagMs: LAG,
    clock: () => now,
    logger: quietLogger,
    blockBudget: async (tenantId, reason) => void blocked.push({ tenantId, reason }),
  });
  return {
    prisma, chargebee, usage, sync, blocked,
    /** Move both clocks so usage ingested before T0 + m minutes has aged past the lag. */
    advance: (m: number) => { now = T0 + m * MINUTE + LAG; usage.nowMs = now; },
  };
}

// ── LLM-side failures ──────────────────────────────────────────────────

describe("when the LLM call fails", () => {
  it("bills nothing, because a failed call carries no cost attribute", async () => {
    // The ClickHouse query filters on `gen_ai.cost.total_cost != ''`. A provider
    // error produces a span with no cost, so it is never an event at all.
    const r = rig();
    r.advance(1);

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.IDLE);
    expect(r.chargebee.appliedCount).toBe(0);
    expect(r.prisma._entries).toHaveLength(0);
  });

  it("still bills a fallback that succeeded after a retry", async () => {
    // LiteLLM runs num_retries: 3. A failed attempt costs nothing, but a
    // fallback that reached a second provider DID cost money and must be
    // billed — two costed events sum to one charge.
    const r = rig();
    r.usage.add("t1:s1", T0 + 10_000, 0.0000127).add("t1:s2", T0 + 20_000, 0.0000127);
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
    const r = rig({ usd: 500, balance: 1_000_000 });
    r.advance(1);

    const result = await r.sync.runTenant(SLUG);
    expect(result.consumeCredits).toBe("500000");
    expect(r.chargebee.balance).toBe(500_000);
  });
});

// ── credit exhaustion ──────────────────────────────────────────────────

describe("when credits run out", () => {
  it("holds billing rather than dropping the usage", async () => {
    // The usage must not be discarded — its capture stays recorded (failed)
    // and nothing newer is billed past it until it is resolved.
    const r = rig({ usd: 0.25 });
    r.advance(1);
    r.chargebee.fail({ kind: CAPTURE_TERMINAL, error: new Error("insufficient balance") });

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.FAILED);
    expect(r.chargebee.appliedCount).toBe(0);
    const batches = [...r.prisma._batches.values()];
    expect(batches).toHaveLength(1);
    expect(batches[0]!.status).toBe("failed");
    expect(r.prisma._cursors.get(TENANT)!.lastProcessedAt).toEqual(new Date(T0));
  });

  it("marks the account exhausted and keeps the usage when Chargebee refuses", async () => {
    // MEASURED code from the live site: HTTP 400, ERROR_INSUFFICIENT_BALANCE,
    // "Not enough balance exists in the account." Only fires on a capped credit
    // unit — one with unlimited overdraft silently accrues debt instead.
    const r = rig({ usd: 0.25 });
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
    // And nothing more may run: Chargebee is what the customer bought.
    expect(r.blocked).toEqual([{ tenantId: TENANT, reason: "exhausted" }]);
  });

  it("blocks the team when a capture leaves the Chargebee balance at zero", async () => {
    // The LiteLLM cap normally stops spend first, but it only counts what
    // reaches the team. Chargebee running out is the final word.
    const r = rig({ usd: 0.25, balance: 250 }); // exactly the event's 250 credits
    r.advance(1);

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.CAPTURED);
    expect(r.prisma._accounts.get(TENANT)!.status).toBe("exhausted");
    expect(r.blocked).toEqual([{ tenantId: TENANT, reason: "exhausted" }]);
  });

  it("does not block while credits remain", async () => {
    const r = rig({ usd: 0.25, balance: 1000 });
    r.advance(1);

    await r.sync.runTenant(SLUG);

    expect(r.blocked).toEqual([]);
  });

  it("classifies the real ERROR_INSUFFICIENT_BALANCE code as insufficient, not generic terminal", async () => {
    const err = Object.assign(new Error("Not enough balance exists in the account."), {
      apiErrorCode: "ERROR_INSUFFICIENT_BALANCE",
      status: 400,
      retryable: false,
    });
    expect(classify(err as never, "b1").kind).toBe(CAPTURE_INSUFFICIENT);
  });

  it("never writes a ledger entry for a charge that did not happen", async () => {
    const r = rig({ usd: 0.25 });
    r.advance(1);
    r.chargebee.fail({ kind: CAPTURE_TERMINAL, error: new Error("insufficient balance") });

    await r.sync.runTenant(SLUG);
    expect(r.prisma._entries).toHaveLength(0);
  });
});

// ── cron / worker failures ─────────────────────────────────────────────

describe("when the cron or worker fails", () => {
  it("a crash while reading leaves nothing to reconcile", async () => {
    const r = rig({ usd: 0.25 });
    r.advance(1);
    r.usage.throwNext = new Error("worker killed mid-read");

    await expect(r.sync.runTenant(SLUG)).rejects.toThrow();
    expect(r.prisma._batches.size).toBe(0);
    expect(r.chargebee.appliedCount).toBe(0);
  });

  it("a crash after the capture is recovered on the next tick, charging once", async () => {
    const r = rig({ usd: 0.25 });
    r.advance(1);

    // The batch is recorded, the capture lands, then the settle write dies.
    const realTx = r.prisma.$transaction;
    let calls = 0;
    r.prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
      calls += 1;
      if (calls === 2) throw new Error("worker killed mid-write");
      return realTx(fn as never);
    };
    await expect(r.sync.runTenant(SLUG)).rejects.toThrow();

    r.prisma.$transaction = realTx;
    const recovered = await r.sync.runTenant(SLUG);

    expect(recovered.outcome).toBe(OUTCOME.REPLAYED);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.prisma._entries).toHaveLength(1);
  });

  it("one tenant's failure does not abort the pass for the others", async () => {
    const r = rig({ usd: 0.25 });
    r.advance(1);
    r.usage.throwNext = new Error("clickhouse died for this tenant");

    // runOnce catches per-tenant and keeps going — a broken subscription must
    // not stop everyone else's revenue.
    const summary = await r.sync.runOnce();
    expect(summary.errors).toHaveLength(1);
    expect(summary.tenantsScanned).toBe(1);
  });

  it("keeps an unknown outcome pending past maxAttempts, escalates, and settles once Chargebee answers", async () => {
    // Marking it `failed` after N tries used to wedge the tenant: billing held
    // behind a capture nothing would ever ask Chargebee about again. Only
    // Chargebee can resolve an unknown, so the batch waits for it — louder.
    const prisma = makeFakePrisma();
    const chargebee = new FakeChargebee(1000);
    const usage = new FakeUsageSource().add("t1:s1", T0 + 30_000, 0.25);
    usage.nowMs = T0 + MINUTE + LAG;
    const errors: Array<{ metric?: string }> = [];
    const sync = createUsageSync({
      prisma: prisma as never,
      usage,
      chargebee,
      usdPerCredit: RATE,
      lagMs: LAG,
      maxAttempts: 3,
      clock: () => T0 + MINUTE + LAG,
      logger: { ...quietLogger, error: (obj: unknown) => errors.push(obj as { metric?: string }) },
    });

    for (let i = 0; i < 4; i += 1) {
      chargebee.fail({ kind: CAPTURE_RETRYABLE, error: Object.assign(new Error("timeout"), { retryable: true }) });
      expect((await sync.runTenant(SLUG)).outcome).toBe(OUTCOME.PENDING);
    }

    const onlyBatch = () => {
      const batches = [...prisma._batches.values()];
      expect(batches).toHaveLength(1);
      return batches[0]!;
    };
    expect(onlyBatch().status).toBe("pending");
    expect(errors.filter((e) => e.metric === "billing.sync.stuck")).toHaveLength(2); // attempts 3 and 4
    expect(chargebee.appliedCount).toBe(0);

    // Chargebee is back: the same batch settles, exactly once.
    expect((await sync.runTenant(SLUG)).outcome).toBe(OUTCOME.CAPTURED);
    expect(onlyBatch().status).toBe("captured");
    expect(chargebee.appliedCount).toBe(1);
  });
});

// ── capture after an unknown outcome ───────────────────────────────────

describe("captureIdempotent against Chargebee", () => {
  const ARGS = { id: "batch-1", subscriptionId: "sub_1", unitId: "token", amount: "2.5" };

  const NOT_FOUND = () =>
    new Response(JSON.stringify({ api_error_code: "resource_not_found", message: "batch-1 not found" }), { status: 404 });
  const CAPTURED = () =>
    new Response(JSON.stringify({ ledger_operation: { id: ARGS.id, type: "capture" } }), { status: 200 });

  /** Routes the retrieve and the capture separately and records every capture POST. */
  function chargebeeWith(
    lookup: () => Response | Promise<Response>,
    send: (attempt: number) => Response | Promise<Response> = CAPTURED,
    maxAttempts = 1,
  ) {
    const posts: string[] = [];
    const fetchImpl = (async (url: URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(String(url));
        return send(posts.length);
      }
      return lookup();
    }) as unknown as typeof fetch;
    const cb = createChargebee({ site: "s", apiKey: "k", fetchImpl, maxAttempts, sleep: async () => {} });
    return { cb, posts };
  }

  it("does not re-send a capture in the same tick after its response is lost", async () => {
    // The POST may have landed. Re-sending it in place — as the generic retry
    // did — leans on Chargebee's undocumented answer to a reused id. The next
    // tick retrieves the id first instead.
    const { cb, posts } = chargebeeWith(
      NOT_FOUND,
      () => {
        throw new Error("The operation was aborted");
      },
      3,
    );

    const result = await cb.captureIdempotent(ARGS);

    expect(result.kind).toBe(CAPTURE_RETRYABLE);
    expect(posts).toHaveLength(1);
  });

  it("does not re-send a capture in the same tick after a 5xx", async () => {
    const { cb, posts } = chargebeeWith(NOT_FOUND, () => new Response("{}", { status: 503 }), 3);

    expect((await cb.captureIdempotent(ARGS)).kind).toBe(CAPTURE_RETRYABLE);
    expect(posts).toHaveLength(1);
  });

  it("re-sends a rate-limited capture, which Chargebee refused before applying", async () => {
    const { cb, posts } = chargebeeWith(
      NOT_FOUND,
      (attempt) => (attempt === 1 ? new Response("{}", { status: 429 }) : CAPTURED()),
      3,
    );

    expect((await cb.captureIdempotent(ARGS)).kind).toBe(CAPTURE_OK);
    expect(posts).toHaveLength(2);
  });

  it("settles a capture that landed before the timeout, without charging again", async () => {
    const { cb, posts } = chargebeeWith(
      () => new Response(JSON.stringify({ ledger_operation: { id: ARGS.id, type: "capture", subscription_id: "sub_1" } }), { status: 200 }),
    );

    const result = await cb.captureIdempotent(ARGS);

    expect(result.kind).toBe(CAPTURE_REPLAYED);
    expect(posts).toHaveLength(0);
  });

  it("sends the capture only after Chargebee says the id does not exist", async () => {
    const { cb, posts } = chargebeeWith(
      () => new Response(JSON.stringify({ api_error_code: "resource_not_found", message: "batch-1 not found" }), { status: 404 }),
    );

    const result = await cb.captureIdempotent(ARGS);

    expect(result.kind).toBe(CAPTURE_OK);
    expect(posts).toEqual(["https://s.chargebee.com/api/v2/ledger_operations/capture"]);
  });

  it("does not capture blind when the lookup itself times out", async () => {
    // A failed lookup is another unknown. Capturing anyway would re-send a
    // charge that may already have landed; staying pending costs one tick.
    const { cb, posts } = chargebeeWith(() => {
      throw new Error("The operation was aborted");
    });

    const result = await cb.captureIdempotent(ARGS);

    expect(result.kind).toBe(CAPTURE_RETRYABLE);
    expect(posts).toHaveLength(0);
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
    expect(() => eventsQuery("org-acme")).toThrow(TypeError);
  });

  it("reads the deduplicated table, never the raw trace table", () => {
    const q = eventsQuery("org_acme_com");
    expect(q).toContain("tenant_org_acme_com.span_nodes FINAL");
    expect(q).not.toContain("otel_traces");
    // A union across landing and tenant counts every routed span twice.
    expect(q).not.toContain("merge(");
  });

  it("does not bill responses served from LiteLLM's cache", () => {
    // MEASURED: a cache hit's span carries the full cost while LiteLLM records
    // spend 0 for it — billing it charged for provider calls that never
    // happened and drained Chargebee faster than the LiteLLM cap moved.
    expect(eventsQuery("org_acme_com")).toContain("JSONExtractString(attrs['hidden_params'], 'cache_key') = ''");
  });

  it("keys each event on its span, so a re-sent copy is the same event", () => {
    expect(eventsQuery("org_acme_com").replace(/\s+/g, " ")).toContain("concat(TraceId, ':', SpanId) AS event_key");
  });

  it("reads strictly after the cursor on (ingested_at, event_key), up to the safe boundary", () => {
    // Ingestion time, not span time: a span that arrives late still lands after
    // the cursor. The key breaks ties between events ingested in the same ms.
    const q = eventsQuery("org_acme_com");
    expect(q).toContain("ingested_at <= {until:DateTime64(3)}");
    expect(q).toContain("ingested_at > {after:DateTime64(3)}");
    expect(q).toContain("(ingested_at = {after:DateTime64(3)} AND concat(TraceId, ':', SpanId) > {afterKey:String})");
    expect(q).toContain("ORDER BY ingested_at, event_key");
    expect(q).toContain("LIMIT {limit:UInt32}");
  });

  it("floors span time — at sync_from, or the key horizon behind the cursor", () => {
    expect(eventsQuery("org_acme_com")).toContain("Timestamp >= {minTimestamp:DateTime64(3)}");
  });
});
