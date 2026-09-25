/**
 * Helpers for failure-matrix-crash.test.ts — crash points, outages, gates and
 * an end-of-run audit, all layered over the doubles in ./harness.
 *
 * Nothing here changes how the harness behaves on its own. Each helper wraps a
 * fake so that ONE step can be made to fail (or to wait) at an exact point, and
 * the persisted stores (FakePrisma maps, FakeChargebee.applied) are left behind
 * for the next "process" — a fresh createUsageSyncService — to pick up.
 */

import { createChargebee } from "@/integrations/chargebee";
import type { ReadWindowArgs, UsageSource, UsageWindow } from "@/integrations/clickhouse/usage-source";
import { SYNC } from "@/models/sync-status";
import { createUsageSyncService, type UsageSyncDeps } from "@/services/usage-sync.service";

import { FakeChargebee, FakeUsageSource, MINUTE, RATE, T0, TENANT, makeFakePrisma } from "./harness";

export const LAG = MINUTE;

// ── logging ────────────────────────────────────────────────────────────────

export interface LogLine {
  level: "log" | "warn" | "error";
  metric?: string;
  msg?: string;
  [key: string]: unknown;
}

export function recordingLogger(lines: LogLine[]) {
  const push = (level: LogLine["level"]) => (obj: unknown, msg?: string) =>
    void lines.push({ level, ...((obj as Record<string, unknown>) ?? {}), msg });
  return { log: push("log"), warn: push("warn"), error: push("error") };
}

// ── the rig: one tenant, one set of persisted stores, many "processes" ─────

export type FakePrisma = ReturnType<typeof makeFakePrisma>;

export function rig(opts: { balance?: number; cursorAt?: number; account?: Record<string, unknown> } = {}) {
  const prisma: FakePrisma = makeFakePrisma(opts.account ?? {}, opts.cursorAt ?? T0);
  const usage = new FakeUsageSource();
  const chargebee = new FakeChargebee(opts.balance ?? 1000);
  const logs: LogLine[] = [];
  let now = T0;

  const clock = () => {
    prisma._now = now;
    return now;
  };

  /** A new worker process over the SAME persisted stores. Nothing in memory carries over. */
  const build = (overrides: Partial<UsageSyncDeps> = {}) =>
    createUsageSyncService({
      prisma: prisma as never,
      usage,
      chargebee,
      usdPerCredit: RATE,
      lagMs: LAG,
      windowMs: MINUTE,
      clock,
      logger: recordingLogger(logs),
      ...overrides,
    });

  return {
    prisma,
    usage,
    chargebee,
    logs,
    build,
    clock,
    /** Every clock to T0 + m minutes. With lag = 1 min, windows ending at ≤ T0 + (m-1) min are due. */
    at(m: number) {
      now = T0 + m * MINUTE;
      usage.nowMs = now;
      prisma._now = now;
    },
    cursorMin: (): number | null => (prisma._cursor == null ? null : (prisma._cursor - T0) / MINUTE),
    /** Every row as [fromMin, toMin, status], oldest window first. */
    rows: (): Array<[number, number, string]> =>
      prisma._log.map((s: SyncRow) => [
        (s.fromIngestedAt.getTime() - T0) / MINUTE,
        (s.toIngestedAt.getTime() - T0) / MINUTE,
        s.status,
      ]),
    /** How many capture POSTs carried this operation id (FakeChargebee records every send). */
    posts: (id: string) => chargebee.captures.filter((c) => c.id === id).length,
    metrics: () => logs.map((l) => l.metric).filter(Boolean) as string[],
  };
}

export type Rig = ReturnType<typeof rig>;

export interface SyncRow {
  id: string;
  tenantId: string;
  fromIngestedAt: Date;
  toIngestedAt: Date;
  status: string;
  amount: string;
  eventCount: number;
  attemptCount: number;
  settledAt: Date | null;
  hatchetRunId: string | null;
}

/**
 * The end-of-run audit. Returns every way the persisted state disagrees with
 * "each unit of usage below the cursor was charged exactly once".
 *
 *   - no two sync rows cover overlapping ranges
 *   - nothing is left unresolved
 *   - every operation Chargebee applied is a SUCCESS row, for that row's amount
 *   - every billable SUCCESS row was actually applied in Chargebee
 *   - every ClickHouse event at or below the cursor sits in exactly ONE SUCCESS row
 *   - Chargebee's total equals the credits of those events
 */
export function audit(r: { prisma: FakePrisma; usage: FakeUsageSource; chargebee: FakeChargebee }): string[] {
  const problems: string[] = [];
  const rows: SyncRow[] = r.prisma._log;
  const byFrom = [...rows].sort((a, b) => a.fromIngestedAt.getTime() - b.fromIngestedAt.getTime());
  const min = (t: Date | number) => ((t instanceof Date ? t.getTime() : t) - T0) / MINUTE;

  for (let i = 1; i < byFrom.length; i += 1) {
    const prev = byFrom[i - 1]!;
    const cur = byFrom[i]!;
    if (cur.fromIngestedAt.getTime() < prev.toIngestedAt.getTime()) {
      problems.push(
        `overlap: (${min(prev.fromIngestedAt)}, ${min(prev.toIngestedAt)}] and (${min(cur.fromIngestedAt)}, ${min(cur.toIngestedAt)}]`,
      );
    }
  }

  for (const row of rows) {
    if (row.status !== SYNC.SUCCESS) problems.push(`unresolved: ${row.id} ${row.status}`);
  }

  for (const [id, amount] of r.chargebee.applied) {
    const row = rows.find((s) => s.id === id);
    if (!row) problems.push(`applied op ${id} has no sync row`);
    else {
      if (row.status !== SYNC.SUCCESS) problems.push(`applied op ${id} is ${row.status}, not SUCCESS`);
      if (Number(row.amount) !== Number(amount)) problems.push(`applied op ${id} took ${amount}, row says ${row.amount}`);
    }
  }
  for (const row of rows) {
    if (row.status === SYNC.SUCCESS && Number(row.amount) > 0 && !r.chargebee.applied.has(row.id)) {
      problems.push(`SUCCESS row ${row.id} was never applied in Chargebee`);
    }
  }

  const cursor = r.prisma._cursor ?? T0;
  // One event per span, at its FIRST copy: what span_nodes FINAL returns (tenant migration 030).
  const first = new Map<string, (typeof r.usage.rows)[number]>();
  for (const e of r.usage.rows) {
    const kept = first.get(e.key);
    if (!kept || e.ingestedAtMs < kept.ingestedAtMs) first.set(e.key, e);
  }
  let expectedCredits = 0;
  for (const e of first.values()) {
    if (e.ingestedAtMs > cursor) continue;
    const covering = rows.filter(
      (s) =>
        s.status === SYNC.SUCCESS && e.ingestedAtMs > s.fromIngestedAt.getTime() && e.ingestedAtMs <= s.toIngestedAt.getTime(),
    );
    if (covering.length !== 1) problems.push(`event ${e.key} @${min(e.ingestedAtMs)}min covered by ${covering.length} settled rows`);
    expectedCredits += e.billedUsd / Number(RATE);
  }
  if (Math.abs(r.chargebee.taken - expectedCredits) > 1e-9) {
    problems.push(`Chargebee took ${r.chargebee.taken} credits; usage below the cursor is ${expectedCredits}`);
  }

  return problems;
}

// ── fault injection on the database ────────────────────────────────────────

type Model = "billingAccount" | "chargebeeSync";

export interface FaultSpec {
  model: Model;
  method: string;
  /** Only calls whose arguments match. */
  when?: (args: any) => boolean;
  /**
   * `before`: the statement never reaches Postgres (nothing is written).
   * `after`:  it commits, then the worker dies / the reply is lost.
   */
  mode: "before" | "after";
  times?: number;
  message?: string;
}

/**
 * The same FakePrisma, with chosen statements failing, and a switch that takes
 * the whole database away. Every call is also recorded, in order.
 */
export function faultyPrisma(prisma: FakePrisma, specs: FaultSpec[] = []) {
  const faults = specs.map((s) => ({ ...s, left: s.times ?? 1, fired: 0 }));
  const calls: string[] = [];
  /** Every statement this process sent, with its arguments, in order. */
  const statements: Array<{ name: string; args: any }> = [];
  const control = { down: false, calls, statements, faults };

  const wrapModel = (model: Model) =>
    new Proxy(prisma[model], {
      get(target: any, key: string) {
        const original = target[key];
        if (typeof original !== "function") return original;
        return async (args: any) => {
          calls.push(`${model}.${key}`);
          statements.push({ name: `${model}.${key}`, args });
          if (control.down) {
            throw Object.assign(new Error("Can't reach database server at `localhost:5432`"), { code: "P1001" });
          }
          const fault = faults.find((f) => f.model === model && f.method === key && f.left > 0 && (!f.when || f.when(args)));
          if (fault?.mode === "before") {
            fault.left -= 1;
            fault.fired += 1;
            throw new Error(fault.message ?? `injected: ${model}.${key} failed before commit`);
          }
          const out = await original.call(target, args);
          if (fault?.mode === "after") {
            fault.left -= 1;
            fault.fired += 1;
            throw new Error(fault.message ?? `injected: ${model}.${key} committed, then the worker died`);
          }
          return out;
        };
      },
    });

  const proxy = new Proxy(prisma, {
    get(target: any, key: string) {
      if (key === "billingAccount" || key === "chargebeeSync") return wrapModel(key);
      return target[key];
    },
  });

  return { prisma: proxy as FakePrisma, control };
}

/**
 * `where` of a cursor compare-and-set that MOVES the cursor — as opposed to
 * layCursorIfMissing's IS NULL, and to the compare-and-set of the cursor onto
 * itself that openWindow / advancePastEmptyWindow use to check and lock it.
 */
export const isCursorCas = (args: any) =>
  args?.where?.lastProcessedIngestedAt instanceof Date &&
  args?.data?.lastProcessedIngestedAt instanceof Date &&
  args.data.lastProcessedIngestedAt.getTime() !== args.where.lastProcessedIngestedAt.getTime();
export const toStatus = (status: string) => (args: any) => args?.data?.status === status;

// ── gates: make one step wait while something else runs ────────────────────

export class Gate {
  private release!: () => void;
  private arrive!: () => void;
  readonly opened: Promise<void>;
  /** Resolves once something is waiting at the gate. */
  readonly reached: Promise<void>;
  constructor() {
    this.opened = new Promise<void>((r) => (this.release = r));
    this.reached = new Promise<void>((r) => (this.arrive = r));
  }
  async pass() {
    this.arrive();
    await this.opened;
  }
  open() {
    this.release();
  }
}

type CbMethod = "capture" | "captureIdempotent";

/**
 * A worker's view of Chargebee where ONE chosen call is slow.
 *
 * `request`  — the POST has not reached Chargebee yet while it waits.
 * `response` — Chargebee applied it; only the answer is slow.
 */
export function slowChargebee(
  chargebee: FakeChargebee,
  gate: Gate,
  opts: { method?: CbMethod; phase: "request" | "response"; nth?: number },
) {
  let n = 0;
  const wrap = (method: CbMethod) => async (args: Parameters<FakeChargebee["capture"]>[0]) => {
    const selected = (!opts.method || opts.method === method) && (n += 1) === (opts.nth ?? 1);
    if (selected && opts.phase === "request") await gate.pass();
    const out = await chargebee[method](args);
    if (selected && opts.phase === "response") await gate.pass();
    return out;
  };
  return { capture: wrap("capture"), captureIdempotent: wrap("captureIdempotent") };
}

/** A worker's ClickHouse whose read returns, then the worker stalls before doing anything with it. */
export function stallAfterRead(usage: FakeUsageSource, gate: Gate, nth = 1): UsageSource {
  let n = 0;
  return {
    now: () => usage.now(),
    async readWindow(slug: string, a: ReadWindowArgs): Promise<UsageWindow> {
      const out = await usage.readWindow(slug, a);
      if ((n += 1) === nth) await gate.pass();
      return out;
    },
  };
}

// ── a whole-process kill switch, for repeated restarts ─────────────────────

/**
 * Wrap every external dependency of ONE worker process and kill it at step `k`
 * (prisma statements, ClickHouse calls and Chargebee calls all count). After
 * the kill every further call from that process throws too — a dead process
 * does nothing more, even if some caller swallowed the first error.
 */
export function killable(r: Rig, k: number | ((name: string, step: number) => boolean), mode: "before" | "after") {
  let step = 0;
  const state = { killed: false, killedAt: "" };
  const isTarget = (name: string) => (typeof k === "number" ? step === k : k(name, step));
  const hit = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    if (state.killed) throw new Error(`process already dead (${name})`);
    step += 1;
    const target = isTarget(name);
    if (target && mode === "before") {
      state.killed = true;
      state.killedAt = `before ${name}`;
      throw new Error(`killed before ${name}`);
    }
    const out = await run();
    if (target && mode === "after") {
      state.killed = true;
      state.killedAt = `after ${name}`;
      throw new Error(`killed after ${name}`);
    }
    return out;
  };

  const model = (m: Model) =>
    new Proxy(r.prisma[m], {
      get(target: any, key: string) {
        const original = target[key];
        if (typeof original !== "function") return original;
        return (args: any) => hit(`${m}.${key}`, () => original.call(target, args));
      },
    });
  const prisma = new Proxy(r.prisma, {
    get(target: any, key: string) {
      if (key === "billingAccount" || key === "chargebeeSync") return model(key);
      return target[key];
    },
  });
  const usage: UsageSource = {
    now: () => hit("clickhouse.now", () => r.usage.now()),
    readWindow: (slug, a) => hit("clickhouse.readWindow", () => r.usage.readWindow(slug, a)),
  };
  const chargebee = {
    capture: (a: Parameters<FakeChargebee["capture"]>[0]) => hit("chargebee.capture", () => r.chargebee.capture(a)),
    captureIdempotent: (a: Parameters<FakeChargebee["capture"]>[0]) =>
      hit("chargebee.captureIdempotent", () => r.chargebee.captureIdempotent(a)),
  };
  return { deps: { prisma: prisma as never, usage, chargebee }, state, steps: () => step };
}

/** A small deterministic PRNG, so a failing seed can be replayed. */
export function prng(seed: number) {
  // Scramble the seed and warm up: xorshift's first outputs from a small seed
  // are all near zero, which would make every "random" choice the same.
  let s = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  for (let i = 0; i < 16; i += 1) next();
  return next;
}

// ── a Chargebee HTTP simulator, for the REAL client ────────────────────────

/** The live site's answer to a capture whose id already exists, verbatim. */
export const DUPLICATE_OPERATION_ID = {
  message: "Duplicate operation id: one or more operationId values conflict.",
  type: "invalid_request",
  api_error_code: "ERROR_DUPLICATE_OPERATION_ID",
  error_code: "ERROR_DUPLICATE_OPERATION_ID",
  error_msg: "Duplicate operation id: one or more operationId values conflict.",
  http_status_code: 400,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Just enough of Chargebee's REST surface for the real client's capture and
 * lookup: POST /ledger_operations/capture and GET /ledger_operations/{id}.
 * Network faults are thrown the way fetch throws them.
 *
 * A POST reusing an id answers exactly what the live site answered when that
 * was measured (scratchpad dup_id_probe, 2026-09-24): HTTP 400 with
 * `api_error_code` and `error_code` both `ERROR_DUPLICATE_OPERATION_ID`, and
 * nothing applied.
 */
export class ChargebeeHttpSim {
  ops = new Map<string, { id: string; type: string; amount: string; subscription_id: string }>();
  posts: string[] = [];
  gets: string[] = [];
  balance = 1000;
  dropNextPost: "before" | "after" | null = null;
  /** Chargebee applies the next capture, but the gateway in front of it answers 504. */
  gatewayTimeoutAfterApply = false;
  lookupsDown = false;

  fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";

    if (method === "POST" && url.pathname.endsWith("/ledger_operations/capture")) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const id = body.get("id")!;
      this.posts.push(id);
      if (this.dropNextPost === "before") {
        this.dropNextPost = null;
        throw new TypeError("fetch failed: connect ECONNREFUSED (request never left)");
      }
      if (this.ops.has(id)) return json(400, DUPLICATE_OPERATION_ID);
      const amount = body.get("amount")!;
      this.ops.set(id, { id, type: "capture", amount, subscription_id: body.get("subscription_id")! });
      this.balance -= Number(amount);
      if (this.dropNextPost === "after") {
        this.dropNextPost = null;
        throw new TypeError("fetch failed: socket hang up (after Chargebee applied it)");
      }
      if (this.gatewayTimeoutAfterApply) {
        this.gatewayTimeoutAfterApply = false;
        return json(504, { message: "Gateway Timeout" });
      }
      return json(200, {
        ledger_operation: this.ops.get(id),
        ledger_account_balance: { provisioned_balance: { usable_balance: String(this.balance) } },
      });
    }

    const match = url.pathname.match(/\/ledger_operations\/([^/]+)$/);
    if (method === "GET" && match) {
      const id = decodeURIComponent(match[1]!);
      this.gets.push(id);
      if (this.lookupsDown) throw new TypeError("fetch failed: connect ETIMEDOUT");
      const op = this.ops.get(id);
      return op ? json(200, { ledger_operation: op }) : json(404, { api_error_code: "resource_not_found", message: `${id} not found` });
    }

    return json(404, { api_error_code: "resource_not_found", message: `unrouted ${method} ${url.pathname}` });
  }) as unknown as typeof fetch;

  client() {
    return createChargebee({ site: "sim", apiKey: "test_key", fetchImpl: this.fetch, maxAttempts: 3, sleep: async () => {} });
  }

  postsFor(id: string) {
    return this.posts.filter((p) => p === id).length;
  }
}

// ── the cursor watcher (C25) ──────────────────────────────────────────────

/**
 * Checks EVERY cursor compare-and-set before it runs: each ClickHouse event the
 * move would pass over must already sit in a SUCCESS row that Chargebee applied
 * (or a zero-amount row, which never goes to Chargebee). Anything else is the
 * cursor moving over usage that is not settled — the "advances too early" bug.
 */
export function watchCursor(r: Rig, base: FakePrisma = r.prisma) {
  const violations: string[] = [];
  const advances: Array<[number, number]> = [];
  const min = (ms: number) => (ms - T0) / MINUTE;
  const accounts = new Proxy(base.billingAccount, {
    get(target: any, key: string) {
      if (key !== "updateMany") return target[key];
      return async (args: any) => {
        if (isCursorCas(args)) {
          const from = args.where.lastProcessedIngestedAt.getTime();
          const to = args.data.lastProcessedIngestedAt.getTime();
          advances.push([min(from), min(to)]);
          for (const e of r.usage.rows) {
            if (!(e.ingestedAtMs > from && e.ingestedAtMs <= to)) continue;
            const row = (r.prisma._log as SyncRow[]).find(
              (s) => e.ingestedAtMs > s.fromIngestedAt.getTime() && e.ingestedAtMs <= s.toIngestedAt.getTime(),
            );
            const settled =
              row != null && row.status === SYNC.SUCCESS && (Number(row.amount) === 0 || r.chargebee.applied.has(row.id));
            if (!settled) {
              violations.push(`cursor ${min(from)}→${min(to)} passed ${e.key} while its row is ${row?.status ?? "missing"}`);
            }
          }
        }
        return target.updateMany(args);
      };
    },
  });
  const prisma = new Proxy(base, {
    get(target: any, key: string) {
      return key === "billingAccount" ? accounts : target[key];
    },
  });
  return { prisma: prisma as FakePrisma, violations, advances };
}

// ── random scheduling (C06) ────────────────────────────────────────────────

/**
 * One worker's dependencies, with a random number of scheduler yields around
 * every call — so two workers run under Promise.all interleave differently on
 * every seed. `patchLookup` also splits FakeChargebee's own lookup from its
 * send, which is the check-then-act gap inside captureIdempotent.
 */
export function jittered(r: Rig, rand: () => number) {
  const yields = async () => {
    const n = Math.floor(rand() * 5);
    for (let i = 0; i < n; i += 1) await Promise.resolve();
  };
  const around = async <T>(run: () => Promise<T>) => {
    await yields();
    const out = await run();
    await yields();
    return out;
  };
  const model = (m: Model) =>
    new Proxy(r.prisma[m], {
      get(target: any, key: string) {
        const original = target[key];
        if (typeof original !== "function") return original;
        return (args: any) => around(() => original.call(target, args));
      },
    });
  const prisma = new Proxy(r.prisma, {
    get(target: any, key: string) {
      if (key === "billingAccount" || key === "chargebeeSync") return model(key);
      return target[key];
    },
  });
  const usage: UsageSource = {
    now: () => around(() => r.usage.now()),
    readWindow: (slug, a) => around(() => r.usage.readWindow(slug, a)),
  };
  const chargebee = {
    capture: (a: Parameters<FakeChargebee["capture"]>[0]) => around(() => r.chargebee.capture(a)),
    captureIdempotent: (a: Parameters<FakeChargebee["capture"]>[0]) => around(() => r.chargebee.captureIdempotent(a)),
  };
  return { prisma: prisma as never, usage, chargebee };
}

export function patchLookup(r: Rig, rand: () => number) {
  const original = r.chargebee.findOperation.bind(r.chargebee);
  r.chargebee.findOperation = async (id: string) => {
    const out = await original(id);
    const n = Math.floor(rand() * 5);
    for (let i = 0; i < n; i += 1) await Promise.resolve();
    return out;
  };
}

/** Largest number of capture POSTs any single operation id received. */
export function maxPostsPerId(chargebee: FakeChargebee) {
  const counts = new Map<string, number>();
  for (const c of chargebee.captures) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

export { TENANT };
