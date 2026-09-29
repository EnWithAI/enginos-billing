/**
 * Failure matrix — area: chargebee-and-amounts (C16-C21, C28-C30, C44-C46).
 *
 * Every test drives the REAL usage sync (createUsageSyncService) over the REAL
 * Chargebee client (createChargebee) whose fetch is an HTTP-level fake of the
 * ledger (failure-matrix-chargebee-and-amounts.helpers.ts). So each fault is a
 * real HTTP shape — status + Chargebee error body, a request that never answers
 * until the client's AbortController fires, a socket that drops, optionally after
 * the charge was applied — and it passes through the client's own retry
 * predicate, classify(), and balance parsing on its way to a sync status.
 *
 * ALREADY COVERED ELSEWHERE (at the CaptureResult level, via harness FakeChargebee,
 * which bypasses the real client) — kept here as focused HTTP-level tests anyway:
 *   C16  usage-sync: "bills the window and moves the cursor to its end", "sends the capture under
 *        the row's own id…", "does not pay for a lookup on the first send of an id",
 *        "several events in one window › bills them as one capture for the summed amount"
 *   C17  failures: "does not re-send a capture in the same tick after a 5xx" (client only),
 *        "treats 5xx as an unknown, 429 as rate limiting, and 4xx as terminal";
 *        usage-sync: "an UNKNOWN is retried every tick, because one lookup is all it costs"
 *   C18  usage-sync: "INVALID waits much longer, and heals itself once the cause is fixed",
 *        "retries the SAME row rather than opening a second one", "a subscription with no prepaid
 *        ledger holds the usage…"; failures: "records a definite refusal as INVALID…"
 *   C19  failures: "does not capture blind when the lookup itself times out", "does not re-send a
 *        capture in the same tick after its response is lost", "settles a capture that landed before
 *        the timeout…"; usage-sync: "always asks Chargebee before re-sending a row that may have been on the wire"
 *   C20  failures: "a crash after the capture is recovered on the next tick, charging once";
 *        compound-flows: "crosses RATE_LIMITING → UNKNOWN → SUCCESS on one row, charging once"
 *   C21  failures: "keeps an unknown outcome pending indefinitely, and settles it once Chargebee answers",
 *        "does not throw out of the capture when Chargebee refuses the key", "surfaces a network error as retryable…"
 *   C28  usage-sync: "zero-cost usage › is recorded as resolved without calling Chargebee…"
 *   C29  failures: "does not let an absurd cost through without it being visible" ($500); decimal.test.ts
 *   C30  usage-sync: "duplicate ClickHouse rows", "carries no LIMIT…"; decimal: "sums ten thousand tiny costs…"
 *   C44  only as FakeChargebee.taken in several suites — no test reads a real ledger delta
 *   C45  failures: "blocks the team when a capture leaves the Chargebee balance at zero". FakeChargebee
 *        returns balanceAfter on every path; the real client now does too (a replay reads the balance)
 *   C46  failures: "marks the account exhausted and keeps the usage when Chargebee refuses";
 *        compound-flows: "credits run out, usage keeps arriving, then a top-up"
 *
 * Replaced mechanisms: there is no local credit ledger (docs/REFACTOR-PLAN.md) — "ledger delta" is
 * asserted against Chargebee's own ledger (the fake's operations and balance), and against the
 * chargebee_sync row that records what was sent.
 */

import { describe, expect, it } from "vitest";

import { createUsageSource } from "@/integrations/clickhouse/usage-source";
import { createGatewayClient } from "@/integrations/litellm/client";
import { add, decimal } from "@/models/decimal";
import { usdToCredits } from "@/models/rate";
import { PROCESSING_LEASE_MS, SYNC, retryDelayMs } from "@/models/sync-status";
import { BILLING_MANAGED, BLOCK_REASON, SPEND_BASELINE, createGatewayBudget } from "@/services/gateway-budget.service";
import { OUTCOME } from "@/services/usage-sync.service";

import { MINUTE, RATE, SLUG, T0, TENANT } from "./harness";
import {
  API_KEY,
  F,
  LiteLLMHttpFake,
  enforceDecimal20_10,
  fx,
  fxStr,
  matrixRig,
  type Fault,
} from "./failure-matrix-chargebee-and-amounts.helpers";

const sec = (ms: number) => String(Math.floor(ms / 1000));
const tag = (q: { method: string; path: string; outcome?: unknown }) => `${q.method} ${q.path} ${String(q.outcome)}`;
const status = (r: ReturnType<typeof matrixRig>) => r.prisma._accounts.get(TENANT)!.status as string;

/** The real gateway budget over the real LiteLLM client over an HTTP fake. */
function gatewayFor(litellm: LiteLLMHttpFake, granted: string) {
  const gateway = createGatewayClient({ baseUrl: "http://litellm.test:4000", masterKey: "sk-master", fetchImpl: litellm.fetch });
  return createGatewayBudget({ gateway, usdPerCredit: RATE, grantedCreditsFor: async () => granted, teamIdFor: async () => SLUG });
}

// ── C16 ──────────────────────────────────────────────────────────────────────

describe("C16 Chargebee succeeds", () => {
  it("C16 normal billing: one capture POST whose amount = ClickHouse USD ÷ USD_PER_CREDIT; Chargebee debits exactly that", async () => {
    const r = matrixRig({ balance: "1000" });
    r.usage.add("t1:s1", T0 + 10_000, 0.0123).add("t1:s2", T0 + 20_000, 0.0456).add("t2:s1", T0 + 30_000, 0.00001);
    r.at(2);

    const result = await r.tick();

    // ClickHouse: 3 events, $0.05791  →  57.91 credits at 0.001
    expect(result).toMatchObject({ outcome: OUTCOME.SYNCED, amount: "57.91", billedUsd: "0.05791", events: 3 });
    expect(r.prisma._log).toHaveLength(1);
    const row = r.prisma._log[0]!;
    expect(row).toMatchObject({ status: SYNC.SUCCESS, amount: "57.91", billedUsd: "0.05791", eventCount: 3, attemptCount: 1, error: null });
    expect(row.settledAt).toBeInstanceOf(Date);

    // The wire: exactly one request, the capture, first send without a lookup.
    expect(r.cb.requests.map(tag)).toEqual(["POST /ledger_operations/capture 200"]);
    const post = r.cb.posts()[0]!;
    expect(post.auth).toBe(`Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}`);
    expect(post.contentType).toBe("application/x-www-form-urlencoded");
    expect(post.params).toMatchObject({
      id: row.id,
      subscription_id: "sub_1",
      unit_id: "token",
      amount: "57.91",
      ledger_operation_timestamp: sec(T0 + 2 * MINUTE),
    });
    expect(JSON.parse(post.params["metadata[json]"]!)).toEqual({
      tenant_slug: SLUG,
      ingested_from: new Date(T0).toISOString(),
      ingested_to: new Date(T0 + MINUTE).toISOString(),
      event_count: 3,
      billed_usd: "0.05791",
    });

    // Chargebee's ledger: one operation, under our id, for exactly the calculated amount.
    expect(r.cb.appliedCount).toBe(1);
    expect(r.cb.ops.get(row.id)).toMatchObject({
      type: "capture",
      amount: "57.9100000000",
      provisioned_start_balance: "1000.0000000000",
      provisioned_end_balance: "942.0900000000",
    });
    expect(r.cb.balanceStr).toBe("942.09");
    expect(r.prisma._cursor).toBe(T0 + MINUTE);
  });
});

// ── C17 ──────────────────────────────────────────────────────────────────────

describe("C17 Chargebee returns 500", () => {
  it("C17 HTTP 500 (not applied): row UNKNOWN, cursor held, no in-call re-POST; next cron GETs the same id (404) then POSTs it once", async () => {
    const r = matrixRig();
    r.usage.add("t1:s1", T0 + 30_000, 0.002);
    r.cb.captureFaults.push(F.s500());
    r.at(2);

    const first = await r.tick();

    expect(first.outcome).toBe(OUTCOME.UNKNOWN);
    const held = r.prisma._stuck!;
    expect(held).toMatchObject({ status: SYNC.UNKNOWN, attemptCount: 1 });
    expect(held.error).toBe("Sorry, Something went wrong when trying to process the request.");
    expect(r.cb.posts().map(tag)).toEqual(["POST /ledger_operations/capture 500"]); // a 5xx is NOT re-sent in-call
    expect(r.cb.appliedCount).toBe(0);
    expect(r.prisma._cursor).toBe(T0);
    expect(r.metrics(0, "error")).toContain("billing.sync.unknown_outcome");
    expect(retryDelayMs(SYNC.UNKNOWN, 1)).toBe(0); // due again on the very next tick

    const mark = r.cb.requests.length;
    r.at(3);
    const second = await r.tick();

    expect(r.cb.since(mark).map(tag)).toEqual([`GET /ledger_operations/${held.id} 404`, "POST /ledger_operations/capture 200"]);
    expect(second.outcome).toBe(OUTCOME.SYNCED);
    expect(r.cb.postsFor(held.id)).toHaveLength(2);
    // The retry carries a FRESH ledger timestamp (the API refuses one >10 min old).
    expect(r.cb.postsFor(held.id)[1]!.params.ledger_operation_timestamp).toBe(sec(T0 + 3 * MINUTE));
    expect(r.cb.appliedCount).toBe(1);
    expect(r.cb.balanceStr).toBe("998");
    expect(r.prisma._log).toHaveLength(1);
    expect(r.prisma._log[0]).toMatchObject({ id: held.id, status: SYNC.SUCCESS, attemptCount: 2 });
    expect(r.cursorMin()).toBe(2);
  });

  it("C17 HTTP 500 AFTER Chargebee applied the capture: next cron finds it by GET and settles REPLAYED with no second POST", async () => {
    const r = matrixRig();
    r.usage.add("t1:s1", T0 + 30_000, 0.002);
    r.cb.captureFaults.push(F.s500(true));
    r.at(2);

    expect((await r.tick()).outcome).toBe(OUTCOME.UNKNOWN);
    const held = r.prisma._stuck!;
    expect(r.cb.appliedCount).toBe(1); // the money DID move
    expect(r.prisma._cursor).toBe(T0);

    const mark = r.cb.requests.length;
    r.at(3);
    const second = await r.tick();

    expect(r.cb.since(mark).map(tag)).toEqual([
      `GET /ledger_operations/${held.id} 200`,
      "GET /ledger_account_balances 200", // a replay has no response body, so the balance is read (C45)
    ]);
    expect(second.outcome).toBe(OUTCOME.REPLAYED);
    expect(r.cb.postsFor(held.id)).toHaveLength(1);
    expect(r.cb.appliedCount).toBe(1);
    expect(r.cb.balanceStr).toBe("998");
    expect(r.prisma._log[0]).toMatchObject({ status: SYNC.SUCCESS });
    expect(r.cursorMin()).toBe(2);
  });
});

// ── C18 ──────────────────────────────────────────────────────────────────────

describe("C18 Chargebee returns 400", () => {
  it.each([
    { label: "400 invalid_request", fault: F.invalidRequest, metric: "billing.sync.no_ledger" },
    { label: "400 param_wrong_value", fault: F.paramWrongValue, metric: "billing.sync.invalid" },
    { label: "404 resource_not_found", fault: F.notFound, metric: "billing.sync.no_ledger" },
  ])("C18 $label on capture: INVALID ($metric, error level), cursor held, one POST, not exhausted, not retried next tick", async ({ fault, metric }) => {
    const r = matrixRig();
    r.usage.add("t1:s1", T0 + 30_000, 0.002);
    const f = fault() as Extract<Fault, { kind: "http" }>;
    r.cb.captureFaults.push(f);
    r.at(2);

    const result = await r.tick();

    expect(result.outcome).toBe(OUTCOME.INVALID);
    expect(r.prisma._stuck).toMatchObject({ status: SYNC.INVALID, attemptCount: 1, error: (f.body as { message: string }).message });
    expect(r.cb.posts()).toHaveLength(1); // a 4xx is never re-sent in-call
    expect(r.cb.appliedCount).toBe(0);
    expect(r.prisma._cursor).toBe(T0);
    expect(r.metrics(0, "error")).toContain(metric);
    expect(status(r)).toBe("active");
    expect(r.blocked).toEqual([]);

    // The next minute it is left alone: 5-minute floor.
    const mark = r.cb.requests.length;
    r.at(3);
    expect((await r.tick()).outcome).toBe(OUTCOME.HOLDING);
    expect(r.cb.since(mark)).toEqual([]);
  });

  it("C18 INVALID backs off 5→10→20→40→60 min, capped at one attempt per hour, every retry GET-first", async () => {
    const r = matrixRig();
    r.usage.add("t1:s1", T0 + 30_000, 0.002);
    r.cb.captureFaultAlways = F.paramWrongValue();

    const postMinutes: number[] = [];
    for (let m = 2; m <= 6 * 60; m += 1) {
      r.at(m);
      const before = r.cb.posts().length;
      await r.tick();
      if (r.cb.posts().length > before) postMinutes.push(m);
    }

    expect(postMinutes).toEqual([2, 7, 17, 37, 77, 137, 197, 257, 317]);
    expect([1, 2, 3, 4, 5, 6].map((a) => retryDelayMs(SYNC.INVALID, a) / MINUTE)).toEqual([5, 10, 20, 40, 60, 60]);
    const id = r.prisma._stuck!.id;
    // First send bare; every retry is GET /ledger_operations/{id} (404) then the POST.
    expect(r.cb.requests.map((q) => q.method)).toEqual(["POST", ...Array.from({ length: 8 }, () => ["GET", "POST"]).flat()]);
    expect(r.cb.lookupsFor(id)).toHaveLength(8);
    expect(r.prisma._stuck).toMatchObject({ status: SYNC.INVALID, attemptCount: 9 });
    expect(r.prisma._log).toHaveLength(1);
    expect(r.prisma._cursor).toBe(T0);
    expect(r.cb.appliedCount).toBe(0);
  });

  it("C18 'not forever' holds as a RATE bound only: after 48 h the row is still INVALID and still retried hourly, with no attempt ceiling or escalation", async () => {
    const r = matrixRig();
    r.usage.add("t1:s1", T0 + 30_000, 0.002);
    r.cb.captureFaultAlways = F.paramWrongValue();

    const postMinutes: number[] = [];
    for (let m = 2; m <= 2 + 48 * 60; m += 1) {
      r.at(m);
      const before = r.cb.posts().length;
      await r.tick();
      if (r.cb.posts().length > before) postMinutes.push(m);
    }

    const gaps = postMinutes.slice(1).map((m, i) => m - postMinutes[i]!);
    expect(Math.max(...gaps)).toBe(60); // never more than 1/hour once ramped
    expect(postMinutes).toHaveLength(51); // 2,7,17,37,77, then hourly to 48h
    expect(r.prisma._stuck).toMatchObject({ status: SYNC.INVALID, attemptCount: 51 });
    // Every attempt logs the SAME error metric: nothing escalates past maxAttempts (10) for INVALID.
    expect(new Set(r.metrics(0, "error"))).toEqual(new Set(["billing.sync.invalid"]));
    expect(r.metrics(0, "error")).toHaveLength(51);
    expect(r.cb.appliedCount).toBe(0);
  });

  it("C18 control: a tenant 8 days behind with NOTHING held raises billing.sync.behind", async () => {
    const r = matrixRig();
    r.at(8 * 24 * 60);
    await r.tick();
    expect(r.metrics(0, "error")).toContain("billing.sync.behind");
  });

  // FIXED (was DEFECT): runTenant returned the held result before processWindows(), and the
  // "cursor > 7 days behind" alarm lived only in processWindows — so while ANY unresolved row
  // held a tenant (the one situation in which the cursor stops moving) the alarm meant to
  // fire before ClickHouse's 90-day TTL could never fire. It is now raised on the held path too.
  it("C18 an INVALID row holding the tenant for 8 days still raises billing.sync.behind before the 90-day TTL", async () => {
    const r = matrixRig();
    r.usage.add("t1:s1", T0 + 30_000, 0.002);
    r.usage.add("t2:s1", T0 + 90_000, 0.002); // unread, behind the held window
    r.cb.captureFaultAlways = F.paramWrongValue();
    r.at(2);
    expect((await r.tick()).outcome).toBe(OUTCOME.INVALID);

    r.at(8 * 24 * 60);
    expect((await r.tick()).outcome).toBe(OUTCOME.INVALID); // retried (due), still refused
    expect(r.prisma._cursor).toBe(T0); // 8 days behind

    expect(r.metrics(0, "error")).toContain("billing.sync.behind");
  });

  it("C18 the alarm also fires while the held row is only backing off (HOLDING), not just when it is retried", async () => {
    const r = matrixRig();
    r.usage.add("t1:s1", T0 + 30_000, 0.002);
    r.cb.captureFaultAlways = F.paramWrongValue();
    r.at(2);
    await r.tick(); // INVALID, attempt 1
    r.at(8 * 24 * 60);
    await r.tick(); // retried: INVALID, attempt 2 — next due 10 minutes on

    const from = r.logs.length;
    r.at(8 * 24 * 60 + 1);
    expect((await r.tick()).outcome).toBe(OUTCOME.HOLDING);
    expect(r.metrics(from, "error")).toEqual(["billing.sync.behind"]);
    expect(r.cb.posts()).toHaveLength(2);
  });

  it("C18 a held tenant that is NOT behind raises no alarm", async () => {
    const r = matrixRig();
    r.usage.add("t1:s1", T0 + 30_000, 0.002);
    r.cb.captureFaultAlways = F.paramWrongValue();
    r.at(2);
    await r.tick();
    r.at(3);
    expect((await r.tick()).outcome).toBe(OUTCOME.HOLDING);
    expect(r.metrics(0, "error")).not.toContain("billing.sync.behind");
  });
});

// ── C19 ──────────────────────────────────────────────────────────────────────

describe("C19 Chargebee timeout", () => {
  it("C19 capture hangs past timeoutMs (not applied): aborted, UNKNOWN, one POST, loop stops; next tick GETs first (404) then POSTs once", async () => {
    const r = matrixRig({ timeoutMs: 25 });
    r.usage.add("t1:s1", T0 + 30_000, 0.002).add("t2:s1", T0 + 90_000, 0.003);
    r.cb.captureFaults.push(F.hang());
    r.at(3); // both windows due

    const started = Date.now();
    const first = await r.tick();
    const elapsed = Date.now() - started;

    expect(first.outcome).toBe(OUTCOME.UNKNOWN);
    expect(elapsed).toBeLessThan(2_000); // the 25 ms abort ended it, not a test timeout
    expect(r.cb.posts().map(tag)).toEqual(["POST /ledger_operations/capture aborted"]);
    expect(r.prisma._stuck!.error).toMatch(/^Chargebee \/ledger_operations\/capture unreachable: .*abort/i);
    expect(r.usage.reads).toHaveLength(1); // the second window was NOT read or charged this tick
    expect(r.cb.appliedCount).toBe(0);

    const id = r.prisma._stuck!.id;
    const mark = r.cb.requests.length;
    r.at(4);
    const second = await r.tick();

    expect(r.cb.since(mark).map(tag)).toEqual([
      `GET /ledger_operations/${id} 404`,
      "POST /ledger_operations/capture 200", // the held window, same id
      "POST /ledger_operations/capture 200", // then the next window, new id
    ]);
    expect(r.cb.since(mark)[1]!.params.id).toBe(id);
    expect(second.outcome).toBe(OUTCOME.SYNCED);
    expect(r.cb.appliedCount).toBe(2);
    expect(r.cb.taken).toBe("5");
    expect(r.billedRanges()).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it("C19 capture APPLIED but the response hangs until the timeout: next tick GET finds it → REPLAYED, POSTs stay at 1, debited once", async () => {
    const r = matrixRig({ timeoutMs: 25 });
    r.usage.add("t1:s1", T0 + 30_000, 0.002);
    r.cb.captureFaults.push(F.hang(true));
    r.at(2);

    expect((await r.tick()).outcome).toBe(OUTCOME.UNKNOWN);
    const id = r.prisma._stuck!.id;
    expect(r.cb.appliedCount).toBe(1);

    const mark = r.cb.requests.length;
    r.at(3);
    expect((await r.tick()).outcome).toBe(OUTCOME.REPLAYED);

    expect(r.cb.since(mark).map(tag)).toEqual([
      `GET /ledger_operations/${id} 200`,
      "GET /ledger_account_balances 200", // a replay has no response body, so the balance is read (C45)
    ]);
    expect(r.cb.postsFor(id)).toHaveLength(1);
    expect(r.cb.balanceStr).toBe("998");
    expect(r.prisma._log[0]).toMatchObject({ id, status: SYNC.SUCCESS });
  });

  it("C19 the recovery GET itself times out: stays UNKNOWN with zero POSTs (never sent blind); settles once the GET answers", async () => {
    const r = matrixRig({ timeoutMs: 25 });
    r.usage.add("t1:s1", T0 + 30_000, 0.002);
    r.cb.captureFaults.push(F.hang(true));
    r.at(2);
    await r.tick();
    const id = r.prisma._stuck!.id;

    r.cb.lookupFaults.push(F.hang(), F.hang(), F.hang()); // all 3 in-call GET attempts time out
    const mark = r.cb.requests.length;
    r.at(3);
    expect((await r.tick()).outcome).toBe(OUTCOME.UNKNOWN);
    expect(r.cb.since(mark).map(tag)).toEqual(Array(3).fill(`GET /ledger_operations/${id} aborted`));
    expect(r.cb.posts()).toHaveLength(1);

    r.at(4);
    expect((await r.tick()).outcome).toBe(OUTCOME.REPLAYED);
    expect(r.cb.postsFor(id)).toHaveLength(1);
    expect(r.cb.appliedCount).toBe(1);
  });

  // `topUp`: the refusal holds the tenant until credits come back, so the retry
  // needs activate() to take the account out of `exhausted` first.
  const KINDS: Array<{ label: string; faults: () => Fault[]; applied: boolean; tick1Posts: number; status: string; topUp?: boolean }> = [
    { label: "500 (not applied)", faults: () => [F.s500()], applied: false, tick1Posts: 1, status: SYNC.UNKNOWN },
    { label: "500 after apply", faults: () => [F.s500(true)], applied: true, tick1Posts: 1, status: SYNC.UNKNOWN },
    { label: "502 HTML body", faults: () => [F.s502html()], applied: false, tick1Posts: 1, status: SYNC.UNKNOWN },
    { label: "503", faults: () => [F.s503()], applied: false, tick1Posts: 1, status: SYNC.UNKNOWN },
    { label: "timeout (not applied)", faults: () => [F.hang()], applied: false, tick1Posts: 1, status: SYNC.UNKNOWN },
    { label: "timeout after apply", faults: () => [F.hang(true)], applied: true, tick1Posts: 1, status: SYNC.UNKNOWN },
    { label: "ECONNREFUSED", faults: () => [F.network()], applied: false, tick1Posts: 1, status: SYNC.UNKNOWN },
    { label: "socket drop after apply", faults: () => [F.network(true)], applied: true, tick1Posts: 1, status: SYNC.UNKNOWN },
    { label: "401 bad key", faults: () => [F.s401()], applied: false, tick1Posts: 1, status: SYNC.UNKNOWN },
    { label: "403 site blocked", faults: () => [F.s403()], applied: false, tick1Posts: 1, status: SYNC.UNKNOWN },
    { label: "429 x3", faults: () => [F.s429(), F.s429(), F.s429()], applied: false, tick1Posts: 3, status: SYNC.RATE_LIMITING },
    { label: "400 param_wrong_value", faults: () => [F.paramWrongValue()], applied: false, tick1Posts: 1, status: SYNC.INVALID },
    { label: "400 invalid_request", faults: () => [F.invalidRequest()], applied: false, tick1Posts: 1, status: SYNC.INVALID },
    { label: "400 ERROR_INSUFFICIENT_BALANCE", faults: () => [F.insufficient()], applied: false, tick1Posts: 1, status: SYNC.OUT_OF_CREDITS, topUp: true },
  ];

  it.each(KINDS)(
    "C19 every retry of a maybe-sent id GETs /ledger_operations/{id} before any POST — $label → $status",
    async ({ faults, applied, tick1Posts, status: expected, topUp }) => {
      const r = matrixRig({ timeoutMs: 25 });
      r.usage.add("t1:s1", T0 + 30_000, 0.002);
      r.cb.captureFaults.push(...faults());
      r.at(2);
      await r.tick();
      const row = r.prisma._stuck!;
      expect(row.status).toBe(expected);
      expect(r.cb.postsFor(row.id)).toHaveLength(tick1Posts);
      expect(r.cb.lookupsFor(row.id)).toHaveLength(0);
      expect(r.cb.appliedCount).toBe(applied ? 1 : 0);

      if (topUp) r.prisma._accounts.get(TENANT)!.status = "active";
      const mark = r.cb.requests.length;
      r.at(2 + 61); // past every backoff (RATE_LIMITING 1 min, INVALID 5 min)
      await r.tick();

      const retry = r.cb.since(mark);
      expect(tag(retry[0]!)).toBe(`GET /ledger_operations/${row.id} ${applied ? 200 : 404}`);
      expect(r.cb.postsFor(row.id)).toHaveLength(applied ? tick1Posts : tick1Posts + 1);
      expect(r.prisma._log[0]).toMatchObject({ id: row.id, status: SYNC.SUCCESS, attemptCount: 2 });
      expect(r.cb.appliedCount).toBe(1);
      expect(r.cb.balanceStr).toBe("998");
    },
  );
});

// ── C20 ──────────────────────────────────────────────────────────────────────

describe("C20 Chargebee succeeds but the response is lost", () => {
  it("C20 capture applied, connection drops before the response: UNKNOWN; next run GETs the op and settles REPLAYED — one operation, debited once", async () => {
    const r = matrixRig();
    r.usage.add("t1:s1", T0 + 30_000, 0.002);
    r.cb.captureFaults.push(F.network(true));
    r.at(2);

    const first = await r.tick();
    expect(first.outcome).toBe(OUTCOME.UNKNOWN);
    const id = r.prisma._stuck!.id;
    expect(r.prisma._stuck!.error).toBe("Chargebee /ledger_operations/capture unreachable: fetch failed");
    expect(r.cb.posts().map(tag)).toEqual(["POST /ledger_operations/capture network"]);
    expect(r.cb.appliedCount).toBe(1);
    expect(r.cb.balanceStr).toBe("998");
    expect(r.prisma._cursor).toBe(T0);

    const mark = r.cb.requests.length;
    r.at(3);
    const second = await r.tick();

    expect(second.outcome).toBe(OUTCOME.REPLAYED);
    expect(r.cb.since(mark).map(tag)).toEqual([
      `GET /ledger_operations/${id} 200`,
      "GET /ledger_account_balances 200", // a replay has no response body, so the balance is read (C45)
    ]);
    expect(r.cb.postsFor(id)).toHaveLength(1);
    expect([...r.cb.ops.keys()]).toEqual([id]);
    expect(r.cb.balanceStr).toBe("998");
    expect(r.prisma._log).toHaveLength(1);
    expect(r.prisma._log[0]).toMatchObject({ id, status: SYNC.SUCCESS, attemptCount: 2 });
    expect(r.cursorMin()).toBe(2);
  });

  it("C20 response lost AND the worker dies before recording it (row left PROCESSING): next run still GETs first — no duplicate", async () => {
    let killed = false;
    const r = matrixRig({
      prismaWrap: (p: any) =>
        new Proxy(p, {
          get(target: any, prop: string) {
            if (prop !== "chargebeeSync") return target[prop];
            return new Proxy(target.chargebeeSync, {
              get(s: any, key: string) {
                if (key !== "updateMany") return s[key];
                return async (args: any) => {
                  if (!killed && args.data?.status === SYNC.UNKNOWN) {
                    killed = true;
                    throw new Error("worker killed before the outcome was recorded");
                  }
                  return s.updateMany(args);
                };
              },
            });
          },
        }),
    });
    r.usage.add("t1:s1", T0 + 30_000, 0.002);
    r.cb.captureFaults.push(F.network(true));
    r.at(2);

    await expect(r.tick()).rejects.toThrow("worker killed before the outcome was recorded");
    const row = r.prisma._stuck!;
    expect(row.status).toBe(SYNC.PROCESSING);
    expect(r.cb.appliedCount).toBe(1);

    // PROCESSING is its sender's until the lease runs out (models/sync-status.ts):
    // a minute later nothing is asked or sent.
    r.at(3);
    expect((await r.tick()).outcome).toBe(OUTCOME.HOLDING);

    const mark = r.cb.requests.length;
    r.at(2 + PROCESSING_LEASE_MS / MINUTE);
    expect((await r.tick()).outcome).toBe(OUTCOME.REPLAYED);
    expect(r.cb.since(mark).map(tag)).toEqual([
      `GET /ledger_operations/${row.id} 200`,
      "GET /ledger_account_balances 200", // a replay has no response body, so the balance is read (C45)
    ]);
    expect(r.cb.postsFor(row.id)).toHaveLength(1);
    expect(r.cb.appliedCount).toBe(1);
    expect(r.cb.balanceStr).toBe("998");
  });
});

// ── C21 ──────────────────────────────────────────────────────────────────────

describe("C21 Chargebee unavailable", () => {
  it("C21 unreachable (ECONNREFUSED) for 30 min: first window UNKNOWN, nothing newer read, no POST during the outage; afterwards every held window billed exactly once", async () => {
    const r = matrixRig();
    for (let m = 0; m < 30; m += 1) r.usage.add(`t${m}:s1`, T0 + m * MINUTE + 30_000, 0.001);
    r.cb.outage = F.network();
    r.at(2);

    expect((await r.tick()).outcome).toBe(OUTCOME.UNKNOWN);
    const held = r.prisma._stuck!;
    const readsAfterFirst = r.usage.reads.length;
    for (let m = 3; m <= 31; m += 1) {
      r.at(m);
      expect((await r.tick()).outcome).toBe(OUTCOME.UNKNOWN);
    }

    expect(r.cb.posts()).toHaveLength(1); // only the original send
    expect(r.cb.lookupsFor(held.id)).toHaveLength(29 * 3); // 3 in-call GET attempts per tick, all refused
    expect(r.usage.reads.length).toBe(readsAfterFirst); // nothing newer was read
    expect(r.prisma._log).toHaveLength(1);
    expect(r.prisma._stuck).toMatchObject({ id: held.id, status: SYNC.UNKNOWN, attemptCount: 30 });
    expect(r.prisma._cursor).toBe(T0);
    expect(r.cb.appliedCount).toBe(0);
    // Escalation: attempts 1-9 log unknown_outcome, from maxAttempts (10) on the louder "stuck".
    const errs = r.metrics(0, "error");
    expect(errs.filter((m) => m === "billing.sync.unknown_outcome")).toHaveLength(9);
    expect(errs.filter((m) => m === "billing.sync.stuck")).toHaveLength(21);

    r.cb.outage = null;
    r.at(32);
    await r.tick(); // recovery + 20 windows (maxWindowsPerTick)
    r.at(33);
    await r.tick(); // the rest

    expect(r.cb.appliedCount).toBe(30);
    expect(r.cb.taken).toBe("30");
    expect(r.cb.balanceStr).toBe("970");
    expect(r.billedRanges()).toEqual(Array.from({ length: 30 }, (_, m) => [m, m + 1]));
    expect(r.cb.postsFor(held.id)).toHaveLength(2);
    for (const row of r.prisma._log.slice(1)) expect(r.cb.postsFor(row.id)).toHaveLength(1);
    // The recovery POST carried a fresh timestamp; the original was 30 min old.
    expect(r.cb.postsFor(held.id)[1]!.params.ledger_operation_timestamp).toBe(sec(T0 + 32 * MINUTE));
    expect(r.prisma._stuck).toBeUndefined();
    expect(r.cursorMin()).toBe(32);
  });

  it.each([
    { label: "403 request_blocked (site disabled)", fault: F.s403, metric: "billing.sync.site_disabled" },
    { label: "401 api_authentication_failed (bad key)", fault: F.s401, metric: "billing.sync.unauthenticated" },
  ])("C21 $label: UNKNOWN with $metric, one GET per tick (not retried in-call), no blind POST; billed after unblock", async ({ fault, metric }) => {
    const r = matrixRig();
    r.usage.add("t1:s1", T0 + 30_000, 0.002);
    r.cb.outage = fault();
    r.at(2);

    expect((await r.tick()).outcome).toBe(OUTCOME.UNKNOWN);
    const id = r.prisma._stuck!.id;
    for (const m of [3, 4, 5]) {
      r.at(m);
      expect((await r.tick()).outcome).toBe(OUTCOME.UNKNOWN);
    }
    expect(r.cb.posts()).toHaveLength(1);
    expect(r.cb.lookupsFor(id)).toHaveLength(3);
    expect(r.metrics(0, "error").filter((x) => x === metric)).toHaveLength(4);
    expect(r.prisma._cursor).toBe(T0);

    r.cb.outage = null;
    r.at(6);
    expect((await r.tick()).outcome).toBe(OUTCOME.SYNCED);
    expect(r.cb.appliedCount).toBe(1);
    expect(r.cb.balanceStr).toBe("998");
    expect(r.cursorMin()).toBe(5);
  });
});

// ── C28 ──────────────────────────────────────────────────────────────────────

describe("C28 zero-cost usage", () => {
  it("C28 zero-cost events: SUCCESS row (amount 0, events counted), NO request to Chargebee at all, cursor advances, never re-offered", async () => {
    const r = matrixRig();
    r.usage.add("t1:s1", T0 + 10_000, 0).add("t1:s2", T0 + 20_000, 0);
    r.at(2);

    const result = await r.tick();

    expect(result).toMatchObject({ outcome: OUTCOME.IDLE, reason: "no billable amount", amount: "0", events: 2 });
    expect(r.prisma._log).toHaveLength(1);
    expect(r.prisma._log[0]).toMatchObject({
      status: SYNC.SUCCESS,
      amount: "0",
      billedUsd: "0",
      eventCount: 2,
      attemptCount: 0,
      error: "no billable amount in this window",
    });
    expect(r.prisma._log[0]!.settledAt).toBeInstanceOf(Date);
    expect(r.cb.requests).toEqual([]);
    expect(r.cb.balanceStr).toBe("1000");
    expect(r.prisma._cursor).toBe(T0 + MINUTE);

    r.at(3);
    await r.tick();
    expect(r.prisma._log).toHaveLength(1);
    expect(r.cb.requests).toEqual([]);
  });

  it("C28 zero-cost events mixed with costed ones in one window: every event counted, only the costed amount captured", async () => {
    const r = matrixRig();
    r.usage.add("a", T0 + 5_000, 0).add("b", T0 + 10_000, 0.0005).add("c", T0 + 15_000, 0).add("d", T0 + 20_000, 0.0015);
    r.at(2);

    expect((await r.tick()).outcome).toBe(OUTCOME.SYNCED);
    expect(r.prisma._log[0]).toMatchObject({ status: SYNC.SUCCESS, eventCount: 4, amount: "2", billedUsd: "0.002" });
    expect(r.cb.posts()[0]!.params.amount).toBe("2");
    expect(JSON.parse(r.cb.posts()[0]!.params["metadata[json]"]!).event_count).toBe(4);
    expect(r.cb.balanceStr).toBe("998");
  });
});

// ── C29 ──────────────────────────────────────────────────────────────────────

describe("C29 large usage", () => {
  it("C29 $98,765.4321012345 in one window: wire amount 98765432.1012345 exactly (no exponent, <=10 dp), Chargebee debited exactly", async () => {
    const r = matrixRig({ balance: "1000000000" });
    r.usage.add("big:1", T0 + 30_000, 98765.4321012345);
    r.at(2);

    const result = await r.tick();

    expect(result).toMatchObject({ outcome: OUTCOME.SYNCED, amount: "98765432.1012345", billedUsd: "98765.4321012345" });
    const wire = r.cb.posts()[0]!.params.amount!;
    expect(wire).toBe("98765432.1012345");
    expect(wire).toMatch(/^\d+(\.\d{1,10})?$/);
    expect(r.cb.balanceStr).toBe(fxStr(fx("1000000000") - fx("98765432.1012345")));
    expect(r.cb.balanceStr).toBe("901234567.8987655");
  });

  it("C29 float64 cost from ClickHouse is converted without adding drift (0.1+0.2 → 300 credits, 0.25 → 250)", async () => {
    const r = matrixRig();
    r.usage.add("a", T0 + 10_000, 0.1).add("b", T0 + 20_000, 0.2);
    r.usage.add("c", T0 + MINUTE + 10_000, 0.25);
    r.at(3);

    await r.tick();

    expect(0.1 + 0.2).toBe(0.30000000000000004); // what ClickHouse's Float64 sum hands us
    expect(r.cb.posts().map((p) => p.params.amount)).toEqual(["300", "250"]);
    expect(r.cb.balanceStr).toBe("450");
  });

  it("C29 5,000 calls x $19.99 in one window: the charge equals ClickHouse's Float64 total exactly; that total carries 6.84e-9 USD of summation drift", async () => {
    const r = matrixRig({ balance: "1000000000" });
    for (let i = 0; i < 5000; i += 1) r.usage.add(`run:${i}`, T0 + 1 + (i % 59_000), 19.99);
    r.at(2);

    const result = await r.tick();
    const clickhouse = await r.usage.readWindow(SLUG, { fromMs: T0, toMs: T0 + MINUTE });

    expect(result.outcome).toBe(OUTCOME.SYNCED);
    expect(clickhouse).toEqual({ eventCount: 5000, billedUsd: 99950.00000000684 });
    // The service adds nothing of its own: amount == decimal(ClickHouse float) ÷ rate, exactly.
    expect(result.amount).toBe(usdToCredits(decimal(clickhouse.billedUsd), RATE));
    expect(result.amount).toBe("99950000.0000068");
    // Versus the exact decimal total (5000 x 19.99 = 99950): 6.8e-6 credits = 6.8e-9 USD over.
    // BY DESIGN (Float64 is ClickHouse's type for the cost, and LiteLLM's before it). The
    // 6.8e-9 is FakeUsageSource's JS left-to-right sum; live ClickHouse 26.3 sums the same
    // 5,000 values to 99949.9999999993 — 7e-10 UNDER. Unbiased, sub-cent, and not ours.
    expect(fxStr(fx(result.amount!) - fx("99950000"))).toBe("0.0000068");
    expect(fx(result.amount!) - fx("99950000")).toBeLessThan(fx("0.0001"));
    expect(r.cb.posts()).toHaveLength(1);
    expect(JSON.parse(r.cb.posts()[0]!.params["metadata[json]"]!).event_count).toBe(5000);
  });

  it("C29 precision floor: USD is quantised to 10 dp BEFORE ÷ 0.001, so credits carry 7 dp; per-window error ≤ 5e-11 USD", async () => {
    const r = matrixRig();
    r.usage.add("tiny", T0 + 30_000, 1.23456789012e-7);
    r.at(2);

    const result = await r.tick();

    expect(result).toMatchObject({ outcome: OUTCOME.SYNCED, billedUsd: "0.0000001235", amount: "0.0001235" });
    expect(r.cb.posts()[0]!.params.amount).toBe("0.0001235"); // plain decimal on the wire, no "1.235e-4"
    // Exact would be 0.000123456789012 credits; the difference is 4.3e-8 credits = 4.3e-11 USD.
    expect(fx("0.0001235") - fx("0.0001234568")).toBe(fx("0.0000000432"));
  });

  it("C29 the chargebee_sync.amount column (DECIMAL(20,10)) holds a $9,999,999.99 window exactly; a >$10M window cannot be written and holds the tenant — no charge, no skip", async () => {
    const r = matrixRig({ balance: "100000000000", prismaWrap: enforceDecimal20_10 });
    r.usage.add("a", T0 + 30_000, 9_999_999.99);
    r.at(2);
    const ok = await r.tick();
    expect(ok).toMatchObject({ outcome: OUTCOME.SYNCED, amount: "9999999990" });
    expect(r.cb.posts()[0]!.params.amount).toBe("9999999990");

    r.usage.add("b", T0 + MINUTE + 30_000, 10_000_000);
    r.at(3);
    await expect(r.tick()).rejects.toThrow(/numeric field overflow \(amount=10000000000\)/);
    expect(r.prisma._log).toHaveLength(1);
    expect(r.cb.posts()).toHaveLength(1);
    expect(r.cursorMin()).toBe(1);

    const summary = await r.sync.runOnce();
    expect(summary.errors).toEqual([{ tenantSlug: SLUG, error: expect.stringContaining("numeric field overflow") }]);
    expect(r.metrics(0, "error")).toContain("billing.sync.tenant_error");
    expect(r.cursorMin()).toBe(1);
  });

  it("C29 a ClickHouse read that times out on a heavy window leaves nothing half-done; the next tick bills the whole window once", async () => {
    const r = matrixRig();
    for (let i = 0; i < 2000; i += 1) r.usage.add(`h:${i}`, T0 + 1 + i * 20, 0.0001);
    r.usage.throwNext = Object.assign(new Error("Timeout exceeded: elapsed 20.001 seconds, maximum: 20"), { code: "159" });
    r.at(2);

    await expect(r.tick()).rejects.toThrow(/Timeout exceeded/);
    expect(r.prisma._log).toHaveLength(0);
    expect(r.cb.requests).toHaveLength(0);
    expect(r.prisma._cursor).toBe(T0);

    r.at(3);
    await r.tick();
    expect(r.prisma._log[0]).toMatchObject({ status: SYNC.SUCCESS, eventCount: 2000, amount: "200" });
    expect(r.cb.appliedCount).toBe(1);
    expect(r.cb.taken).toBe("200");
  });
});

// ── C30 ──────────────────────────────────────────────────────────────────────

describe("C30 many events in one minute", () => {
  /** Deterministic per-call costs, $0.000001 … $0.000999, as exact decimal strings. */
  const costOf = (i: number) => `0.000${String(1 + ((i * 7919) % 999)).padStart(3, "0")}`;

  it("C30 5,000 distinct calls (+500 re-sent duplicate spans) in one minute: one capture, event_count 5000, amount = ClickHouse total ÷ rate = exact decimal sum", async () => {
    const r = matrixRig({ balance: "1000000" });
    const costs: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      costs.push(costOf(i));
      r.usage.add(`trace${i}:span`, T0 + 1 + ((i * 11) % 59_999), Number(costOf(i)));
    }
    for (let i = 0; i < 500; i += 1) r.usage.add(`trace${i * 10}:span`, T0 + 59_999, Number(costOf(i * 10))); // re-sent copies
    r.at(2);

    const result = await r.tick();
    const clickhouse = await r.usage.readWindow(SLUG, { fromMs: T0, toMs: T0 + MINUTE });
    const exactUsd = add(...costs);

    expect(clickhouse.eventCount).toBe(5000);
    expect(exactUsd).toBe("2.500771");
    expect(result).toMatchObject({ outcome: OUTCOME.SYNCED, events: 5000, billedUsd: "2.500771", amount: "2500.771" });
    expect(result.amount).toBe(usdToCredits(decimal(clickhouse.billedUsd), RATE));
    expect(r.prisma._log).toHaveLength(1);
    expect(r.prisma._log[0]).toMatchObject({ eventCount: 5000, amount: "2500.771" });
    expect(r.cb.posts()).toHaveLength(1);
    const post = r.cb.posts()[0]!;
    expect(post.params.amount).toBe("2500.771");
    expect(JSON.parse(post.params["metadata[json]"]!)).toMatchObject({ event_count: 5000, billed_usd: "2.500771" });
    expect(r.cb.balanceStr).toBe("997499.229");
  });

  it("C30 3,000 calls over a 10-minute backlog: Σ event_count = 3000 and Σ Chargebee operations = Σ ClickHouse window totals ÷ rate = exact total", async () => {
    const r = matrixRig({ balance: "1000000" });
    const costs: string[] = [];
    for (let i = 0; i < 3000; i += 1) {
      costs.push(costOf(i));
      r.usage.add(`bk${i}:s`, T0 + 1 + i * 200, Number(costOf(i))); // 200 ms apart → 10 windows
    }
    r.at(11);

    await r.tick();

    const rows = r.prisma._log;
    expect(rows).toHaveLength(10);
    expect(rows.reduce((n: number, s: { eventCount: number }) => n + s.eventCount, 0)).toBe(3000);
    for (let w = 0; w < 10; w += 1) {
      const ch = await r.usage.readWindow(SLUG, { fromMs: T0 + w * MINUTE, toMs: T0 + (w + 1) * MINUTE });
      expect(rows[w]!.amount).toBe(usdToCredits(decimal(ch.billedUsd), RATE));
      expect(rows[w]!.eventCount).toBe(ch.eventCount);
      expect(fxStr(fx(String(r.cb.ops.get(rows[w]!.id)!.amount)))).toBe(rows[w]!.amount);
    }
    const exactCredits = usdToCredits(add(...costs), RATE);
    expect(r.cb.appliedCount).toBe(10);
    expect(r.cb.taken).toBe(add(...rows.map((s: { amount: string }) => s.amount)));
    expect(r.cb.taken).toBe(exactCredits);
    expect(r.cb.balanceStr).toBe(fxStr(fx("1000000") - fx(exactCredits)));
  });

  it("C30 the real ClickHouse adapter: window bounds as ms-precision params, one aggregate row, no LIMIT; a UInt64 count arriving as a string is parsed whole", async () => {
    const calls: any[] = [];
    const fakeClient = {
      query: async (args: any) => {
        calls.push(args);
        return { json: async () => [{ event_count: "5000", billed_usd: 2.500771 }] };
      },
    };
    const source = createUsageSource(fakeClient as never);

    const w = await source.readWindow(SLUG, { fromMs: T0 + 123, toMs: T0 + 123 + MINUTE });

    expect(w).toEqual({ eventCount: 5000, billedUsd: 2.500771 });
    expect(calls[0].format).toBe("JSONEachRow");
    expect(calls[0].query_params).toEqual({ span: "litellm_request", from: new Date(T0 + 123), to: new Date(T0 + 123 + MINUTE) });
    expect(calls[0].query).not.toMatch(/\bLIMIT\b/);
    expect(calls[0].query).toContain("GROUP BY event_key");
  });
});

// ── C44 ──────────────────────────────────────────────────────────────────────

describe("C44 credit deduction", () => {
  it("C44 known usage decreases the Chargebee balance by exactly the calculated credits; each operation's start−end = its amount = the sync row's amount", async () => {
    const r = matrixRig({ balance: "1000" });
    r.usage.add("w1:a", T0 + 30_000, 0.123456);
    r.usage.add("w2:a", T0 + MINUTE + 10_000, 0.000789).add("w2:b", T0 + MINUTE + 20_000, 0.0000011);
    r.at(2);
    await r.tick();
    r.at(3);
    await r.tick();

    const rows = r.prisma._log;
    expect(rows.map((s: { amount: string }) => s.amount)).toEqual(["123.456", "0.7901"]);
    for (const row of rows) {
      const op = r.cb.ops.get(row.id)!;
      const delta = fx(String(op.provisioned_start_balance)) - fx(String(op.provisioned_end_balance));
      expect(fxStr(delta)).toBe(row.amount);
      expect(fxStr(fx(String(op.amount)))).toBe(row.amount);
    }
    expect(r.cb.balanceStr).toBe("875.7539");
    expect(fxStr(fx("1000") - r.cb.balance)).toBe(add(...rows.map((s: { amount: string }) => s.amount)));
    // What the billing page would read back from Chargebee agrees.
    expect(await r.client.balance("sub_1")).toMatchObject({ unitId: "token", usable: "875.7539" });
  });
});

// ── C45 ──────────────────────────────────────────────────────────────────────

describe("C45 credit reaches zero", () => {
  it("C45 consuming exactly the whole balance leaves it at 0 (never negative); account exhausted; LiteLLM team blocked over HTTP; further usage refused, balance stays 0", async () => {
    const litellm = new LiteLLMHttpFake();
    const budget = gatewayFor(litellm, "250");
    const r = matrixRig({ balance: "250", blockBudget: (t, reason) => budget.block(t, reason) });
    await budget.push(TENANT); // activation: cap = 0 + 250 x 0.001
    expect(litellm.team).toMatchObject({ max_budget: 0.25, budget_duration: null, blocked: false });

    r.usage.add("t1:s1", T0 + 30_000, 0.25);
    r.at(2);
    const result = await r.tick();

    expect(result).toMatchObject({ outcome: OUTCOME.SYNCED, amount: "250" });
    const id = r.prisma._log[0]!.id;
    expect(r.cb.ops.get(id)).toMatchObject({ provisioned_start_balance: "250.0000000000", provisioned_end_balance: "0.0000000000" });
    expect(r.cb.balanceStr).toBe("0");
    expect(status(r)).toBe("exhausted");
    const update = litellm.requests.filter((q) => q.path === "/team/update").at(-1)!;
    expect(update.auth).toBe("Bearer sk-master");
    expect(update.body).toMatchObject({ team_id: SLUG, blocked: true, metadata: { [BLOCK_REASON]: "exhausted", [BILLING_MANAGED]: true } });
    expect(litellm.team.blocked).toBe(true);

    // Usage that was in flight before the block. Not sent at all while the
    // account is exhausted; the balance never goes below 0.
    r.usage.add("t2:s1", T0 + MINUTE + 30_000, 0.001);
    const mark = r.cb.requests.length;
    r.at(3);
    expect((await r.tick()).outcome).toBe(OUTCOME.EXHAUSTED);
    expect(r.cb.since(mark)).toEqual([]);
    expect(r.cb.balanceStr).toBe("0");
    expect(r.cb.appliedCount).toBe(1);
    expect(r.cursorMin()).toBe(1);
    for (const op of r.cb.ops.values()) expect(fx(String(op.provisioned_end_balance)) >= 0n).toBe(true);
  });

  it("C45 capped unit: a capture 0.0000001 credit above the balance is refused whole; the balance is not drawn down at all", async () => {
    const r = matrixRig({ balance: "250" });
    r.usage.add("t1:s1", T0 + 30_000, 0.2500000001); // 250.0000001 credits
    r.at(2);

    expect((await r.tick()).outcome).toBe(OUTCOME.OUT_OF_CREDITS);
    expect(r.cb.posts()[0]!.params.amount).toBe("250.0000001");
    expect(r.cb.balanceStr).toBe("250");
    expect(r.cb.appliedCount).toBe(0);
    expect(r.prisma._stuck).toMatchObject({ status: SYNC.OUT_OF_CREDITS, amount: "250.0000001" });
  });

  it("C45 overdraft unit (negative explicitly supported): the capture is accepted, the balance goes negative, and the account is exhausted + blocked", async () => {
    const r = matrixRig({ balance: "100" });
    r.cb.overdraft = true;
    r.usage.add("t1:s1", T0 + 30_000, 0.15);
    r.at(2);

    expect((await r.tick()).outcome).toBe(OUTCOME.SYNCED);
    expect(r.cb.balanceStr).toBe("-50");
    expect(status(r)).toBe("exhausted");
    expect(r.blocked).toEqual([{ tenantId: TENANT, reason: "exhausted" }]);
  });

  // NOT A DEFECT (was a suspected one; the test modelled a response the API does not send).
  // Chargebee's capture reference documents `ledger_account_balance` as ALWAYS returned by
  // POST /ledger_operations/capture, and that is where client.ts reads the post-capture balance
  // from. The body below — a ledger_operation and nothing else — is the GET
  // /ledger_operations/{id} shape, not the capture response. What is pinned is how the sync
  // behaves if a capture response ever did lack the balance: nothing is guessed from the
  // operation body, the draining capture leaves the account as it was, and the next capture's
  // refusal is what exhausts it — the bound account.service.ts accepts ("the minute until the
  // next capture tells us for certain").
  it("C45 a capture response without ledger_account_balance (not what the capture API returns) is not guessed from: the next refusal exhausts the account", async () => {
    const r = matrixRig({ balance: "250" });
    r.cb.captureShape = "operation-only";
    r.usage.add("t1:s1", T0 + 30_000, 0.25);
    r.at(2);

    expect((await r.tick()).outcome).toBe(OUTCOME.SYNCED);
    expect(r.cb.balanceStr).toBe("0");
    expect(r.cb.ops.get(r.prisma._log[0]!.id)!.provisioned_end_balance).toBe("0.0000000000");
    expect(status(r)).toBe("active"); // no balance in the response, so nothing concluded
    expect(r.blocked).toEqual([]);

    r.usage.add("t2:s1", T0 + 90_000, 0.001);
    r.at(3);
    expect((await r.tick()).outcome).toBe(OUTCOME.OUT_OF_CREDITS);
    expect(status(r)).toBe("exhausted");
    expect(r.blocked).toEqual([{ tenantId: TENANT, reason: "exhausted" }]);
    expect(r.cb.balanceStr).toBe("0"); // refused whole, never driven negative
  });

  // FIXED (was DEFECT): client.ts returned `balanceAfter: null` for a replay, so when the
  // capture that drained the balance was settled by recovery (lost response / timeout /
  // 500-after-apply), the drain-to-zero check was skipped and the account stayed `active`
  // until a LATER capture was refused. A replay now reads the usable balance.
  it("C45 drain-to-zero is detected when the draining capture is settled by replay after a lost response", async () => {
    const r = matrixRig({ balance: "250" });
    r.usage.add("t1:s1", T0 + 30_000, 0.25);
    r.cb.captureFaults.push(F.network(true));
    r.at(2);
    expect((await r.tick()).outcome).toBe(OUTCOME.UNKNOWN);
    r.at(3);
    expect((await r.tick()).outcome).toBe(OUTCOME.REPLAYED);
    expect(r.cb.balanceStr).toBe("0");

    expect(status(r)).toBe("exhausted");
    expect(r.blocked).toEqual([{ tenantId: TENANT, reason: "exhausted" }]);
  });
});

// ── C46 ──────────────────────────────────────────────────────────────────────

describe("C46 insufficient credits", () => {
  it("C46 usage > balance: refused whole (400 ERROR_INSUFFICIENT_BALANCE), OUT_OF_CREDITS, cursor held, balance untouched, exhausted + blockBudget('exhausted'); Chargebee not asked again while exhausted; a top-up bills it once, GET-first", async () => {
    const r = matrixRig({ balance: "100" });
    r.usage.add("t1:s1", T0 + 30_000, 0.15); // 150 credits > 100
    r.at(2);

    const result = await r.tick();

    expect(result).toMatchObject({ outcome: OUTCOME.OUT_OF_CREDITS, reason: SYNC.OUT_OF_CREDITS, amount: "150" });
    expect(r.cb.posts().map(tag)).toEqual(["POST /ledger_operations/capture 400"]);
    const held = r.prisma._stuck!;
    expect(held).toMatchObject({ status: SYNC.OUT_OF_CREDITS, error: "Not enough balance exists in the account.", amount: "150" });
    expect(r.cb.balanceStr).toBe("100"); // not partially drawn
    expect(r.cb.appliedCount).toBe(0);
    expect(r.prisma._cursor).toBe(T0);
    expect(status(r)).toBe("exhausted");
    expect(r.blocked).toEqual([{ tenantId: TENANT, reason: "exhausted" }]);
    expect(r.metrics(0, "error")).toContain("billing.sync.out_of_credits");
    // No timer: once credits are back the row is due at once.
    expect(retryDelayMs(SYNC.OUT_OF_CREDITS, 5)).toBe(0);

    // Usage keeps arriving behind it. For as long as the account is
    // exhausted — here, three hours of ticks — nothing newer is read and
    // Chargebee is not asked: it could only refuse again.
    r.usage.add("t2:s1", T0 + MINUTE + 30_000, 0.001);
    const reads = r.usage.reads.length;
    const mark = r.cb.requests.length;
    for (const m of [3, 4, 10, 65, 180]) {
      r.at(m);
      expect(await r.tick()).toMatchObject({ outcome: OUTCOME.EXHAUSTED, syncId: held.id });
    }
    expect(r.cb.since(mark)).toEqual([]);
    expect(r.usage.reads.length).toBe(reads);
    expect(r.prisma._stuck).toMatchObject({ id: held.id, status: SYNC.OUT_OF_CREDITS, attemptCount: 1 });
    expect(r.cb.balanceStr).toBe("100");

    // Top-up lands in Chargebee (+1000), and activate() takes the account out
    // of `exhausted`. No requeue: the next tick asks about the held window
    // first, bills it, then the next.
    r.cb.balance += fx("1000");
    r.prisma._accounts.get(TENANT)!.status = "active";
    const topUpMark = r.cb.requests.length;
    r.at(181);
    expect((await r.tick()).outcome).toBe(OUTCOME.SYNCED);
    expect(r.cb.since(topUpMark).map(tag).slice(0, 2)).toEqual([`GET /ledger_operations/${held.id} 404`, "POST /ledger_operations/capture 200"]);
    expect(r.cb.appliedCount).toBe(2);
    expect(r.cb.taken).toBe("151");
    expect(r.cb.balanceStr).toBe("949");
    expect(r.cb.postsFor(held.id).filter((p) => p.outcome === 200)).toHaveLength(1);
    expect(r.billedRanges()).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it("C46 the restriction reaches LiteLLM: cap = spend baseline + granted credits in USD, and an out-of-credits refusal sends /team/update {blocked: true, reason exhausted}", async () => {
    const litellm = new LiteLLMHttpFake();
    litellm.team.spend = 0.4; // free-plan spend before billing took the team over
    const budget = gatewayFor(litellm, "100");
    const r = matrixRig({ balance: "100", blockBudget: (t, reason) => budget.block(t, reason) });

    await budget.push(TENANT);
    expect(litellm.team).toMatchObject({
      max_budget: 0.5, // 0.4 baseline + 100 credits x $0.001
      budget_duration: null,
      metadata: { plan: "free", [BILLING_MANAGED]: true, [SPEND_BASELINE]: 0.4 },
    });

    r.usage.add("t1:s1", T0 + 30_000, 0.15);
    r.at(2);
    expect((await r.tick()).outcome).toBe(OUTCOME.OUT_OF_CREDITS);

    const updates = litellm.requests.filter((q) => q.method === "POST" && q.path === "/team/update");
    expect(updates.at(-1)!.body).toEqual({
      team_id: SLUG,
      blocked: true,
      metadata: { plan: "free", [BILLING_MANAGED]: true, [SPEND_BASELINE]: 0.4, [BLOCK_REASON]: "exhausted" },
    });
    expect(litellm.team.blocked).toBe(true);
    expect(litellm.team.max_budget).toBe(0.5); // the cap is left in place, the block is on top
  });

  it("C46 LiteLLM unreachable at the moment of refusal: block_failed is logged, the usage stays held, and the next tick blocks the team without asking Chargebee", async () => {
    const litellm = new LiteLLMHttpFake();
    const budget = gatewayFor(litellm, "100");
    const r = matrixRig({ balance: "100", blockBudget: (t, reason) => budget.block(t, reason) });
    await budget.push(TENANT);
    r.usage.add("t1:s1", T0 + 30_000, 0.15);

    litellm.down = true;
    r.at(2);
    expect((await r.tick()).outcome).toBe(OUTCOME.OUT_OF_CREDITS);
    expect(r.metrics(0, "error")).toContain("billing.budget.block_failed");
    expect(status(r)).toBe("exhausted");
    expect(litellm.team.blocked).toBe(false); // the gap the architecture doc admits (BILLING-ARCHITECTURE.md:546-550)

    litellm.down = false;
    const mark = r.cb.requests.length;
    r.at(3);
    // Held while exhausted, so Chargebee is not asked; the block is re-asserted every tick regardless.
    expect(await r.tick()).toMatchObject({ outcome: OUTCOME.EXHAUSTED });
    expect(r.cb.since(mark)).toEqual([]);
    expect(litellm.team).toMatchObject({ blocked: true, metadata: { [BLOCK_REASON]: "exhausted" } });
    expect(r.cb.balanceStr).toBe("100");
    expect(r.prisma._cursor).toBe(T0);

    // Once it is in place, re-asserting it is a read: no more /team/update.
    const writes = litellm.requests.filter((q) => q.path === "/team/update").length;
    for (const m of [4, 5, 6]) {
      r.at(m);
      expect((await r.tick()).outcome).toBe(OUTCOME.EXHAUSTED);
    }
    expect(litellm.requests.filter((q) => q.path === "/team/update")).toHaveLength(writes);
    expect(litellm.team.blocked).toBe(true);
  });
});
