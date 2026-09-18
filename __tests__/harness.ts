/**
 * In-memory doubles for the sync loop.
 *
 * The fake Prisma enforces the two PARTIAL unique indexes from the migration,
 * because those constraints — not any code path — are what prevent a double
 * charge. A fake that ignored them would let every test pass while production
 * charged twice.
 *
 * The fake Chargebee models the property the whole design rests on: a capture
 * carrying an id that already moved money does not move it again. If that turns
 * out not to hold against the real API, these tests still pass — which is
 * exactly why `captureIdempotent()` checks for an existing operation first, and
 * why the design flags confirming it as a release gate.
 */

import { randomUUID } from "node:crypto";
import { CAPTURE_OK, CAPTURE_REPLAYED, type CaptureArgs, type CaptureResult } from "@/lib/chargebee";

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

  /** Mirrors `usage_sync_batch_window_uq` and `usage_sync_batch_pending_uq`. */
  function assertBatchIndexes(row: BatchRow, excludeId?: string) {
    for (const existing of batches.values()) {
      if (existing.id === excludeId) continue;
      if (existing.tenantId !== row.tenantId) continue;

      if (
        row.kind === "window" &&
        existing.kind === "window" &&
        existing.windowStart.getTime() === row.windowStart.getTime()
      ) {
        throw new UniqueViolation("usage_sync_batch_window_uq");
      }
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
      async findUnique({ where }: { where: { routingSlug?: string; tenantId?: string } }) {
        for (const row of accounts.values()) {
          if (where.routingSlug && row.routingSlug === where.routingSlug) return { ...row };
          if (where.tenantId && row.tenantId === where.tenantId) return { ...row };
        }
        return null;
      },
      async findMany() {
        return [...accounts.values()].map((r) => ({ ...r }));
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
      async aggregate({ where }: { where: Record<string, any> }) {
        const rows = [...batches.values()].filter((row) => matches(row, where));
        const max = rows.reduce<Date | null>(
          (best, row) => (!best || row.windowEnd > best ? row.windowEnd : best),
          null,
        );
        return { _max: { windowEnd: max } };
      },
    },

    creditLedgerEntry,

    /** Runs the callback against the same store — enough to assert atomicity intent. */
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(api);
    },

    /** Test-only views. */
    _entries: entries,
    _batches: batches,
    _accounts: accounts,
  };

  return api;
}

function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition && typeof condition === "object" && "in" in condition) {
      return (condition.in as unknown[]).includes(row[key]);
    }
    if (condition && typeof condition === "object" && "not" in condition) {
      return row[key] !== condition.not;
    }
    return row[key] === condition;
  });
}

export class FakeChargebee {
  balance: number;
  applied = new Map<string, string>();
  captures: Array<{ id: string; amount: string }> = [];
  failNext: CaptureResult | null = null;

  constructor(balance = 1000) {
    this.balance = balance;
  }

  fail(result: CaptureResult) {
    this.failNext = result;
    return this;
  }

  async captureIdempotent(args: CaptureArgs): Promise<CaptureResult> {
    this.captures.push({ id: args.id, amount: args.amount });

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
    return { kind: CAPTURE_OK, operationId: args.id, balanceAfter: String(this.balance) };
  }

  /** How many times money actually moved. The assertion that matters most. */
  get appliedCount() {
    return this.applied.size;
  }
}

export class FakeUsage {
  perWindow = new Map<number, { billedUsd: string; spans: number }>();
  reads: Array<{ slug: string; window: { start: number; end: number } }> = [];
  throwNext: Error | null = null;

  constructor(public defaultUsd = "0") {}

  set(windowStart: number, billedUsd: string, spans = 1) {
    this.perWindow.set(windowStart, { billedUsd, spans });
    return this;
  }

  async readWindow(slug: string, window: { start: number; end: number }) {
    this.reads.push({ slug, window });
    if (this.throwNext) {
      const err = this.throwNext;
      this.throwNext = null;
      throw err;
    }
    const hit = this.perWindow.get(window.start);
    const billedUsd = hit?.billedUsd ?? this.defaultUsd;
    return {
      spans: hit?.spans ?? (billedUsd === "0" ? 0 : 1),
      billedUsd,
      providerUsd: billedUsd,
      marginUsd: "0",
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}

export const quietLogger = { log() {}, warn() {}, error() {} };
