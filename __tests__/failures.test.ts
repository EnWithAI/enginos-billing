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
  CAPTURE_RATE_LIMITED,
  CAPTURE_REPLAYED,
  CAPTURE_RETRYABLE,
  CAPTURE_TERMINAL,
  classify,
  createChargebee,
  type ChargebeeError,
} from "@/integrations/chargebee";
import { PROCESSING_LEASE_MS, SYNC } from "@/models/sync-status";
import { assertSlug, windowQuery } from "@/integrations/clickhouse/usage-source";
import { OUTCOME, createUsageSyncService } from "@/services/usage-sync.service";
import { FakeChargebee, FakeUsageSource, MINUTE, RATE, SLUG, T0, TENANT, makeFakePrisma, quietLogger } from "./harness";

const LAG = 2 * MINUTE;

/** One tenant, activated at T0; `usd` is one costed event ingested at T0 + 30s. */
function rig(opts: { usd?: number; balance?: number } = {}) {
  const prisma = makeFakePrisma({}, T0);
  const chargebee = new FakeChargebee(opts.balance ?? 1000);
  const usage = new FakeUsageSource();
  if (opts.usd !== undefined) usage.add("t1:s1", T0 + 30_000, opts.usd);
  const blocked: Array<{ tenantId: string; reason?: string }> = [];
  let now = T0;
  const sync = createUsageSyncService({
    prisma: prisma as never,
    usage,
    chargebee,
    usdPerCredit: RATE,
    lagMs: LAG,
    clock: () => {
      prisma._now = now;
      return now;
    },
    logger: quietLogger,
    blockBudget: async (tenantId, reason) => void blocked.push({ tenantId, reason }),
  });
  return {
    prisma, chargebee, usage, sync, blocked,
    /** Move both clocks so usage ingested before T0 + m minutes has aged past the lag. */
    advance: (m: number) => { now = T0 + m * MINUTE + LAG; usage.nowMs = now; prisma._now = now; },
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
    // The cursor still moves: the window was READ and contained nothing, which
    // is a resolved window. Holding it here would re-read the same empty range
    // for ever.
    expect(r.prisma._cursor).toBe(T0 + MINUTE);
  });

  it("still bills a fallback that succeeded after a retry", async () => {
    // LiteLLM runs num_retries: 3. A failed attempt costs nothing, but a
    // fallback that reached a second provider DID cost money and must be
    // billed — two costed events sum to one charge.
    const r = rig();
    r.usage.add("t1:s1", T0 + 10_000, 0.0000127).add("t1:s2", T0 + 20_000, 0.0000127);
    r.advance(1);

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.SYNCED);
    expect(result.amount).toBe("0.0254");
    expect(r.chargebee.appliedCount).toBe(1);
  });

  it("does not let an absurd cost through without it being visible", async () => {
    // A runaway or mis-priced model would show up as a huge capture rather than
    // being silently clamped. Clamping would hide the incident; the operation
    // Chargebee records is the alarm.
    const r = rig({ usd: 500, balance: 1_000_000 });
    r.advance(1);

    const result = await r.sync.runTenant(SLUG);
    expect(result.amount).toBe("500000");
    expect(r.chargebee.balance).toBe(500_000);
  });
});

// ── credit exhaustion ──────────────────────────────────────────────────

describe("when credits run out", () => {
  it("holds the cursor rather than dropping the usage", async () => {
    // The usage must not be discarded, and with no batch table to owe it, the
    // ONLY thing that keeps it is the cursor not moving. Next tick reads the
    // same events and offers them again.
    const r = rig({ usd: 0.25 });
    r.advance(1);
    r.chargebee.fail({ kind: CAPTURE_TERMINAL, error: new Error("insufficient balance") });

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.INVALID);
    expect(r.chargebee.appliedCount).toBe(0);
    expect(r.prisma._cursor).toBe(T0);
    // The sync is KEPT, unresolved, and retried — that is what holds the usage.
    expect(r.prisma._stuck!.status).toBe(SYNC.INVALID);
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

    expect(result.outcome).toBe(OUTCOME.OUT_OF_CREDITS);
    expect(result.reason).toBe(SYNC.OUT_OF_CREDITS);
    expect(r.prisma._stuck!.status).toBe(SYNC.OUT_OF_CREDITS);
    expect(r.prisma._accounts.get(TENANT)!.status).toBe("exhausted");
    // Distinct from a terminal failure because the customer clears it by
    // paying. Both hold the cursor; only this one clears itself, with no
    // requeue step, because the usage was never taken off the queue.
    expect(r.prisma._cursor).toBe(T0);
    // And nothing more may run: Chargebee is what the customer bought.
    expect(r.blocked).toEqual([{ tenantId: TENANT, reason: "exhausted" }]);
  });

  it("blocks the team when a capture leaves the Chargebee balance at zero", async () => {
    // The LiteLLM cap normally stops spend first, but it only counts what
    // reaches the team. Chargebee running out is the final word.
    const r = rig({ usd: 0.25, balance: 250 }); // exactly the event's 250 credits
    r.advance(1);

    const result = await r.sync.runTenant(SLUG);

    expect(result.outcome).toBe(OUTCOME.SYNCED);
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

  it("records a definite refusal as INVALID, not as an unknown", async () => {
    // The distinction an operator needs: `INVALID` is "Chargebee said no",
    // `UNKNOWN` is "Chargebee did not say". Both hold the tenant; only one of
    // them means the money might already have moved.
    const r = rig({ usd: 0.25 });
    r.advance(1);
    r.chargebee.fail({ kind: CAPTURE_TERMINAL, error: new Error("insufficient balance") });

    await r.sync.runTenant(SLUG);

    expect(r.prisma._stuck!.status).toBe(SYNC.INVALID);
    expect(r.prisma._stuck!.error).toBe("insufficient balance");
  });
});

// ── cron / worker failures ─────────────────────────────────────────────

describe("when the cron or worker fails", () => {
  it("a crash while reading leaves nothing to reconcile", async () => {
    const r = rig({ usd: 0.25 });
    r.advance(1);
    r.usage.throwNext = new Error("worker killed mid-read");

    await expect(r.sync.runTenant(SLUG)).rejects.toThrow();
    expect(r.prisma._stuck).toBeUndefined();
    expect(r.prisma._cursor).toBe(T0);
    expect(r.chargebee.appliedCount).toBe(0);
  });

  it("a crash after the capture is recovered once its lease is over, charging once", async () => {
    const r = rig({ usd: 0.25 });
    r.advance(1);

    // The operation id is recorded, the capture lands, then the worker dies
    // before the status can be written. This is the exact sequence PROCESSING
    // exists for: the row says the id WAS on the wire, so recovery asks about
    // it rather than sending it again.
    r.chargebee.crashNext = "after";
    await expect(r.sync.runTenant(SLUG)).rejects.toThrow("worker killed after the capture landed");

    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.prisma._stuck!.status).toBe(SYNC.PROCESSING);
    expect(r.prisma._cursor).toBe(T0);

    // From the row, a dead sender and one still waiting on Chargebee look the
    // same, so the row is its sender's until the lease runs out: the next tick
    // holds, and asks nothing.
    expect((await r.sync.runTenant(SLUG)).outcome).toBe(OUTCOME.HOLDING);
    expect(r.chargebee.lookups).toEqual([]);

    const lease = PROCESSING_LEASE_MS / MINUTE;
    r.advance(1 + lease);
    const recovered = await r.sync.runTenant(SLUG);

    expect(recovered.outcome).toBe(OUTCOME.REPLAYED);
    expect(r.chargebee.appliedCount).toBe(1); // asked, not re-sent
    expect(r.prisma._cursor).toBe(T0 + (1 + lease) * MINUTE);
    expect(r.prisma._stuck).toBeUndefined();
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

  it("keeps an unknown outcome pending indefinitely, and settles it once Chargebee answers", async () => {
    // Turning an unknown into a failure after N tries used to wedge the tenant:
    // billing held behind a capture nothing would ever ask Chargebee about
    // again. Only Chargebee can resolve an unknown, so it waits for it — and
    // the cursor waits with it, so nothing newer is billed past it either.
    const r = rig({ usd: 0.25 });
    r.advance(1);

    // The capture times out: Chargebee may or may not have it.
    r.chargebee.fail({ kind: CAPTURE_RETRYABLE, error: Object.assign(new Error("timeout"), { retryable: true }) });
    expect((await r.sync.runTenant(SLUG)).outcome).toBe(OUTCOME.UNKNOWN);
    const pendingId = r.prisma._stuck!.id;

    // Three more ticks in which Chargebee still will not answer.
    for (let i = 0; i < 3; i += 1) {
      r.chargebee.lookupThrowsNext = Object.assign(new Error("timeout"), { retryable: true });
      expect((await r.sync.runTenant(SLUG)).outcome).toBe(OUTCOME.UNKNOWN);
      // The SAME id every time: a new one per attempt would be a new capture,
      // and the whole recovery would rest on nothing.
      expect(r.prisma._stuck!.id).toBe(pendingId);
    }

    expect(r.chargebee.appliedCount).toBe(0);
    expect(r.prisma._cursor).toBe(T0);

    // Chargebee is back and says the capture never landed, so it is re-sent.
    expect((await r.sync.runTenant(SLUG)).outcome).toBe(OUTCOME.SYNCED);
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.prisma._cursor).toBe(T0 + MINUTE);
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

  it("does not throw out of the capture when Chargebee refuses the key", async () => {
    // The 401 lands on the pre-send lookup, upstream of classify(). Throwing
    // there aborted the whole tenant run and left nothing behind.
    const unauthorised = () =>
      new Response(
        JSON.stringify({ api_error_code: "api_authentication_failed", message: "Sorry, authentication failed. Invalid api key" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    const { cb, posts } = chargebeeWith(unauthorised);

    const result = await cb.captureIdempotent({ id: "b1", subscriptionId: "sub_1", unitId: "u", amount: "1" });

    expect(result.kind).toBe(CAPTURE_RETRYABLE);
    expect(posts).toHaveLength(0); // never sent blind
  });

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

  it("treats 5xx as an unknown, 429 as rate limiting, and 4xx as terminal", () => {
    expect(classify(err({ status: 503, retryable: true }), "b1").kind).toBe(CAPTURE_RETRYABLE);
    // A 429 is also `retryable`, so this branch has to be tested BEFORE that
    // one — which is the order classify() checks them in. Collapsed together,
    // a throttled tenant was indistinguishable from one whose charge might
    // silently have landed.
    expect(classify(err({ status: 429, retryable: true }), "b1").kind).toBe(CAPTURE_RATE_LIMITED);
    expect(classify(err({ status: 400, retryable: false }), "b1").kind).toBe(CAPTURE_TERMINAL);
  });

  it("a rejected API key is an UNKNOWN, not a terminal failure", () => {
    // Terminal was the honest reading of "a retry cannot fix this", but it made
    // the error throw before the outcome was ever recorded: no batch, no
    // attempts, no escalation. A person fixes the key and the same capture
    // settles, so it belongs with the unknowns.
    expect(classify(err({ status: 401, apiErrorCode: "api_authentication_failed" }), "b1").kind).toBe(
      CAPTURE_RETRYABLE,
    );
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

// ── a capture id Chargebee has already taken ───────────────────────────

/**
 * Chargebee's answer to a capture whose id already exists, VERBATIM from the
 * live site (L1 dup_id_probe, 2026-09-24): re-POSTing operation e6b39290 gave
 * HTTP 400 and left the operation and the balance untouched.
 */
const LIVE_DUPLICATE_OPERATION = {
  message: "Duplicate operation id: one or more operationId values conflict.",
  type: "invalid_request",
  api_error_code: "ERROR_DUPLICATE_OPERATION_ID",
  error_code: "ERROR_DUPLICATE_OPERATION_ID",
  error_msg: "Duplicate operation id: one or more operationId values conflict.",
  http_status_code: 400,
};

/**
 * Just the ledger endpoints, over HTTP, for the REAL client: capture refuses a
 * reused id with the live answer above, and nothing is applied twice.
 */
function ledgerSite(balance = 1000) {
  const ops = new Map<string, Record<string, unknown>>();
  const posts: string[] = [];
  const state = { balance };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (url: URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v2/, "");
    if (init?.method === "POST" && path === "/ledger_operations/capture") {
      const body = new URLSearchParams(String(init.body));
      const id = body.get("id")!;
      posts.push(id);
      if (ops.has(id)) return json(400, LIVE_DUPLICATE_OPERATION);
      state.balance -= Number(body.get("amount"));
      ops.set(id, { id, type: "capture", amount: body.get("amount"), subscription_id: body.get("subscription_id") });
      return json(200, {
        ledger_operation: ops.get(id),
        ledger_account_balance: { provisioned_balance: { usable_balance: String(state.balance) } },
      });
    }
    if (path === "/ledger_account_balances") {
      return json(200, {
        list: [{ ledger_account_balance: { unit_id: "token", provisioned_balance: { usable_balance: String(state.balance) } } }],
      });
    }
    const op = /^\/ledger_operations\/(.+)$/.exec(path);
    if (op) {
      const found = ops.get(decodeURIComponent(op[1]!));
      return found ? json(200, { ledger_operation: found }) : json(404, { api_error_code: "resource_not_found", message: "not found" });
    }
    return json(404, { api_error_code: "resource_not_found", message: `unrouted ${path}` });
  }) as unknown as typeof fetch;
  return { ops, posts, state, fetchImpl };
}

describe("a capture id Chargebee has already taken (ERROR_DUPLICATE_OPERATION_ID, measured live)", () => {
  const err = (payload: Record<string, unknown>): ChargebeeError =>
    Object.assign(new Error(String(payload.message)), {
      status: 400,
      apiErrorCode: payload.api_error_code as string | undefined,
      errorCode: payload.error_code as string | undefined,
      retryable: false,
    }) as ChargebeeError;

  it("classifies the live duplicate answer as already applied, never as a terminal refusal", () => {
    // Before this was pinned it fell through to `terminal` → INVALID: a window
    // that HAD been charged was held on the 5-minute-to-an-hour backoff.
    expect(classify(err(LIVE_DUPLICATE_OPERATION), "op-1").kind).toBe(CAPTURE_REPLAYED);
  });

  it("recognises the code in either field, since Chargebee does not always fill both", () => {
    expect(classify(err({ ...LIVE_DUPLICATE_OPERATION, api_error_code: undefined }), "op-1").kind).toBe(CAPTURE_REPLAYED);
    expect(classify(err({ ...LIVE_DUPLICATE_OPERATION, error_code: undefined }), "op-1").kind).toBe(CAPTURE_REPLAYED);
    // The envelope's `type: invalid_request` must not make it look like a missing ledger.
    expect(classify(err(LIVE_DUPLICATE_OPERATION), "op-1").kind).not.toBe(CAPTURE_NO_LEDGER);
  });

  const ARGS = { id: "op-1", subscriptionId: "sub_1", unitId: "token", amount: "2.5" };

  it("the real client settles a duplicate as REPLAYED once it has SEEN the capture, with the balance read", async () => {
    const site = ledgerSite(10);
    site.ops.set(ARGS.id, { id: ARGS.id, type: "capture", amount: "2.5", subscription_id: "sub_1" });
    site.state.balance = 7.5;
    const cb = createChargebee({ site: "s", apiKey: "k", fetchImpl: site.fetchImpl, maxAttempts: 1, sleep: async () => {} });

    const result = await cb.capture(ARGS);

    expect(result).toMatchObject({ kind: CAPTURE_REPLAYED, operationId: ARGS.id, balanceAfter: "7.5" });
    expect(site.posts).toEqual([ARGS.id]);
    expect(site.state.balance).toBe(7.5); // nothing taken twice
  });

  it("a duplicate whose capture cannot be found is an UNKNOWN for the next tick's lookup, not INVALID", async () => {
    const site = ledgerSite();
    const cb = createChargebee({
      site: "s",
      apiKey: "k",
      maxAttempts: 1,
      sleep: async () => {},
      // Chargebee says the id is taken, but no capture of ours carries it.
      fetchImpl: (async (url: URL, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response(JSON.stringify(LIVE_DUPLICATE_OPERATION), { status: 400 })
          : site.fetchImpl(url, init)) as unknown as typeof fetch,
    });

    expect((await cb.capture(ARGS)).kind).toBe(CAPTURE_RETRYABLE);
  });
});

// ── a second caller while the first is mid-capture (live L1 C06x, C55) ─

describe("a second sync while the first one's capture is on the wire", () => {
  /**
   * The live L1 race, made deterministic: caller A's capture POST is held in
   * flight while caller B — a manual /api/internal/sync, a second replica, an
   * old worker mid-rollout — runs the same tenant. Both use the REAL client.
   */
  function race() {
    const prisma = makeFakePrisma({}, T0);
    const usage = new FakeUsageSource().add("t1:s1", T0 + 30_000, 0.0006);
    const site = ledgerSite();
    let now = T0 + 2 * MINUTE;
    usage.nowMs = now;
    const logs: Array<{ metric?: string }> = [];
    const logger = { log() {}, warn: (o: object) => void logs.push(o), error: (o: object) => void logs.push(o) };

    let releaseA!: () => void;
    const aHeld = new Promise<void>((r) => (releaseA = r));
    let aOnWire!: () => void;
    const aSent = new Promise<void>((r) => (aOnWire = r));
    const heldFetch = (async (url: URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        aOnWire();
        await aHeld;
      }
      return site.fetchImpl(url, init);
    }) as unknown as typeof fetch;

    const client = (fetchImpl: typeof fetch) =>
      createChargebee({ site: "s", apiKey: "k", fetchImpl, maxAttempts: 1, sleep: async () => {} });
    const build = (fetchImpl: typeof fetch) =>
      createUsageSyncService({
        prisma: prisma as never,
        usage,
        chargebee: client(fetchImpl),
        usdPerCredit: RATE,
        lagMs: MINUTE,
        clock: () => {
          prisma._now = now;
          return now;
        },
        logger,
      });

    return {
      prisma,
      site,
      logs,
      a: build(heldFetch),
      b: build(site.fetchImpl),
      aSent,
      releaseA,
      at: (ms: number) => {
        now = ms;
        usage.nowMs = ms;
        prisma._now = ms;
      },
    };
  }

  it("B leaves A's in-flight row alone: one POST, no lookup, and the window settles SUCCESS (L1 C06x, inverted)", async () => {
    const r = race();
    const a = r.a.runTenant(SLUG);
    await r.aSent; // A: row written, claimed PROCESSING, POST on the wire
    const row = r.prisma._log[0]!;
    expect(row.status).toBe(SYNC.PROCESSING);

    const b = await r.b.runTenant(SLUG);
    expect(b).toMatchObject({ outcome: OUTCOME.HOLDING, reason: SYNC.PROCESSING });

    r.releaseA();
    expect((await a).outcome).toBe(OUTCOME.SYNCED);

    expect(r.site.posts).toEqual([row.id]);
    expect(r.prisma._log[0]).toMatchObject({ status: SYNC.SUCCESS, attemptCount: 1 });
    expect(r.prisma._cursor).toBe(T0 + MINUTE);
  });

  it("even when A outlives its lease (a suspended host), A's late duplicate never turns B's SUCCESS into INVALID and holds nothing (L1 C06x/C55, inverted)", async () => {
    const r = race();
    const a = r.a.runTenant(SLUG);
    await r.aSent;
    const id = r.prisma._log[0]!.id;

    // A is frozen past its lease; B takes the row over, finds no capture yet, sends it.
    r.at(T0 + 2 * MINUTE + PROCESSING_LEASE_MS);
    const b = await r.b.runTenant(SLUG);
    expect(b.outcome).toBe(OUTCOME.SYNCED);
    expect(r.prisma._log[0]).toMatchObject({ status: SYNC.SUCCESS, attemptCount: 2 });

    // A wakes up: its POST reaches Chargebee second and is refused as a duplicate.
    r.releaseA();
    const late = await a;

    expect(r.site.posts).toEqual([id, id]); // the backstop case: two POSTs, one capture
    expect(r.site.ops.size).toBe(1);
    expect(late.outcome).toBe(OUTCOME.LOCKED); // the row was no longer A's to write
    expect(r.prisma._log[0]).toMatchObject({ status: SYNC.SUCCESS, attemptCount: 2 });
    expect(r.logs.map((l) => l.metric)).toContain("billing.sync.claim_lost");
    expect(r.logs.map((l) => l.metric)).not.toContain("billing.sync.invalid");

    // Nothing is held: the next tick carries on.
    expect((await r.b.runTenant(SLUG)).outcome).not.toBe(OUTCOME.HOLDING);
    expect(r.prisma._stuck).toBeUndefined();
  });

  it("a caller whose own fresh POST is the duplicate (the other landed first) records SUCCESS, not INVALID", async () => {
    // What the live C06x worker A hit, with the claim out of the way: its capture
    // was the SECOND to reach Chargebee.
    const prisma = makeFakePrisma({}, T0);
    const usage = new FakeUsageSource().add("t1:s1", T0 + 30_000, 0.0006);
    usage.nowMs = T0 + 2 * MINUTE;
    const site = ledgerSite();
    const firstPost = site.fetchImpl;
    // Chargebee already holds this id when our POST arrives.
    const fetchImpl = (async (url: URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const id = new URLSearchParams(String(init.body)).get("id")!;
        if (!site.ops.has(id)) await firstPost(url, init);
      }
      return site.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const sync = createUsageSyncService({
      prisma: prisma as never,
      usage,
      chargebee: createChargebee({ site: "s", apiKey: "k", fetchImpl, maxAttempts: 1, sleep: async () => {} }),
      usdPerCredit: RATE,
      lagMs: MINUTE,
      clock: () => T0 + 2 * MINUTE,
      logger: quietLogger,
    });

    expect((await sync.runTenant(SLUG)).outcome).toBe(OUTCOME.REPLAYED);
    expect(prisma._log[0]).toMatchObject({ status: SYNC.SUCCESS });
    expect(site.ops.size).toBe(1);
    expect(site.state.balance).toBe(999.4);
    expect(prisma._cursor).toBe(T0 + MINUTE);
  });
});

// ── ClickHouse query safety ────────────────────────────────────────────

describe("ClickHouse read safety", () => {
  // The rest of the query's shape — SELECT DISTINCT, span_nodes FINAL, the
  // ingested_at bounds, the absence of any Timestamp predicate — is asserted in
  // usage-sync.test.ts, beside the cursor behaviour that depends on it.
  it("refuses a slug that could alter the query", () => {
    // The slug becomes part of a database identifier and cannot be a bound
    // parameter, so it is the one injection surface in the read path.
    expect(() => assertSlug("org_acme; DROP TABLE x")).toThrow(TypeError);
    expect(() => assertSlug("org-acme")).toThrow(TypeError);
    expect(() => assertSlug("../etc")).toThrow(TypeError);
    expect(assertSlug("org_acme_com")).toBe("org_acme_com");
    expect(() => windowQuery("org-acme")).toThrow(TypeError);
  });

  it("never merges the tenant table with landing, which would count spans twice", () => {
    expect(windowQuery("org_acme_com")).not.toContain("merge(");
  });
});
