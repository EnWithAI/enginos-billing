/**
 * In-memory doubles for the usage sync.
 *
 * The fake Prisma enforces the constraints that prevent a double charge — one
 * pending capture per tenant, one key per billed usage event — because those
 * constraints, not any code path, are what make a replay safe. A fake that
 * ignored them would let every test pass while production charged twice.
 *
 * The fake Chargebee models the property the whole design rests on: a capture
 * carrying an id that already moved money does not move it again. If that turns
 * out not to hold against the real API, these tests still pass — which is
 * exactly why `captureIdempotent()` checks for an existing operation first, and
 * why the design flags confirming it as a release gate.
 */

import { randomUUID } from "node:crypto";
import { CAPTURE_OK, CAPTURE_REPLAYED, CAPTURE_RETRYABLE, type CaptureArgs, type CaptureResult } from "@/lib/chargebee";
import type { ReadEventsArgs, UsageEvent, UsageSource } from "@/lib/usage-events";

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
  grantedCredits?: string;
  budgetUsd?: string;
  billingEmail?: string | null;
  currentTermStart?: Date | null;
  currentTermEnd?: Date | null;
  chargebeeSubscriptionId: string | null;
  ledgerUnitId: string | null;
  status: string;
  syncFrom: Date;
  cachedBalanceCredits: string | null;
  cachedBalanceAt: Date | null;
}

interface BatchRow {
  id: string;
  tenantId: string;
  chargebeeSubscriptionId: string | null;
  ledgerUnitId: string | null;
  kind: string;
  windowStart: Date;
  windowEnd: Date;
  spanCount: bigint;
  billedUsd: string;
  providerUsd: string;
  marginUsd: string;
  consumeCredits: string;
  status: string;
  attempts: number;
  lastError: string | null;
  chargebeeOperationId: string | null;
  balanceAfter: string | null;
  hatchetRunId: string | null;
  capturedAt: Date | null;
}

interface EntryRow {
  id: string;
  tenantId: string;
  entryType: string;
  deltaCredits: string;
  sourceRef: string;
  billedUsd: string | null;
  chargebeeOperationId: string | null;
  occurredAt: Date;
}

export function makeFakePrisma(account: Partial<AccountRow> = {}) {
  const accounts = new Map<string, AccountRow>();
  const batches = new Map<string, BatchRow>();
  const entries: EntryRow[] = [];
  const events = new Map<string, Record<string, any>>();
  const cursors = new Map<string, Record<string, any>>();
  const billed = new Map<string, Record<string, any>>(); // `${tenantId}|${eventKey}`

  accounts.set(TENANT, {
    tenantId: TENANT,
    routingSlug: SLUG,
    chargebeeSubscriptionId: "sub_1",
    ledgerUnitId: "token",
    status: "active",
    syncFrom: new Date(T0),
    cachedBalanceCredits: null,
    cachedBalanceAt: null,
    ...account,
  });

  /** Mirrors `usage_sync_batch_pending_uq`: one capture in flight per tenant. */
  function assertBatchIndexes(row: BatchRow, excludeId?: string) {
    // The table's CHECK constraints. A fake that skipped them let a zero-width
    // capture (every event in one millisecond) pass here and fail in Postgres.
    if (!["pending", "captured", "failed", "skipped"].includes(row.status)) throw new Error(`usage_sync_batch_status_check: ${row.status}`);
    if (!["window", "adjustment"].includes(row.kind)) throw new Error(`usage_sync_batch_kind_check: ${row.kind}`);
    if (row.windowEnd.getTime() < row.windowStart.getTime()) throw new Error("usage_sync_batch_window_order");
    if (Number(row.billedUsd) < 0 || Number(row.consumeCredits) < 0 || Number(row.spanCount) < 0) throw new Error("usage_sync_batch_amounts_nonneg");
    for (const existing of batches.values()) {
      if (existing.id === excludeId) continue;
      if (existing.tenantId !== row.tenantId) continue;
      if (row.status === "pending" && existing.status === "pending") {
        throw new UniqueViolation("usage_sync_batch_pending_uq");
      }
    }
  }

  const creditLedgerEntry = {
    /** Mirrors Prisma's groupBy shape closely enough for balanceOf. */
    async groupBy({ where }: { where: { tenantId: string } }) {
      const byType = new Map<string, number>();
      for (const e of entries) {
        if (e.tenantId !== where.tenantId) continue;
        byType.set(e.entryType, (byType.get(e.entryType) ?? 0) + Number(e.deltaCredits));
      }
      return [...byType].map(([entryType, sum]) => ({
        entryType,
        _sum: { deltaCredits: String(sum) },
      }));
    },
    async findMany({ where }: { where: { tenantId: string } }) {
      return entries.filter((e) => e.tenantId === where.tenantId);
    },
    async findFirst({ where }: { where: Record<string, any> }) {
      return entries.find((e) => matches(e as Record<string, any>, where)) ?? null;
    },
    async create({ data }: { data: Omit<EntryRow, "id"> }) {
      // Mirrors `credit_ledger_tenant_source_uq`.
      if (entries.some((e) => e.tenantId === data.tenantId && e.sourceRef === data.sourceRef)) {
        throw new UniqueViolation("credit_ledger_tenant_source_uq");
      }
      const row = { id: randomUUID(), ...data };
      entries.push(row);
      return row;
    },
  };

  // Annotated explicitly: `api` references itself inside `$transaction`, and
  // without a type annotation TypeScript cannot infer a self-referential object.
  const api: any = {
    billingAccount: {
      async findUnique({ where }: { where: { routingSlug?: string; tenantId?: string; chargebeeCustomerId?: string } }) {
        for (const row of accounts.values()) {
          if (where.routingSlug && row.routingSlug === where.routingSlug) return { ...row };
          if (where.tenantId && row.tenantId === where.tenantId) return { ...row };
          if (where.chargebeeCustomerId && (row as any).chargebeeCustomerId === where.chargebeeCustomerId) return { ...row };
        }
        return null;
      },
      async findMany({ where }: { where?: Record<string, any> } = {}) {
        return [...accounts.values()].filter((row) => matches(row, where ?? {})).map((r) => ({ ...r }));
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
          status: "unlinked",
          cachedBalanceCredits: null,
          cachedBalanceAt: null,
          chargebeeCustomerId: null,
          grantedCredits: "0",
          budgetUsd: "0",
          ...create,
        } as unknown as AccountRow;
        accounts.set(row.tenantId, row);
        return { ...row };
      },
      async update({ where, data }: { where: { tenantId: string }; data: Record<string, unknown> }) {
        const row = accounts.get(where.tenantId)!;
        Object.assign(row, data);
        return { ...row };
      },
    },

    usageSyncBatch: {
      async create({ data }: { data: Record<string, any> }) {
        const row: BatchRow = {
          id: randomUUID(),
          attempts: 0,
          lastError: null,
          chargebeeOperationId: null,
          balanceAfter: null,
          capturedAt: null,
          ...data,
          billedUsd: String(data.billedUsd),
          providerUsd: String(data.providerUsd ?? 0),
          marginUsd: String(data.marginUsd ?? 0),
          consumeCredits: String(data.consumeCredits),
        } as BatchRow;
        assertBatchIndexes(row);
        batches.set(row.id, row);
        return { ...row };
      },
      async findFirst({ where, orderBy }: { where: Record<string, any>; orderBy?: Record<string, string> }) {
        let rows = [...batches.values()].filter((row) => matches(row, where));
        if (orderBy?.windowEnd === "desc") {
          rows = rows.sort((a, b) => b.windowEnd.getTime() - a.windowEnd.getTime());
        }
        return rows[0] ? { ...rows[0] } : null;
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, any> }) {
        const row = batches.get(where.id)!;
        const next = { ...row };
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === "object" && "increment" in value) {
            (next as any)[key] = (next as any)[key] + (value as { increment: number }).increment;
          } else {
            (next as any)[key] = value;
          }
        }
        assertBatchIndexes(next, row.id);
        batches.set(where.id, next);
        return { ...next };
      },
      async findMany({ where }: { where: Record<string, any> }) {
        return [...batches.values()].filter((row) => matches(row, where)).map((r) => ({ ...r }));
      },
      async findUnique({ where }: { where: { id: string } }) {
        const row = batches.get(where.id);
        return row ? { ...row } : null;
      },
    },

    /** Mirrors `billing_cursor`: tenant_id is the primary key. */
    billingCursor: {
      async findMany() {
        return [...cursors.values()].map((r) => ({ ...r }));
      },
      async findUnique({ where }: { where: { tenantId: string } }) {
        const row = cursors.get(where.tenantId);
        return row ? { ...row } : null;
      },
      async create({ data }: { data: Record<string, any> }) {
        if (cursors.has(data.tenantId)) throw new UniqueViolation("billing_cursor_pkey");
        const row = { lastEventId: "", lockedUntil: null, lockedBy: null, updatedAt: new Date(), ...data };
        cursors.set(data.tenantId, row);
        return { ...row };
      },
      async updateMany({ where, data }: { where: Record<string, any>; data: Record<string, any> }) {
        let count = 0;
        for (const row of cursors.values()) {
          if (matches(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
    },

    /** Mirrors `billed_usage_event`: (tenant_id, event_key) is the primary key. */
    billedUsageEvent: {
      async findMany({ where }: { where: Record<string, any> }) {
        return [...billed.values()].filter((row) => matches(row, where)).map((r) => ({ ...r }));
      },
      async createMany({ data }: { data: Array<Record<string, any>> }) {
        for (const d of data) {
          if (billed.has(`${d.tenantId}|${d.eventKey}`)) throw new UniqueViolation("billed_usage_event_pkey");
        }
        for (const d of data) billed.set(`${d.tenantId}|${d.eventKey}`, { createdAt: new Date(), batchId: null, ...d });
        return { count: data.length };
      },
      async deleteMany({ where }: { where: Record<string, any> }) {
        let count = 0;
        for (const [k, row] of billed) {
          if (matches(row, where)) {
            billed.delete(k);
            count += 1;
          }
        }
        return { count };
      },
    },

    creditLedgerEntry,

    /** Mirrors `processed_billing_event`: event_id is the primary key. */
    processedBillingEvent: {
      async create({ data }: { data: Record<string, any> }) {
        if (events.has(data.eventId)) throw new UniqueViolation("processed_billing_event_pkey");
        const row = { tenantId: null, processedAt: null, error: null, receivedAt: new Date(), ...data };
        events.set(data.eventId, row);
        return { ...row };
      },
      async update({ where, data }: { where: { eventId: string }; data: Record<string, any> }) {
        const row = events.get(where.eventId)!;
        Object.assign(row, data);
        return { ...row };
      },
      async updateMany({ where, data }: { where: Record<string, any>; data: Record<string, any> }) {
        let count = 0;
        for (const row of events.values()) {
          if (matches(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
    },

    /** Runs the callback against the same store — enough to assert atomicity intent. */
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(api);
    },

    /** Test-only views. */
    _entries: entries,
    _batches: batches,
    _accounts: accounts,
    _events: events,
    _cursors: cursors,
    _billed: billed,
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
      return row[key] !== condition.not;
    }
    if (condition && typeof condition === "object" && "lt" in condition) {
      return row[key] < condition.lt;
    }
    if (condition && typeof condition === "object" && "startsWith" in condition) {
      return typeof row[key] === "string" && row[key].startsWith(condition.startsWith);
    }
    // Decimal columns are held as strings here; Prisma compares them by value.
    if (typeof condition === "number") return Number(row[key]) === condition;
    return row[key] === condition;
  });
}

export class FakeChargebee {
  balance: number;
  applied = new Map<string, string>();
  captures: Array<{ id: string; amount: string }> = [];
  failNext: CaptureResult | null = null;
  /** The charge lands, but the response never arrives (network timeout). */
  loseResponseNext = false;
  /** The worker dies mid-call: before the charge, or after it landed. */
  crashNext: "before" | "after" | null = null;

  constructor(balance = 1000) {
    this.balance = balance;
  }

  fail(result: CaptureResult) {
    this.failNext = result;
    return this;
  }

  async captureIdempotent(args: CaptureArgs): Promise<CaptureResult> {
    this.captures.push({ id: args.id, amount: args.amount });

    if (this.crashNext === "before") {
      this.crashNext = null;
      throw new Error("worker killed before the capture");
    }
    if (this.failNext) {
      const result = this.failNext;
      this.failNext = null;
      return result;
    }

    // The guarantee under test: a replayed id is acknowledged, not re-debited.
    if (this.applied.has(args.id)) {
      return { kind: CAPTURE_REPLAYED, operationId: args.id, balanceAfter: String(this.balance) };
    }

    this.applied.set(args.id, args.amount);
    this.balance -= Number(args.amount);

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
 * ClickHouse span_nodes as the usage sync sees it: events in
 * (ingestedAt, key) order, byte-wise key comparison, Timestamp >= the floor.
 */
export class FakeUsageSource implements UsageSource {
  events: Array<UsageEvent & { timestampMs: number }> = [];
  nowMs = T0;
  reads: ReadEventsArgs[] = [];
  throwNext: Error | null = null;

  /** One costed LLM call. `timestampMs` is the LLM span start, <= ingestion. */
  add(key: string, ingestedAtMs: number, billedUsd = 0.001, timestampMs = ingestedAtMs) {
    this.events.push({ key, ingestedAtMs, billedUsd, providerUsd: billedUsd, marginUsd: 0, inputTokens: 1, outputTokens: 1, timestampMs });
    return this;
  }

  async now() {
    return this.nowMs;
  }

  async readEvents(_slug: string, a: ReadEventsArgs): Promise<UsageEvent[]> {
    this.reads.push(a);
    if (this.throwNext) {
      const err = this.throwNext;
      this.throwNext = null;
      throw err;
    }
    const byte = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
    return this.events
      .filter((e) => e.timestampMs >= a.minTimestampMs && e.ingestedAtMs <= a.untilMs)
      .filter((e) => e.ingestedAtMs > a.afterMs || (e.ingestedAtMs === a.afterMs && byte(e.key, a.afterKey) > 0))
      .sort((x, y) => x.ingestedAtMs - y.ingestedAtMs || byte(x.key, y.key))
      .slice(0, a.limit)
      .map(({ timestampMs: _t, ...e }) => e);
  }
}

export const quietLogger = { log() {}, warn() {}, error() {} };
