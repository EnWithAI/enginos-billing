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
import { currencyCatalog, type CurrencyCatalog, type CurrencyRules } from "@/models/currency";
import { add, compare } from "@/models/decimal";
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
  freePlan?: boolean | null;
  currentTermStart?: Date | null;
  currentTermEnd?: Date | null;
  /** The confirmed billing country (CHECKed: two upper-case letters). */
  billingCountry?: string | null;
  /** The linked subscription's currency (CHECKed: three upper-case letters). */
  currency?: string | null;
  chargebeeSubscriptionId: string | null;
  ledgerUnitId: string | null;
  status: string;
  /** THE cursor. Null means billing has not started for this tenant. */
  lastProcessedIngestedAt: Date | null;
  /** A top-up charge on the wire until then (migration 20261001130000). */
  topupChargingUntil?: Date | null;
  updatedAt?: Date;
}

/** `billing_account_status_check` (migration 20261001120000). */
const ACCOUNT_STATUSES = ["unlinked", "activating", "active", "cancelled", "exhausted", "switching"];

/** `currency_switch` as stored: its DECIMAL columns as text, like the other tables here. */
interface SwitchRow {
  id: string;
  tenantId: string;
  fromSubscriptionId: string;
  fromCurrency: string;
  toCurrency: string;
  toItemPriceId: string;
  toSubscriptionId: string | null;
  toSubscriptionAt: Date | null;
  ledgerUnitId: string | null;
  status: string;
  drained: string;
  heldBack: string;
  ownGrant: string;
  drainOperationId: string | null;
  drainAmount: string | null;
  mirrorOperationId: string | null;
  mirrorAmount: string | null;
  mirroredAt: Date | null;
  leaseUntil: Date | null;
  leaseOwner: string | null;
  attemptCount: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  movingAt: Date | null;
  linkedAt: Date | null;
  activatedAt: Date | null;
  completedAt: Date | null;
}

const SWITCH_STATUSES = ["REQUESTED", "MOVING", "LINKED", "DONE", "ABANDONED"];
const OPEN_SWITCH_STATUSES = ["REQUESTED", "MOVING", "LINKED"];
const SWITCH_DECIMALS = ["drained", "heldBack", "ownGrant", "drainAmount", "mirrorAmount"] as const;

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
 * An UPDATE's `data` as Prisma sends it: a key whose value is `undefined` is
 * left out, and its column keeps what it held. Applied as given, a link that
 * named no item price used to wipe the stored one in the fake, where Postgres
 * kept it.
 */
function defined(data: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
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
  const switches = new Map<string, SwitchRow>();

  /**
   * `billing_account`'s CHECKs (migration 20261001120000): the status list,
   * and the country and currency as billing writes them. Checked on every
   * write, before the row changes — a refused UPDATE changes nothing.
   */
  function assertAccountConstraints(row: AccountRow) {
    if (!ACCOUNT_STATUSES.includes(row.status)) throw new Error(`billing_account_status_check: ${row.status}`);
    if (row.billingCountry != null && !/^[A-Z]{2}$/.test(row.billingCountry)) {
      throw new Error(`billing_account_billing_country_check: ${row.billingCountry}`);
    }
    if (row.currency != null && !/^[A-Z]{3}$/.test(row.currency)) throw new Error(`billing_account_currency_check: ${row.currency}`);
  }

  /**
   * `currency_switch`'s CHECKs (both of its migrations), its foreign key, and the partial unique index
   * `currency_switch_open_uq` — ONE open switch per tenant, which is what
   * stops two switches each carrying the org's credits somewhere. As with
   * the window index, a fake that skipped it would let every test pass while
   * production refused the second insert.
   */
  function assertSwitchConstraints(row: SwitchRow) {
    if (!accounts.has(row.tenantId)) throw new Error("currency_switch_tenant_fkey");
    if (!SWITCH_STATUSES.includes(row.status)) throw new Error(`currency_switch_status_check: ${row.status}`);
    const currency = /^[A-Z]{3}$/;
    if (!currency.test(row.fromCurrency) || !currency.test(row.toCurrency) || row.fromCurrency === row.toCurrency) {
      throw new Error("currency_switch_currencies");
    }
    const negative = (v: string | null) => v != null && compare(v, "0") < 0;
    if (negative(row.drained) || negative(row.drainAmount) || negative(row.mirrorAmount) || row.attemptCount < 0) {
      throw new Error("currency_switch_amounts_nonneg");
    }
    // 20261001130000_currency_switch_carry.
    if (negative(row.heldBack) || negative(row.ownGrant)) throw new Error("currency_switch_carry_nonneg");
    if ((row.toSubscriptionId == null) !== (row.toSubscriptionAt == null)) throw new Error("currency_switch_to_subscription_dated");
    if ((row.leaseOwner == null) !== (row.leaseUntil == null)) throw new Error("currency_switch_lease_complete");
    if (
      (row.activatedAt != null && !["LINKED", "DONE"].includes(row.status)) ||
      (row.status === "DONE" && row.activatedAt == null)
    ) {
      throw new Error("currency_switch_activated_when_linked");
    }
    if ((row.drainOperationId == null) !== (row.drainAmount == null)) throw new Error("currency_switch_drain_complete");
    if ((row.mirrorOperationId == null) !== (row.mirrorAmount == null)) throw new Error("currency_switch_mirror_complete");
    if (["MOVING", "LINKED", "DONE"].includes(row.status) && row.movingAt == null) {
      throw new Error("currency_switch_moving_when_started");
    }
    const linked = ["LINKED", "DONE"].includes(row.status);
    if (linked && (row.toSubscriptionId == null || row.linkedAt == null)) throw new Error("currency_switch_linked_to_b");
    if (linked && (row.drainOperationId != null || (row.mirrorOperationId != null && row.mirroredAt == null))) {
      throw new Error("currency_switch_settled_when_linked");
    }
    if ((row.status === "DONE") !== (row.completedAt != null)) throw new Error("currency_switch_done_when_completed");
    if (OPEN_SWITCH_STATUSES.includes(row.status)) {
      for (const other of switches.values()) {
        if (other.id !== row.id && other.tenantId === row.tenantId && OPEN_SWITCH_STATUSES.includes(other.status)) {
          throw new UniqueViolation("currency_switch_open_uq");
        }
      }
    }
  }

  /** A `currency_switch` row as the Prisma client returns it: Decimals for the DECIMAL columns. */
  const switchOut = (row: SwitchRow) => ({
    ...row,
    drained: asDecimal(row.drained),
    heldBack: asDecimal(row.heldBack),
    ownGrant: asDecimal(row.ownGrant),
    drainAmount: row.drainAmount == null ? null : asDecimal(row.drainAmount),
    mirrorAmount: row.mirrorAmount == null ? null : asDecimal(row.mirrorAmount),
  });

  /**
   * One UPDATE's `data` applied to a switch row: `{ increment }` as Postgres
   * adds (exactly, on the DECIMAL columns), a Decimal stored as its text, and
   * `@updatedAt` from the test clock unless the write names it.
   */
  function applySwitchData(row: SwitchRow, data: Record<string, any>): SwitchRow {
    const next: Record<string, any> = { ...row, updatedAt: new Date(api._now ?? T0) };
    for (const [key, value] of Object.entries(defined(data))) {
      const decimalColumn = (SWITCH_DECIMALS as readonly string[]).includes(key);
      if (value && typeof value === "object" && "increment" in value) {
        next[key] = decimalColumn ? add(next[key], stored(value.increment)) : next[key] + value.increment;
      } else {
        next[key] = decimalColumn && value != null ? stored(value) : value;
      }
    }
    return next as SwitchRow;
  }

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
   * service runs — every one opens with a write to the account row that
   * changes nothing that matters (the cursor onto itself in openWindow and
   * advancePastEmptyWindow, `updated_at` in the sync claim and the currency
   * switch's start and link), checks everything under that lock, and only
   * then writes what changes state — so none of them depends on a rollback.
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

  /**
   * `matches`, plus the one relation filter billing writes on an account:
   * `switches: { none | some: <where> }` — the tenant's `currency_switch`
   * rows, as Prisma joins them.
   */
  function accountMatches(row: AccountRow, where: Record<string, any>): boolean {
    const { switches: relation, ...rest } = where;
    if (!matches(row as unknown as Record<string, any>, rest)) return false;
    if (relation === undefined) return true;
    const own = [...switches.values()].filter((sw) => sw.tenantId === row.tenantId);
    const keys = Object.keys(relation);
    if (keys.length !== 1 || !["none", "some"].includes(keys[0]!)) {
      throw new Error(`fake Prisma: relation filter ${JSON.stringify(keys)} on switches is not modelled`);
    }
    const hit = own.some((sw) => matches(sw as unknown as Record<string, any>, relation[keys[0]!]));
    return keys[0] === "none" ? !hit : hit;
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
    for (const [key, value] of Object.entries(defined(data))) {
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
      async findMany({ where, orderBy, take }: { where?: Record<string, any>; orderBy?: unknown; take?: number; select?: unknown } = {}) {
        const rows = ordered([...accounts.values()].filter((row) => accountMatches(row, where ?? {})), orderBy);
        return (take == null ? rows : rows.slice(0, take)).map((r) => ({ ...r }));
      },
      async findFirst({ where }: { where?: Record<string, any> } = {}) {
        const row = [...accounts.values()].find((r) => accountMatches(r, where ?? {}));
        return row ? { ...row } : null;
      },
      async upsert({ where, create, update }: { where: { tenantId: string }; create: Record<string, any>; update: Record<string, any> }) {
        const existing = accounts.get(where.tenantId);
        if (existing) {
          assertAccountConstraints({ ...existing, ...defined(update) });
          Object.assign(existing, defined(update));
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
        assertAccountConstraints(row);
        accounts.set(row.tenantId, row);
        return { ...row };
      },
      async update({ where, data }: { where: { tenantId: string }; data: Record<string, unknown> }) {
        const tx = await lockAccountRows([where.tenantId]);
        const row = accounts.get(where.tenantId)!;
        assertAccountConstraints({ ...row, ...defined(data) } as AccountRow);
        Object.assign(row, defined(data));
        holdAccountRow(tx, where.tenantId);
        return { ...row };
      },
      async updateMany({ where, data }: { where: Record<string, any>; data: Record<string, any> }) {
        // Wait out any other transaction's lock, THEN evaluate the WHERE — the
        // re-check Postgres makes against the row the lock holder committed.
        const tx = await lockAccountRows(candidateTenantIds(where));
        const hit = [...accounts.values()].filter((row) => matches(row as Record<string, any>, where));
        // One statement: every row it would change passes the CHECKs, or none changes.
        for (const row of hit) assertAccountConstraints({ ...row, ...defined(data) });
        for (const row of hit) {
          Object.assign(row, defined(data));
          holdAccountRow(tx, row.tenantId);
        }
        return { count: hit.length };
      },
    },

    /** Mirrors `currency_switch`: its CHECKs, its foreign key, and `currency_switch_open_uq`. */
    currencySwitch: {
      async create({ data }: { data: Record<string, any> }) {
        const at = new Date(api._now ?? T0);
        const row = {
          id: data.id ?? randomUUID(),
          toSubscriptionId: null,
          toSubscriptionAt: null,
          ledgerUnitId: null,
          drainOperationId: null,
          drainAmount: null,
          mirrorOperationId: null,
          mirrorAmount: null,
          mirroredAt: null,
          leaseUntil: null,
          leaseOwner: null,
          attemptCount: 0,
          error: null,
          createdAt: at,
          updatedAt: at,
          movingAt: null,
          linkedAt: null,
          activatedAt: null,
          completedAt: null,
          ...data,
          drained: stored(data.drained ?? "0"),
          heldBack: stored(data.heldBack ?? "0"),
          ownGrant: stored(data.ownGrant ?? "0"),
        } as SwitchRow;
        if (data.drainAmount != null) row.drainAmount = stored(data.drainAmount);
        if (data.mirrorAmount != null) row.mirrorAmount = stored(data.mirrorAmount);
        assertSwitchConstraints(row);
        switches.set(row.id, row);
        return switchOut(row);
      },
      async findUnique({ where }: { where: { id: string } }) {
        const row = switches.get(where.id);
        return row ? switchOut(row) : null;
      },
      async findFirst({ where, orderBy }: { where?: Record<string, any>; orderBy?: any } = {}) {
        const row = ordered([...switches.values()].filter((r) => matches(r as unknown as Record<string, any>, where ?? {})), orderBy)[0];
        return row ? switchOut(row) : null;
      },
      async findMany({ where, orderBy }: { where?: Record<string, any>; orderBy?: any } = {}) {
        return ordered([...switches.values()].filter((r) => matches(r as unknown as Record<string, any>, where ?? {})), orderBy).map(
          switchOut,
        );
      },
      /** Compare-and-set, atomic as one UPDATE is: every row it would change passes the CHECKs, or none changes. */
      async updateMany({ where, data }: { where: Record<string, any>; data: Record<string, any> }) {
        const before = [...switches.values()].filter((row) => matches(row as unknown as Record<string, any>, where));
        const next = before.map((row) => applySwitchData(row, data));
        for (const row of next) switches.set(row.id, row);
        try {
          // Against the table as the statement leaves it — the unique index included.
          for (const row of next) assertSwitchConstraints(row);
        } catch (err) {
          for (const row of before) switches.set(row.id, row);
          throw err;
        }
        return { count: next.length };
      },
      async count({ where }: { where?: Record<string, any> } = {}) {
        return [...switches.values()].filter((r) => matches(r as unknown as Record<string, any>, where ?? {})).length;
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
      async count({ where }: { where?: Record<string, any> } = {}) {
        return [...topUps.values()].filter((r) => matches(r as unknown as Record<string, any>, where ?? {})).length;
      },
      /** Compare-and-set, atomic as one UPDATE is. `updatedAt` follows the test clock unless the write names it. */
      async updateMany({ where, data }: { where: Record<string, any>; data: Record<string, any> }) {
        let count = 0;
        for (const row of [...topUps.values()]) {
          if (!matches(row as unknown as Record<string, any>, where)) continue;
          const next: TopUpRow = { ...row, updatedAt: new Date(api._now ?? T0), ...defined(data) };
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
    /** `currency_switch` rows by id, amounts as their stored text. */
    _switches: switches,
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

/**
 * Prisma's `where`, as far as this service writes one — evaluated as the SQL
 * it becomes:
 *
 *   OR / AND / NOT          any / all / none of the conditions
 *   undefined               no condition at all (Prisma drops it)
 *   null                    IS NULL
 *   a Date                  equal to the millisecond
 *   a number or a Decimal   numerically equal (DECIMAL columns are stored as text here)
 *   { in, notIn, not, equals, lt, lte, gt, gte, startsWith }
 *                           EVERY operator given must hold, as in Prisma. A
 *                           NULL column matches no comparison — `not: x`
 *                           and `notIn` included, as in SQL — only `not: null`.
 *
 * An operator not listed THROWS. It used to match nothing, silently, so a
 * guard written with one looked like a guard that never let anything through
 * — exactly the kind of test that passes for the wrong reason.
 */
export function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Array<Record<string, any>>).some((c) => matches(row, c));
    if (key === "AND") return asList(condition).every((c) => matches(row, c));
    if (key === "NOT") return !asList(condition).some((c) => matches(row, c));
    return matchesValue(row[key], condition);
  });
}

function asList(condition: unknown): Array<Record<string, any>> {
  return (Array.isArray(condition) ? condition : [condition]) as Array<Record<string, any>>;
}

const FILTER_OPERATORS = new Set(["equals", "in", "notIn", "not", "lt", "lte", "gt", "gte", "startsWith"]);

function isDecimalLike(value: unknown): value is { toFixed(): string } {
  return value != null && typeof value === "object" && typeof (value as { toFixed?: unknown }).toFixed === "function";
}

function matchesValue(value: any, condition: any): boolean {
  if (condition === undefined) return true;
  if (condition === null) return value == null;
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (typeof condition === "number") return value != null && Number(value) === condition;
  if (isDecimalLike(condition)) return value != null && compare(stored(value), condition.toFixed()) === 0;
  if (condition && typeof condition === "object" && !Array.isArray(condition)) {
    return Object.entries(condition).every(([op, operand]) => {
      if (!FILTER_OPERATORS.has(op)) throw new Error(`fake Prisma: filter operator "${op}" is not modelled — add it to matches()`);
      return applyOperator(value, op, operand);
    });
  }
  return value === condition;
}

function applyOperator(value: any, op: string, operand: any): boolean {
  switch (op) {
    case "equals":
      return matchesValue(value, operand);
    case "in":
      return (operand as unknown[]).some((o) => o !== null && matchesValue(value, o));
    case "notIn":
      return value != null && !(operand as unknown[]).some((o) => o !== null && matchesValue(value, o));
    case "not":
      return operand === null ? value != null : value != null && !matchesValue(value, operand);
    case "startsWith":
      return typeof value === "string" && value.startsWith(operand);
    default: {
      if (value == null || operand == null) return false;
      const order = ordering(value, operand);
      return op === "lt" ? order < 0 : op === "lte" ? order <= 0 : op === "gt" ? order > 0 : order >= 0;
    }
  }
}

/** Negative, zero or positive, as `a` sorts before, with or after `b`: Dates by time, numbers and Decimals by value. */
function ordering(a: any, b: any): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof b === "number" || isDecimalLike(b) || isDecimalLike(a)) return compare(stored(a), stored(b));
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `orderBy` — one field or several, each `asc` or `desc`; nulls first, as the fakes always have. */
function ordered<T>(rows: T[], orderBy: unknown): T[] {
  const orders = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, string>>;
  let out = [...rows];
  for (const o of [...orders].reverse()) {
    const [field, dir] = Object.entries(o)[0] as [string, string];
    out = out.sort((x, y) => {
      const a = (x as Record<string, any>)[field];
      const b = (y as Record<string, any>)[field];
      const cmp = a == null && b == null ? 0 : a == null ? -1 : b == null ? 1 : Math.sign(ordering(a, b));
      return dir === "desc" ? -cmp : cmp;
    });
  }
  return out;
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

/**
 * A currency catalog (models/currency.ts) with what a test sells in its
 * DEFAULT currency — the free plan, the top-up and its credits per unit — as
 * the container builds one from FREE_PLAN_ITEM_PRICE_ID_<CUR> and
 * TOPUP_ITEM_PRICE_ID_<CUR>.
 *
 * INR unless the rules say otherwise: every fixture here was written in INR
 * (the plans and charges the stubs describe say `currencyCode: "INR"`), and
 * the default currency is the one an org with no billing address is billed
 * in. A test about more than one currency builds its catalog itself.
 */
export function testCatalog(
  inDefault: {
    free?: string | null;
    topUp?: string | null;
    credits?: string;
    presetAmounts?: number[];
    minAmount?: number | null;
    maxAmount?: number | null;
  } = {},
  rules: CurrencyRules = { defaultCurrency: "INR", byCountry: {} },
): CurrencyCatalog {
  const topUp = inDefault.topUp
    ? {
        itemPriceId: inDefault.topUp,
        presetAmounts: inDefault.presetAmounts ?? [50, 100],
        minAmount: inDefault.minAmount ?? null,
        maxAmount: inDefault.maxAmount ?? null,
        credits: inDefault.credits ?? "",
      }
    : null;
  return currencyCatalog(rules, { [rules.defaultCurrency]: { freeItemPriceId: inDefault.free || null, topUp } });
}

export { randomUUID };
