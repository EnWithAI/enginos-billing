/**
 * In-memory doubles for the usage sync.
 *
 * The fake Prisma enforces the constraints the real table carries — the window
 * index, the strict window order, and SUCCESS ⟺ settled — because those
 * constraints, not any code path, are what stop two workers from covering one
 * range twice. A fake that ignored them would let every test pass while
 * production wrote a state Postgres would have refused.
 *
 * The fake Chargebee models the property the whole design rests on: an
 * operation id that already moved money does not move it again, and an id that
 * was never used answers 404. MEASURED on the live site (2026-09-24): a reused
 * id is refused with HTTP 400 `ERROR_DUPLICATE_OPERATION_ID` and nothing is
 * applied, which the real client confirms by lookup and reports as `replayed`
 * — the answer this fake gives directly. Tests that care how OFTEN an id was
 * sent count `captures`, because "money moved once" cannot tell.
 *
 * It also distinguishes `capture()` from `captureIdempotent()`, because the
 * sync now does: a row that has never been on the wire is sent directly, and
 * everything else asks first. A fake with only one of them could not catch a
 * change that started sending retries blind.
 *
 * DECIMAL COLUMNS COME BACK AS PRISMA'S OWN `Decimal`, exactly as the real
 * client returns them — not as the strings they were written as. It used to
 * hand back plain strings, and so it hid C44: Prisma's Decimal prints itself
 * as "5e-7" below 1e-6, the service stringified and re-parsed every row it
 * read, and a $0.0000005 window wedged its tenant in production while every
 * test passed. The test-only views (`_log`, `_syncs`, `_stuck`, `_topUps`)
 * still show the stored text.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  CAPTURE_INSUFFICIENT,
  CAPTURE_OK,
  CAPTURE_RATE_LIMITED,
  CAPTURE_REPLAYED,
  CAPTURE_RETRYABLE,
  type CaptureArgs,
  type CaptureResult,
} from "@/integrations/chargebee";
import type { ReadWindowArgs, UsageSource, UsageWindow } from "@/integrations/clickhouse/usage-source";
import { Prisma } from "../node_modules/.prisma/billing/index";

export const RATE = "0.001";
export const MINUTE = 60_000;
export const T0 = Date.UTC(2026, 8, 16, 12, 0, 0);
export const SLUG = "org_acme_com";
export const TENANT = "11111111-1111-4111-8111-111111111111";

class UniqueViolation extends Error {
  code = "P2002";
  constructor(index: string) {
    super(`Unique constraint failed: ${index}`);
  }
}

interface AccountRow {
  tenantId: string;
  routingSlug: string;
  chargebeeCustomerId?: string | null;
  chargebeeItemPriceId?: string | null;
  billingEmail?: string | null;
  currentTermStart?: Date | null;
  currentTermEnd?: Date | null;
  chargebeeSubscriptionId: string | null;
  ledgerUnitId: string | null;
  status: string;
  /** THE cursor. Null means billing has not started for this tenant. */
  lastProcessedIngestedAt: Date | null;
}

interface SyncRow {
  id: string;
  tenantId: string;
  chargebeeSubscriptionId: string | null;
  ledgerUnitId: string | null;
  fromIngestedAt: Date;
  toIngestedAt: Date;
  status: string;
  amount: string;
  billedUsd: string;
  eventCount: number;
  error: string | null;
  attemptCount: number;
  hatchetRunId: string | null;
  createdAt: Date;
  settledAt: Date | null;
  updatedAt: Date;
}

const STATUSES = ["PENDING", "PROCESSING", "SUCCESS", "UNKNOWN", "RATE_LIMITING", "OUT_OF_CREDITS", "INVALID", "WRITTEN_OFF"];
const UNRESOLVED_STATUSES = STATUSES.filter((s) => s !== "SUCCESS" && s !== "WRITTEN_OFF");

/**
 * The text a DECIMAL column holds for a value written to it: a string as
 * given, a Decimal in plain notation. Stored as text so the test views read
 * naturally; handed back to the code under test as a Decimal (`asDecimal`).
 */
function stored(value: unknown): string {
  if (value == null) return "0";
  if (typeof value === "object" && typeof (value as { toFixed?: unknown }).toFixed === "function") {
    return (value as { toFixed(): string }).toFixed();
  }
  return String(value);
}

/** What Prisma returns for a DECIMAL column: a Decimal, whose toString() goes exponential below 1e-6. */
function asDecimal(value: string): InstanceType<typeof Prisma.Decimal> {
  return new Prisma.Decimal(value);
}

/** A `chargebee_sync` row as the Prisma client returns it. */
function syncOut(row: SyncRow) {
  return { ...row, amount: asDecimal(row.amount), billedUsd: asDecimal(row.billedUsd) };
}

interface TopUpRow {
  id: string;
  tenantId: string;
  invoiceId: string;
  chargebeeSubscriptionId: string;
  ledgerUnitId: string;
  credits: string;
  expiresAt: Date | null;
  idempotencyKey: string | null;
  keyIssuedAt: Date | null;
  status: string;
  source: string;
  chargebeeRef: string | null;
  attemptCount: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  appliedAt: Date | null;
}

/**
 * `cursorAt` seeds the tenant's activation point, which every test that expects
 * billing to run needs — without it the sync sets one at now() and reads
 * nothing, exactly as production would for a tenant linked before this existed.
 */
export function makeFakePrisma(account: Partial<AccountRow> = {}, cursorAt?: number) {
  const accounts = new Map<string, AccountRow>();
  const syncs = new Map<string, SyncRow>();
  const topUps = new Map<string, TopUpRow>();

  /** `topup_grant`'s CHECKs and its unique index (migration 20260924190000). */
  function assertTopUpConstraints(row: TopUpRow) {
    if (!["SENDING", "PENDING", "APPLIED"].includes(row.status)) throw new Error(`topup_grant_status_check: ${row.status}`);
    if (!["allocation", "catalogue_grant"].includes(row.source)) throw new Error(`topup_grant_source_check: ${row.source}`);
    if (Number(row.credits) < 0 || row.attemptCount < 0) throw new Error("topup_grant_amounts_nonneg");
    if (row.source === "allocation" && (row.expiresAt == null || row.idempotencyKey == null || row.keyIssuedAt == null)) {
      throw new Error("topup_grant_allocation_request");
    }
    if (row.source === "catalogue_grant" && row.status !== "APPLIED") throw new Error("topup_grant_catalogue_applied");
    if ((row.status === "APPLIED") !== (row.appliedAt != null && row.chargebeeRef != null)) {
      throw new Error("topup_grant_applied_when_proven");
    }
    for (const other of topUps.values()) {
      if (other.id !== row.id && other.tenantId === row.tenantId && other.invoiceId === row.invoiceId) {
        throw new UniqueViolation("topup_grant_invoice_uq");
      }
    }
  }

  const topUpOut = (row: TopUpRow) => ({ ...row, credits: asDecimal(row.credits) });

  /**
   * Postgres's row lock on `billing_account`, which is the whole of what makes
   * openWindow and advancePastEmptyWindow safe against each other.
   *
   * An UPDATE inside a transaction locks each row it changes until the
   * transaction ends; any other UPDATE of that row — in a transaction or not —
   * waits for it, then re-checks its WHERE against the row as the holder left
   * it (READ COMMITTED). Modelled per account row. The transaction a statement
   * belongs to travels in AsyncLocalStorage, so the wrappers tests put around
   * the client (faults, gates, kill switches, jitter) keep working inside one.
   *
   * Plain reads take no lock, as in Postgres. Not modelled: isolation of
   * uncommitted writes and rollback. Neither matters to the transactions this
   * service runs — both open with a compare-and-set of the cursor ONTO ITSELF,
   * so nothing they write before a failure changes a value.
   */
  const txContext = new AsyncLocalStorage<number>();
  let nextTx = 0;
  const rowLocks = new Map<string, { tx: number; released: Promise<void> }>();
  const heldBy = new Map<number, Array<() => void>>();

  async function lockAccountRows(tenantIds: string[]) {
    const tx = txContext.getStore();
    for (const tenantId of tenantIds) {
      for (;;) {
        const lock = rowLocks.get(tenantId);
        if (!lock || lock.tx === tx) break;
        await lock.released;
      }
    }
    return tx;
  }

  function holdAccountRow(tx: number | undefined, tenantId: string) {
    if (tx == null || rowLocks.get(tenantId)?.tx === tx) return;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    rowLocks.set(tenantId, { tx, released });
    const held = heldBy.get(tx) ?? [];
    held.push(() => {
      rowLocks.delete(tenantId);
      release();
    });
    heldBy.set(tx, held);
  }

  /** The account rows an UPDATE could touch: by key when it names one, otherwise all of them. */
  function candidateTenantIds(where: Record<string, any>): string[] {
    if (typeof where.tenantId === "string") return [where.tenantId];
    return [...accounts.keys()];
  }

  accounts.set(TENANT, {
    tenantId: TENANT,
    routingSlug: SLUG,
    chargebeeSubscriptionId: "sub_1",
    ledgerUnitId: "token",
    status: "active",
    lastProcessedIngestedAt: cursorAt == null ? null : new Date(cursorAt),
    ...account,
  });

  /**
   * The table's CHECK constraints and its unique index.
   *
   * `chargebee_sync_window_uq` is the one that matters most: it is what stops
   * two workers, or a retry that opened a new row instead of re-using its own,
   * from covering the same window twice. It is a constraint rather than a lease
   * precisely because a lease is a value a caller can forget to check — and a
   * fake that skipped it would hide exactly that bug.
   */
  function assertSyncConstraints(row: SyncRow, previousId?: string) {
    if (!STATUSES.includes(row.status)) throw new Error(`chargebee_sync_status_check: ${row.status}`);
    if (row.toIngestedAt.getTime() <= row.fromIngestedAt.getTime()) {
      throw new Error("chargebee_sync_window_order");
    }
    if (Number(row.amount) < 0 || Number(row.billedUsd) < 0 || row.eventCount < 0 || row.attemptCount < 0) {
      throw new Error("chargebee_sync_amounts_nonneg");
    }
    if ((row.status === "SUCCESS") !== (row.settledAt != null)) {
      throw new Error("chargebee_sync_settled_when_success");
    }

    for (const other of syncs.values()) {
      if (other.id === row.id || other.id === previousId) continue;
      if (other.tenantId !== row.tenantId) continue;
      if (other.fromIngestedAt.getTime() === row.fromIngestedAt.getTime()) {
        throw new UniqueViolation("chargebee_sync_window_uq");
      }
    }
  }

  function applySyncData(row: SyncRow, data: Record<string, any>): SyncRow {
    const next = { ...row };
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in value) {
        (next as any)[key] = (next as any)[key] + (value as { increment: number }).increment;
      } else {
        (next as any)[key] = value;
      }
    }
    // `@updatedAt`, and the explicit stamp the claim writes. The backoff and
    // the PROCESSING lease read it, so it follows the TEST's clock: a fake that
    // left it frozen would make every retry look overdue.
    next.updatedAt = new Date(api._now ?? T0);
    return next;
  }

  const api: any = {
    billingAccount: {
      async findUnique({ where }: { where: Record<string, any> }) {
        for (const row of accounts.values()) {
          if (where.routingSlug && row.routingSlug === where.routingSlug) return { ...row };
          if (where.tenantId && row.tenantId === where.tenantId) return { ...row };
          if (where.chargebeeCustomerId && row.chargebeeCustomerId === where.chargebeeCustomerId) return { ...row };
        }
        return null;
      },
      async findMany({ where }: { where?: Record<string, any> } = {}) {
        return [...accounts.values()].filter((row) => matches(row, where ?? {})).map((r) => ({ ...r }));
      },
      async findFirst({ where }: { where?: Record<string, any> } = {}) {
        const row = [...accounts.values()].find((r) => matches(r, where ?? {}));
        return row ? { ...row } : null;
      },
      async upsert({ where, create, update }: { where: { tenantId: string }; create: Record<string, any>; update: Record<string, any> }) {
        const existing = accounts.get(where.tenantId);
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = {
          chargebeeSubscriptionId: null,
          ledgerUnitId: null,
          chargebeeCustomerId: null,
          lastProcessedIngestedAt: null,
          status: "unlinked",
          ...create,
        } as AccountRow;
        accounts.set(row.tenantId, row);
        return { ...row };
      },
      async update({ where, data }: { where: { tenantId: string }; data: Record<string, unknown> }) {
        const tx = await lockAccountRows([where.tenantId]);
        const row = accounts.get(where.tenantId)!;
        Object.assign(row, data);
        holdAccountRow(tx, where.tenantId);
        return { ...row };
      },
      async updateMany({ where, data }: { where: Record<string, any>; data: Record<string, any> }) {
        // Wait out any other transaction's lock, THEN evaluate the WHERE — the
        // re-check Postgres makes against the row the lock holder committed.
        const tx = await lockAccountRows(candidateTenantIds(where));
        let count = 0;
        for (const row of accounts.values()) {
          if (!matches(row as Record<string, any>, where)) continue;
          Object.assign(row, data);
          holdAccountRow(tx, row.tenantId);
          count += 1;
        }
        return { count };
      },
    },

    /** Mirrors `chargebee_sync`. */
    chargebeeSync: {
      async create({ data }: { data: Record<string, any> }) {
        const row: SyncRow = {
          id: data.id ?? randomUUID(),
          eventCount: 0,
          attemptCount: 0,
          error: null,
          hatchetRunId: null,
          settledAt: null,
          createdAt: new Date(T0),
          updatedAt: new Date(T0),
          ...data,
          amount: stored(data.amount),
          billedUsd: stored(data.billedUsd),
        } as SyncRow;
        assertSyncConstraints(row);
        syncs.set(row.id, row);
        return syncOut(row);
      },
      async findFirst({ where, orderBy }: { where: Record<string, any>; orderBy?: any; select?: unknown }) {
        let rows = [...syncs.values()].filter((r) => matches(r, where));
        const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
        for (const o of [...orders].reverse()) {
          const [field, dir] = Object.entries(o)[0] as [keyof SyncRow, string];
          rows = rows.sort((a, b) => {
            const av = a[field] as any;
            const bv = b[field] as any;
            const an = av instanceof Date ? av.getTime() : av;
            const bn = bv instanceof Date ? bv.getTime() : bv;
            const cmp = an === bn ? 0 : an == null ? -1 : bn == null ? 1 : an < bn ? -1 : 1;
            return dir === "desc" ? -cmp : cmp;
          });
        }
        return rows[0] ? syncOut(rows[0]) : null;
      },
      async findMany({ where, distinct }: { where?: Record<string, any>; distinct?: string[]; select?: unknown } = {}) {
        let rows = [...syncs.values()].filter((r) => matches(r, where ?? {}));
        if (distinct?.includes("tenantId")) {
          const seen = new Set<string>();
          rows = rows.filter((r) => (seen.has(r.tenantId) ? false : (seen.add(r.tenantId), true)));
        }
        return rows.map(syncOut);
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, any> }) {
        const row = syncs.get(where.id)!;
        const next = applySyncData(row, data);
        assertSyncConstraints(next, where.id);
        syncs.set(where.id, next);
        return syncOut(next);
      },
      /**
       * The compare-and-set form every status write now uses: the row changes
       * only if it still matches `where`, and `count` says whether it did. All
       * of it happens in one turn of the event loop, as one UPDATE is atomic.
       */
      async updateMany({ where, data }: { where: Record<string, any>; data: Record<string, any> }) {
        let count = 0;
        for (const row of [...syncs.values()]) {
          if (!matches(row as unknown as Record<string, any>, where)) continue;
          const next = applySyncData(row, data);
          assertSyncConstraints(next, row.id);
          syncs.set(row.id, next);
          count += 1;
        }
        return { count };
      },
      async count({ where }: { where?: Record<string, any> } = {}) {
        return [...syncs.values()].filter((r) => matches(r, where ?? {})).length;
      },
    },

    /** Mirrors `topup_grant`: its CHECKs and `topup_grant_invoice_uq`. */
    topUpGrant: {
      async create({ data }: { data: Record<string, any> }) {
        const at = new Date(api._now ?? T0);
        const row: TopUpRow = {
          id: data.id ?? randomUUID(),
          expiresAt: null,
          idempotencyKey: null,
          keyIssuedAt: null,
          chargebeeRef: null,
          attemptCount: 0,
          error: null,
          appliedAt: null,
          createdAt: at,
          updatedAt: at,
          ...data,
          credits: stored(data.credits),
        } as TopUpRow;
        assertTopUpConstraints(row);
        topUps.set(row.id, row);
        return topUpOut(row);
      },
      async findFirst({ where }: { where: Record<string, any> }) {
        const row = [...topUps.values()].find((r) => matches(r as unknown as Record<string, any>, where));
        return row ? topUpOut(row) : null;
      },
      async findMany({ where }: { where?: Record<string, any> } = {}) {
        return [...topUps.values()].filter((r) => matches(r as unknown as Record<string, any>, where ?? {})).map(topUpOut);
      },
      /** Compare-and-set, atomic as one UPDATE is. `updatedAt` follows the test clock unless the write names it. */
      async updateMany({ where, data }: { where: Record<string, any>; data: Record<string, any> }) {
        let count = 0;
        for (const row of [...topUps.values()]) {
          if (!matches(row as unknown as Record<string, any>, where)) continue;
          const next: TopUpRow = { ...row, updatedAt: new Date(api._now ?? T0), ...data };
          if ("credits" in data) next.credits = stored(data.credits);
          assertTopUpConstraints(next);
          topUps.set(row.id, next);
          count += 1;
        }
        return { count };
      },
    },

    /**
     * Runs the callback against the same store, holding every account row it
     * updates until it ends (see the row lock above). It is handed `this`, so a
     * test that wrapped the client (a fault, a gate, a kill switch) sees the
     * statements made inside the transaction too, exactly as it sees every
     * other statement.
     */
    async $transaction<T>(this: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = (nextTx += 1);
      try {
        return await txContext.run(tx, () => fn(this ?? api));
      } finally {
        for (const release of heldBy.get(tx) ?? []) release();
        heldBy.delete(tx);
      }
    },

    /** Test-only: is some transaction holding this account row right now? */
    _rowLocked(tenantId: string = TENANT): boolean {
      return rowLocks.has(tenantId);
    },

    /** Test-only: what the fake's `@updatedAt` should stamp. Tests that exercise backoff set it. */
    _now: T0,

    /** Test-only views. */
    _accounts: accounts,
    _syncs: syncs,
    _topUps: topUps,
    /** Every sync for the default tenant, oldest window first. */
    get _log() {
      return [...syncs.values()]
        .filter((s) => s.tenantId === TENANT)
        .sort((a, b) => a.fromIngestedAt.getTime() - b.fromIngestedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
    },
    /** Where billing has reached, in epoch ms. Null before activation. */
    get _cursor(): number | null {
      const at = accounts.get(TENANT)?.lastProcessedIngestedAt;
      return at ? at.getTime() : null;
    },
    /** The sync holding the tenant, if any. */
    get _stuck() {
      return [...syncs.values()].find((s) => s.tenantId === TENANT && UNRESOLVED_STATUSES.includes(s.status));
    },
  };

  return api;
}

function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Array<Record<string, any>>).some((c) => matches(row, c));
    if (condition === null) return row[key] == null;
    if (condition instanceof Date) return row[key] instanceof Date && row[key].getTime() === condition.getTime();
    if (condition && typeof condition === "object" && "in" in condition) {
      return (condition.in as unknown[]).includes(row[key]);
    }
    if (condition && typeof condition === "object" && "not" in condition) {
      return condition.not === null ? row[key] != null : row[key] !== condition.not;
    }
    if (condition && typeof condition === "object" && "lt" in condition) {
      const left = row[key];
      const right = condition.lt;
      if (left == null) return false;
      return left instanceof Date && right instanceof Date ? left.getTime() < right.getTime() : left < right;
    }
    if (condition && typeof condition === "object" && "startsWith" in condition) {
      return typeof row[key] === "string" && row[key].startsWith(condition.startsWith);
    }
    if (typeof condition === "number") return Number(row[key]) === condition;
    return row[key] === condition;
  });
}

/**
 * Chargebee's prepaid ledger, as far as the sync can tell.
 *
 * `applied` is the real ledger: one entry per operation id that moved money.
 * Everything a test asserts about double-charging reduces to its size.
 */
export class FakeChargebee {
  balance: number;
  applied = new Map<string, string>();
  captures: Array<{ id: string; amount: string }> = [];
  lookups: string[] = [];
  failNext: CaptureResult | null = null;
  /** Refuse every capture for want of credits, until credits are added. */
  insufficient = false;
  /** Throttle the next call — refused before it is applied. */
  rateLimitNext = false;
  /** The charge lands, but the response never arrives (network timeout). */
  loseResponseNext = false;
  /** The worker dies mid-call: before the charge, or after it landed. */
  crashNext: "before" | "after" | null = null;
  /**
   * Die once this many captures have landed — a crash INSIDE the multi-window
   * loop, where "how far the worker got" and "what Chargebee took" can most
   * easily come apart.
   */
  crashAfterCaptures: number | null = null;
  /** The recovery lookup itself cannot be made. */
  lookupThrowsNext: Error | null = null;

  constructor(balance = 1000) {
    this.balance = balance;
  }

  fail(result: CaptureResult) {
    this.failNext = result;
    return this;
  }

  /**
   * Send without asking. The sync uses this ONLY for an id that has never been
   * on the wire, so a test that sees a lookup-free send of a retried id has
   * caught a real regression.
   */
  async capture(args: CaptureArgs): Promise<CaptureResult> {
    return this.send(args);
  }

  /**
   * Lookup FIRST, exactly as the real client does — that ordering is the whole
   * recovery story, so a fake that skipped it would let a test pass while
   * production re-sent a charge that had already landed.
   */
  async captureIdempotent(args: CaptureArgs): Promise<CaptureResult> {
    try {
      const existing = await this.findOperation(args.id);
      if (existing) return { kind: CAPTURE_REPLAYED, operationId: existing.id, balanceAfter: String(this.balance) };
    } catch (err) {
      const e = err as Error & { status?: number; retryable?: boolean };
      // Throttled first: the lookup was refused, so nothing was learnt AND
      // nothing was sent — a wait, not an unknown.
      if (e.status === 429) return { kind: CAPTURE_RATE_LIMITED, error: e };
      // "We could not find out" — never a capture sent blind.
      return { kind: CAPTURE_RETRYABLE, error: e };
    }
    return this.send(args);
  }

  private async send(args: CaptureArgs): Promise<CaptureResult> {
    this.captures.push({ id: args.id, amount: args.amount });

    if (this.crashNext === "before") {
      this.crashNext = null;
      throw new Error("worker killed before the capture");
    }
    if (this.rateLimitNext) {
      this.rateLimitNext = false;
      // Refused BEFORE it was applied: nothing is added to `applied`, which is
      // what makes re-sending it later safe rather than a second charge.
      return {
        kind: CAPTURE_RATE_LIMITED,
        error: Object.assign(new Error("Too many requests"), { status: 429, retryable: true }),
      };
    }
    if (this.failNext) {
      const result = this.failNext;
      this.failNext = null;
      return result;
    }

    // Belt and braces: even reached directly, a replayed id is acknowledged
    // rather than re-debited.
    if (this.applied.has(args.id)) {
      return { kind: CAPTURE_REPLAYED, operationId: args.id, balanceAfter: String(this.balance) };
    }

    if (this.insufficient || Number(args.amount) > this.balance) {
      return {
        kind: CAPTURE_INSUFFICIENT,
        error: Object.assign(new Error("Not enough balance exists in the account."), {
          status: 400,
          apiErrorCode: "ERROR_INSUFFICIENT_BALANCE",
        }),
      };
    }

    this.applied.set(args.id, args.amount);
    this.balance -= Number(args.amount);

    if (this.crashAfterCaptures != null && this.applied.size >= this.crashAfterCaptures) {
      this.crashAfterCaptures = null;
      throw new Error(`worker killed after capture ${this.applied.size} landed`);
    }
    if (this.crashNext === "after") {
      this.crashNext = null;
      throw new Error("worker killed after the capture landed");
    }
    if (this.loseResponseNext) {
      this.loseResponseNext = false;
      return { kind: CAPTURE_RETRYABLE, error: Object.assign(new Error("Chargebee timeout"), { retryable: true }) };
    }
    return { kind: CAPTURE_OK, operationId: args.id, balanceAfter: String(this.balance) };
  }

  /** `GET /ledger_operations/{id}`: the operation, or null for a 404. */
  async findOperation(id: string): Promise<{ id: string } | null> {
    this.lookups.push(id);
    if (this.lookupThrowsNext) {
      const err = this.lookupThrowsNext;
      this.lookupThrowsNext = null;
      throw err;
    }
    return this.applied.has(id) ? { id } : null;
  }

  /** How many times money actually moved. The assertion that matters most. */
  get appliedCount() {
    return this.applied.size;
  }

  /** Total credits actually taken. */
  get taken() {
    return [...this.applied.values()].reduce((s, a) => s + Number(a), 0);
  }
}

/**
 * ClickHouse span_nodes as the usage sync sees it: one aggregate per window.
 *
 * Deduplication happens HERE, as it does in the real query's GROUP BY — adding
 * the same TraceId:SpanId twice is one billable event, whichever window each
 * copy would have fallen into. There is no Timestamp anywhere in here, because
 * there is none in the query.
 */
export class FakeUsageSource implements UsageSource {
  rows: Array<{ key: string; ingestedAtMs: number; billedUsd: number }> = [];
  nowMs = T0;
  reads: ReadWindowArgs[] = [];
  throwNext: Error | null = null;

  /**
   * One costed LLM call as it lands in span_nodes. Adding the same key again is
   * a second copy of that span — a collector re-send — which readWindow resolves
   * the way `span_nodes FINAL` does.
   */
  add(key: string, ingestedAtMs: number, billedUsd = 0.001) {
    this.rows.push({ key, ingestedAtMs, billedUsd });
    return this;
  }

  async now() {
    return this.nowMs;
  }

  async readWindow(_slug: string, a: ReadWindowArgs): Promise<UsageWindow> {
    this.reads.push(a);
    if (this.throwNext) {
      const err = this.throwNext;
      this.throwNext = null;
      throw err;
    }

    // `span_nodes FINAL`: one row per TraceId:SpanId, and it is the FIRST copy —
    // the earliest ingested_at (tenant migration 030; a tie keeps the first
    // added). Resolved over the whole table BEFORE the window filter, because
    // that is the order ClickHouse applies them in, and why a re-send's window
    // never sees a span that was already billed.
    const survivors = new Map<string, FakeUsageSource["rows"][number]>();
    for (const e of this.rows) {
      const kept = survivors.get(e.key);
      if (!kept || e.ingestedAtMs < kept.ingestedAtMs) survivors.set(e.key, e);
    }

    // `ingested_at > from AND ingested_at <= to` — half-open, so consecutive
    // windows neither overlap nor leave a gap.
    const inWindow = [...survivors.values()].filter((e) => e.ingestedAtMs > a.fromMs && e.ingestedAtMs <= a.toMs);

    // GROUP BY event_key, any(cost): one row per key is left, so one event each.
    let billedUsd = 0;
    for (const e of inWindow) billedUsd += e.billedUsd;
    return { eventCount: inWindow.length, billedUsd };
  }
}

export const quietLogger = { log() {}, warn() {}, error() {} };

export { randomUUID };
