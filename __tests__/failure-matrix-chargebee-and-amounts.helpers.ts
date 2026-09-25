/**
 * Helpers for failure-matrix-chargebee.test.ts.
 *
 * The existing harness fakes Chargebee at the CaptureResult level (FakeChargebee),
 * which skips the real client entirely: its HTTP handling, its timeout, its
 * in-call retry predicate, its error classification and the parsing of the
 * balance out of the response. This file fakes Chargebee at the HTTP level
 * instead, so the REAL `createChargebee({ fetchImpl })` is what the usage sync
 * talks to, and every fault is a real HTTP shape: a status plus Chargebee's JSON
 * error body, a request that never answers until the AbortController fires, or
 * a socket that drops (fetch rejects) — optionally AFTER the charge was applied.
 *
 * The ledger here keeps its own fixed-point arithmetic, deliberately NOT
 * src/models/decimal, so a bug in the product's decimal code cannot hide itself
 * by being reproduced inside the fake.
 */

import { createChargebee } from "@/integrations/chargebee";
import { createUsageSyncService } from "@/services/usage-sync.service";
import type { BlockReason } from "@/models/account-status";

import { FakeUsageSource, MINUTE, RATE, SLUG, T0, makeFakePrisma } from "./harness";

export const SITE = "matrix-test";
export const API_KEY = "matrix_key";
export const BASE = `https://${SITE}.chargebee.com/api/v2`;
/** One minute of lag and one-minute windows: the window at cursor C is due at C + 2 min. */
export const LAG = MINUTE;

// ── independent fixed-point (10 places) ─────────────────────────────────────

const SCALE = 10n ** 10n;

/** Parse a plain decimal string into 10-place fixed point. Throws on anything else (exponents included). */
export function fx(value: string): bigint {
  if (!/^-?\d+(\.\d{1,10})?$/.test(value)) throw new TypeError(`not a <=10dp decimal: ${JSON.stringify(value)}`);
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const v = BigInt(whole) * SCALE + BigInt(fraction.padEnd(10, "0"));
  return negative ? -v : v;
}

/** Render 10-place fixed point as a plain decimal string, trailing zeros trimmed. */
export function fxStr(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(10, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Chargebee renders ledger amounts with all ten places, e.g. "0.8594750000". */
function cbAmount(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? "-" : ""}${abs / SCALE}.${(abs % SCALE).toString().padStart(10, "0")}`;
}

// ── faults, as Chargebee (or the network) actually produces them ────────────

export type Fault =
  /** An HTTP answer. `apply` = Chargebee applied the capture before answering this. */
  | { kind: "http"; status: number; body: unknown; apply?: boolean; raw?: boolean }
  /** No answer at all until the client's AbortController fires. */
  | { kind: "hang"; apply?: boolean }
  /** The socket drops: fetch rejects with undici's `TypeError: fetch failed`. */
  | { kind: "network"; apply?: boolean };

const cbError = (status: number, api_error_code: string, message: string, extra: Record<string, unknown> = {}) => ({
  message,
  type: status >= 500 ? "internal_error" : "invalid_request",
  api_error_code,
  http_status_code: status,
  ...extra,
});

/** Canned faults. Bodies follow Chargebee's error envelope; the measured ones cite docs/src. */
export const F = {
  s500: (apply = false): Fault => ({
    kind: "http",
    status: 500,
    apply,
    body: cbError(500, "internal_error", "Sorry, Something went wrong when trying to process the request."),
  }),
  /** A load balancer's HTML 502 — no JSON at all. */
  s502html: (): Fault => ({ kind: "http", status: 502, raw: true, body: "<html><body>502 Bad Gateway</body></html>" }),
  s503: (): Fault => ({ kind: "http", status: 503, body: cbError(503, "internal_temporary_error", "Service temporarily unavailable") }),
  invalidRequest: (): Fault => ({
    kind: "http",
    status: 400,
    body: cbError(400, "invalid_request", "amount : invalid value", { param: "amount" }),
  }),
  paramWrongValue: (): Fault => ({
    kind: "http",
    status: 400,
    body: cbError(400, "param_wrong_value", "unit_id : Unit token does not exist", { param: "unit_id" }),
  }),
  notFound: (): Fault => ({
    kind: "http",
    status: 404,
    body: cbError(404, "resource_not_found", "Sorry, we couldn't find that resource"),
  }),
  /** MEASURED (errors.ts:67-76): HTTP 400, ERROR_INSUFFICIENT_BALANCE. */
  insufficient: (): Fault => ({
    kind: "http",
    status: 400,
    body: cbError(400, "ERROR_INSUFFICIENT_BALANCE", "Not enough balance exists in the account."),
  }),
  s429: (): Fault => ({
    kind: "http",
    status: 429,
    body: cbError(429, "api_request_limit_exceeded", "Sorry, access has been blocked temporarily due to request count exceeding acceptable limits."),
  }),
  /** MEASURED (errors.ts:90-91). */
  s401: (): Fault => ({
    kind: "http",
    status: 401,
    body: cbError(401, "api_authentication_failed", "Sorry, authentication failed. Invalid api key"),
  }),
  /** MEASURED 2026-09-22 (errors.ts:101-105): site disabled. */
  s403: (): Fault => ({
    kind: "http",
    status: 403,
    body: cbError(403, "request_blocked", "The site is not enabled", { error_code: "api_disabled" }),
  }),
  hang: (apply = false): Fault => ({ kind: "hang", apply }),
  network: (apply = false): Fault => ({ kind: "network", apply }),
};

export interface CbRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  atMs: number;
  auth: string | undefined;
  contentType: string | undefined;
  /** How this request ended: an HTTP status, "hang" (aborted) or "network". */
  outcome?: number | "aborted" | "network";
}

/**
 * Chargebee's prepaid ledger for ONE subscription, spoken over HTTP.
 *
 * `ops` is the real ledger: one entry per operation id that moved money.
 */
export class ChargebeeHttpFake {
  balance: bigint;
  /** Unlimited overdraft: a capture beyond the balance is accepted and the balance goes negative (errors.ts:74-75). */
  overdraft = false;
  /**
   * What a successful capture answers with.
   *
   * "operation+balance" also carries `ledger_account_balance.provisioned_balance.usable_balance`,
   * which is the ONLY place client.ts:763 reads a post-capture balance from.
   * "operation-only" is the MEASURED operation shape (docs/CHARGEBEE-API.md:274-283,
   * captured from GET /ledger_operations/{id}): the end balance is
   * `ledger_operation.provisioned_end_balance` and there is no account-balance object.
   */
  captureShape: "operation+balance" | "operation-only" = "operation+balance";
  ops = new Map<string, Record<string, unknown>>();
  requests: CbRequest[] = [];
  /** Consumed one per capture POST. */
  captureFaults: Fault[] = [];
  /** Consumed one per GET /ledger_operations/{id}. */
  lookupFaults: Fault[] = [];
  /** Applies to EVERY request while set — an outage or a blocked site. */
  outage: Fault | null = null;
  /** Applies to every capture POST while set (a persistently invalid request). */
  captureFaultAlways: Fault | null = null;
  private seq = 1789809062074128569n;

  constructor(
    balance: string,
    private readonly now: () => number,
    readonly subscriptionId = "sub_1",
    readonly unitId = "token",
  ) {
    this.balance = fx(balance);
  }

  get balanceStr() {
    return fxStr(this.balance);
  }

  get appliedCount() {
    return this.ops.size;
  }

  /** Total credits actually taken, exact. */
  get taken(): string {
    let t = 0n;
    for (const op of this.ops.values()) t += fx(String(op.amount).replace(/0+$/, "").replace(/\.$/, ""));
    return fxStr(t);
  }

  posts(): CbRequest[] {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/ledger_operations/capture");
  }

  postsFor(id: string): CbRequest[] {
    return this.posts().filter((r) => r.params.id === id);
  }

  lookupsFor(id: string): CbRequest[] {
    return this.requests.filter((r) => r.method === "GET" && r.path === `/ledger_operations/${id}`);
  }

  /** Requests recorded from index `from` on — "what did this tick send". */
  since(from: number): CbRequest[] {
    return this.requests.slice(from);
  }

  /** The fetch the real client is handed. */
  fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const params: Record<string, string> =
      method === "GET"
        ? Object.fromEntries(url.searchParams)
        : Object.fromEntries(new URLSearchParams(init?.body as URLSearchParams | string | undefined));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const req: CbRequest = {
      method,
      path,
      params,
      atMs: this.now(),
      auth: headers.Authorization,
      contentType: headers["Content-Type"],
    };
    this.requests.push(req);
    const signal = init?.signal ?? null;

    if (this.outage) return this.answer(req, this.outage, signal);

    if (method === "POST" && path === "/ledger_operations/capture") {
      const fault = this.captureFaults.shift() ?? this.captureFaultAlways;
      if (fault) {
        if (fault.apply) this.apply(params);
        return this.answer(req, fault, signal);
      }
      return this.captureResponse(req, params);
    }

    const opMatch = /^\/ledger_operations\/([^/]+)$/.exec(path);
    if (method === "GET" && opMatch) {
      const fault = this.lookupFaults.shift();
      if (fault) return this.answer(req, fault, signal);
      const op = this.ops.get(decodeURIComponent(opMatch[1]!));
      if (!op) return this.json(req, 404, cbError(404, "resource_not_found", `Sorry, we couldn't find that resource`));
      return this.json(req, 200, { ledger_operation: op });
    }

    if (method === "GET" && path === "/ledger_account_balances") {
      return this.json(req, 200, {
        list: [
          {
            ledger_account_balance: {
              subscription_id: this.subscriptionId,
              unit_id: this.unitId,
              provisioned_balance: { total_balance: cbAmount(this.balance), usable_balance: cbAmount(this.balance), hold_amount: cbAmount(0n) },
            },
          },
        ],
      });
    }

    return this.json(req, 404, cbError(404, "resource_not_found", `no fake route for ${method} ${path}`));
  }) as typeof fetch;

  /** Validate, and if valid move the money. Returns an error answer or null. */
  private apply(p: Record<string, string>): { status: number; body: unknown } | null {
    for (const key of ["id", "subscription_id", "unit_id", "amount", "ledger_operation_timestamp"]) {
      if (!p[key]) return { status: 400, body: cbError(400, "param_required", `${key} : cannot be blank`, { param: key }) };
    }
    if (p.subscription_id !== this.subscriptionId) {
      return { status: 404, body: cbError(404, "resource_not_found", "Sorry, we couldn't find that resource") };
    }
    let amount: bigint;
    try {
      amount = fx(p.amount!);
    } catch {
      return { status: 400, body: cbError(400, "param_wrong_value", "amount : invalid value", { param: "amount" }) };
    }
    if (amount <= 0n) return { status: 400, body: cbError(400, "param_wrong_value", "amount : must be greater than 0", { param: "amount" }) };
    // The API rejects a ledger timestamp older than ten minutes (client.ts:180-183).
    const ts = Number(p.ledger_operation_timestamp) * 1000;
    if (this.now() - ts > 10 * MINUTE) {
      return { status: 400, body: cbError(400, "invalid_request", "ledger_operation_timestamp : cannot be older than 10 minutes") };
    }
    if (this.ops.has(p.id!)) {
      // MEASURED on the live site (errors.ts DUPLICATE_CODES): a reused id is
      // refused, nothing is applied, and both code fields carry the same value.
      return {
        status: 400,
        body: {
          ...cbError(400, "ERROR_DUPLICATE_OPERATION_ID", "Duplicate operation id: one or more operationId values conflict."),
          error_code: "ERROR_DUPLICATE_OPERATION_ID",
        },
      };
    }
    if (!this.overdraft && amount > this.balance) {
      return { status: 400, body: cbError(400, "ERROR_INSUFFICIENT_BALANCE", "Not enough balance exists in the account.") };
    }
    const start = this.balance;
    this.balance -= amount;
    this.seq += 1n;
    this.ops.set(p.id!, {
      id: p.id,
      type: "capture",
      amount: cbAmount(amount),
      provisioned_start_balance: cbAmount(start),
      provisioned_end_balance: cbAmount(this.balance),
      subscription_id: p.subscription_id,
      unit_id: p.unit_id,
      sequence_number: this.seq.toString(),
      metadata: p["metadata[json]"] ? JSON.parse(p["metadata[json]"]) : undefined,
    });
    return null;
  }

  private captureResponse(req: CbRequest, p: Record<string, string>): Response {
    const refused = this.apply(p);
    if (refused) return this.json(req, refused.status, refused.body);
    const op = this.ops.get(p.id!)!;
    const body: Record<string, unknown> = { ledger_operation: op };
    if (this.captureShape === "operation+balance") {
      body.ledger_account_balance = {
        subscription_id: this.subscriptionId,
        unit_id: this.unitId,
        provisioned_balance: { usable_balance: cbAmount(this.balance) },
      };
    }
    return this.json(req, 200, body);
  }

  private json(req: CbRequest, status: number, body: unknown, raw = false): Response {
    req.outcome = status;
    return new Response(raw ? String(body) : JSON.stringify(body), {
      status,
      headers: { "content-type": raw ? "text/html" : "application/json;charset=utf-8" },
    });
  }

  private answer(req: CbRequest, fault: Fault, signal: AbortSignal | null): Promise<Response> | Response {
    if (fault.kind === "http") return this.json(req, fault.status, fault.body, fault.raw);
    if (fault.kind === "network") {
      req.outcome = "network";
      const cause = Object.assign(new Error(`connect ECONNREFUSED 34.0.0.1:443`), { code: "ECONNREFUSED" });
      return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause }));
    }
    // hang: never answers; only the client's AbortController ends it.
    return new Promise<Response>((_, reject) => {
      const onAbort = () => {
        req.outcome = "aborted";
        reject(signal?.reason ?? new DOMException("This operation was aborted", "AbortError"));
      };
      if (!signal) return; // would hang for ever — the client always passes one
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * LiteLLM's admin API for one team, spoken over HTTP — only the two calls
 * billing makes (/team/info, /team/update). Updates apply only the fields sent,
 * as LiteLLM does.
 */
export class LiteLLMHttpFake {
  team: Record<string, any> = {
    team_id: SLUG,
    spend: 0,
    max_budget: 5,
    budget_duration: "30d",
    blocked: false,
    metadata: { plan: "free" },
  };
  requests: Array<{ method: string; path: string; body?: Record<string, unknown>; auth?: string }> = [];
  /** Gateway unreachable: every call answers 503. */
  down = false;

  fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    this.requests.push({ method, path: url.pathname, body, auth: headers.Authorization });
    if (this.down) return new Response("{}", { status: 503 });

    if (method === "GET" && url.pathname === "/team/info") {
      if (url.searchParams.get("team_id") !== this.team.team_id) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ team_id: this.team.team_id, team_info: { ...this.team } }), { status: 200 });
    }
    if (method === "POST" && url.pathname === "/team/update") {
      for (const [k, v] of Object.entries(body ?? {})) if (k !== "team_id") this.team[k] = v;
      return new Response(JSON.stringify({ data: this.team }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

export interface LogEntry {
  level: "log" | "warn" | "error";
  obj: Record<string, any>;
  msg?: string;
}

/**
 * One tenant (sub_1 / unit "token", cursor at T0) driven by the REAL usage sync
 * over the REAL Chargebee client over ChargebeeHttpFake.
 */
export function matrixRig(
  opts: {
    balance?: string;
    timeoutMs?: number;
    maxWindowsPerTick?: number;
    blockBudget?: (tenantId: string, reason?: BlockReason) => Promise<void>;
    prismaWrap?: (prisma: any) => any;
  } = {},
) {
  const prisma = makeFakePrisma({}, T0);
  const usage = new FakeUsageSource();
  let now = T0;
  const cb = new ChargebeeHttpFake(opts.balance ?? "1000", () => now);
  const client = createChargebee({
    site: SITE,
    apiKey: API_KEY,
    fetchImpl: cb.fetch,
    timeoutMs: opts.timeoutMs ?? 50,
    maxAttempts: 3,
    sleep: async () => {},
  });
  const logs: LogEntry[] = [];
  const logger = {
    log: (obj: unknown, msg?: string) => void logs.push({ level: "log", obj: obj as Record<string, any>, msg }),
    warn: (obj: unknown, msg?: string) => void logs.push({ level: "warn", obj: obj as Record<string, any>, msg }),
    error: (obj: unknown, msg?: string) => void logs.push({ level: "error", obj: obj as Record<string, any>, msg }),
  };
  const blocked: Array<{ tenantId: string; reason?: string }> = [];

  const build = (overrides: Record<string, unknown> = {}) =>
    createUsageSyncService({
      prisma: (opts.prismaWrap ? opts.prismaWrap(prisma) : prisma) as never,
      usage,
      chargebee: client,
      usdPerCredit: RATE,
      lagMs: LAG,
      windowMs: MINUTE,
      ...(opts.maxWindowsPerTick ? { maxWindowsPerTick: opts.maxWindowsPerTick } : {}),
      clock: () => {
        prisma._now = now;
        return now;
      },
      logger,
      blockBudget: opts.blockBudget ?? (async (tenantId, reason) => void blocked.push({ tenantId, reason })),
      ...overrides,
    });
  const sync = build();

  return {
    prisma,
    usage,
    cb,
    client,
    sync,
    build,
    logs,
    blocked,
    /** Move every clock to T0 + m minutes. */
    at(m: number) {
      now = T0 + Math.round(m * MINUTE);
      usage.nowMs = now;
      prisma._now = now;
    },
    get now() {
      return now;
    },
    tick: () => sync.runTenant(SLUG),
    /** Metrics logged since log index `from`, optionally at one level. */
    metrics(from = 0, level?: LogEntry["level"]) {
      return logs
        .slice(from)
        .filter((l) => !level || l.level === level)
        .map((l) => l.obj.metric as string);
    },
    cursorMin: () => (prisma._cursor == null ? null : (prisma._cursor - T0) / MINUTE),
    /** Every [from,to) minute range a SUCCESS row covers. */
    billedRanges: (): Array<[number, number]> =>
      prisma._log
        .filter((s: { status: string }) => s.status === "SUCCESS")
        .map((s: { fromIngestedAt: Date; toIngestedAt: Date }) => [
          (s.fromIngestedAt.getTime() - T0) / MINUTE,
          (s.toIngestedAt.getTime() - T0) / MINUTE,
        ]),
  };
}

/**
 * Postgres' DECIMAL(20,10) on chargebee_sync.amount / billed_usd
 * (prisma/schema.prisma, migration 20260922130000): at most 10 integer digits.
 * FakePrisma does not enforce it; this wrapper does, raising what Prisma raises
 * for an out-of-range value (P2020).
 */
export function enforceDecimal20_10(prisma: any) {
  const fits = (v: unknown) => {
    if (v == null) return true;
    const [whole = "0"] = String(v).replace(/^-/, "").split(".");
    return whole.replace(/^0+/, "").length <= 10;
  };
  const check = (data: Record<string, unknown>) => {
    for (const col of ["amount", "billedUsd"]) {
      if (col in data && !fits(data[col])) {
        throw Object.assign(new Error(`Value out of range for the type. numeric field overflow (${col}=${String(data[col])})`), {
          code: "P2020",
        });
      }
    }
  };
  return new Proxy(prisma, {
    get(target: any, prop: string) {
      if (prop !== "chargebeeSync") return target[prop];
      return new Proxy(target.chargebeeSync, {
        get(sync: any, key: string) {
          if (key === "create") return async (args: any) => (check(args.data), sync.create(args));
          if (key === "update") return async (args: any) => (check(args.data), sync.update(args));
          return sync[key];
        },
      });
    },
  });
}
