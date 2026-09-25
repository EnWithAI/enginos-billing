/**
 * `chargebee_sync` — one row per billing window sent to Chargebee.
 *
 * The row's id IS the Chargebee ledger operation id, and `chargebee_sync_window_uq`
 * on (tenant_id, from_ingested_at) is what stops two workers opening the same
 * window. Both are enforced by the table; this module only names the queries.
 *
 * Every write that changes what a row SAYS is a compare-and-set, and each one
 * names what it compares:
 *
 *   openWindow       the cursor is still at the window's start (and holds the
 *                    account row while the window is written)
 *   claim            the row is still in the state it was read in
 *   markSuccess /    the row is still PROCESSING under THIS claim — so a
 *   markUnresolved   caller whose claim was taken over cannot overwrite the
 *                    answer the new owner wrote, and a SUCCESS is never
 *                    turned back into anything else
 *   writeOff         the row is still the refusal it was read as
 */

import { prisma as defaultPrisma, type PrismaClient } from "../db/prisma";
import { fromDb } from "../models/decimal";
import { SYNC, UNRESOLVED } from "../models/sync-status";

type ChargebeeSyncRow = NonNullable<Awaited<ReturnType<PrismaClient["chargebeeSync"]["findFirst"]>>>;

/**
 * A `chargebee_sync` row as the rest of the service sees it: the two money
 * columns as exact, plain decimal STRINGS, never Prisma `Decimal` objects.
 *
 * Converted here, where rows are read, because a `Decimal` below 1e-6 prints
 * itself as "5e-7" — and every consumer of a row used to stringify it and
 * parse the result. A $0.0000005 window therefore threw on every recovery,
 * before its claim, and held its tenant's billing for good (C44). Nothing
 * outside this file sees a `Decimal`.
 */
export type ChargebeeSync = Omit<ChargebeeSyncRow, "amount" | "billedUsd"> & { amount: string; billedUsd: string };

function toSync(row: ChargebeeSyncRow): ChargebeeSync;
function toSync(row: ChargebeeSyncRow | null): ChargebeeSync | null;
function toSync(row: ChargebeeSyncRow | null): ChargebeeSync | null {
  if (!row) return null;
  return { ...row, amount: fromDb(row.amount), billedUsd: fromDb(row.billedUsd) };
}

/** One caller's right to send a row: which row, and the attempt it claimed. */
export interface SyncClaim {
  id: string;
  attemptCount: number;
}

export interface NewWindowSync {
  tenantId: string;
  chargebeeSubscriptionId: string | null;
  ledgerUnitId: string | null;
  fromIngestedAt: Date;
  toIngestedAt: Date;
  eventCount: number;
  amount: string;
  billedUsd: string;
  status: string;
  error: string | null;
  settledAt: Date | null;
  hatchetRunId: string | null;
}

export function createChargebeeSyncRepository(prisma: PrismaClient = defaultPrisma) {
  return {
    /** The one sync holding this tenant, if any. Oldest window first. */
    async oldestUnresolved(tenantId: string): Promise<ChargebeeSync | null> {
      const row = await prisma.chargebeeSync.findFirst({
        where: { tenantId, status: { in: [...UNRESOLVED] } },
        orderBy: { fromIngestedAt: "asc" },
      });
      return toSync(row);
    },

    /** Throws a unique violation when the window is already owned — see the window index. */
    async create(data: NewWindowSync): Promise<ChargebeeSync> {
      return toSync(await prisma.chargebeeSync.create({ data }));
    },

    /**
     * Write the row for a window — but only while the cursor is still at the
     * window's start. Null when it is not: someone else has moved billing on,
     * and this window is stale.
     *
     * The window index alone does not cover this. It is on `from_ingested_at`,
     * so it catches two workers opening the SAME window, but not two windows of
     * different lengths — which is what a change to BILLING_WINDOW_MS between
     * deploys produces while the old worker and the new one overlap. A 60s
     * worker could move the cursor over an empty first minute and bill the
     * second, while a 120s worker that had read the cursor before that went on
     * to bill both minutes under another id: the second minute, twice.
     *
     * The first statement is a compare-and-set of the cursor onto itself, which
     * both checks it and LOCKS the account row until the insert commits. The
     * empty-window advance takes the same lock (billing-account.repository.ts
     * advancePastEmptyWindow), so the two serialise: either the cursor has
     * already moved and this returns null, or the row exists before the other
     * side looks for one.
     */
    async openWindow(data: NewWindowSync): Promise<ChargebeeSync | null> {
      const row = await prisma.$transaction(async (tx) => {
        const held = await tx.billingAccount.updateMany({
          where: { tenantId: data.tenantId, lastProcessedIngestedAt: data.fromIngestedAt },
          data: { lastProcessedIngestedAt: data.fromIngestedAt },
        });
        if (held.count !== 1) return null;
        return tx.chargebeeSync.create({ data });
      });
      return toSync(row);
    },

    async findByWindowStart(tenantId: string, fromIngestedAt: Date): Promise<ChargebeeSync | null> {
      return toSync(await prisma.chargebeeSync.findFirst({ where: { tenantId, fromIngestedAt } }));
    },

    /**
     * Take the row for ONE send: PROCESSING, one more attempt — if and only if
     * it is still exactly as it was read. Null when another caller changed it
     * first, and that caller is the one sending it.
     *
     * Committed BEFORE the request leaves, so a row still PENDING has provably
     * never been sent. The compare-and-set is what keeps that true with more
     * than one caller: two that read the same PENDING row both try to claim it,
     * and only one of them gets to send.
     */
    async claim(row: Pick<ChargebeeSync, "id" | "status" | "attemptCount">): Promise<SyncClaim | null> {
      const attemptCount = row.attemptCount + 1;
      const { count } = await prisma.chargebeeSync.updateMany({
        where: { id: row.id, status: row.status, attemptCount: row.attemptCount },
        // Explicit, not left to @updatedAt: the claim's time IS the lease.
        data: { status: SYNC.PROCESSING, attemptCount, updatedAt: new Date() },
      });
      return count === 1 ? { id: row.id, attemptCount } : null;
    },

    /** False when the claim was taken over; whoever holds it now settles the row. */
    async markSuccess(claim: SyncClaim, settledAt: Date): Promise<boolean> {
      const { count } = await prisma.chargebeeSync.updateMany({
        where: { id: claim.id, status: SYNC.PROCESSING, attemptCount: claim.attemptCount },
        data: { status: SYNC.SUCCESS, settledAt, error: null, updatedAt: new Date() },
      });
      return count === 1;
    },

    /** False when the claim was taken over; the answer is then the new owner's to write. */
    async markUnresolved(claim: SyncClaim, status: string, error: string): Promise<boolean> {
      const { count } = await prisma.chargebeeSync.updateMany({
        where: { id: claim.id, status: SYNC.PROCESSING, attemptCount: claim.attemptCount },
        data: { status, error, settledAt: null, updatedAt: new Date() },
      });
      return count === 1;
    },

    /**
     * Give up on a refused row whose subscription has ended — if and only if
     * it is still exactly as it was read, so a caller that has just claimed it
     * keeps it. False when someone else changed it first.
     */
    async writeOff(row: Pick<ChargebeeSync, "id" | "status" | "attemptCount">, reason: string): Promise<boolean> {
      const { count } = await prisma.chargebeeSync.updateMany({
        where: { id: row.id, status: row.status, attemptCount: row.attemptCount },
        data: { status: SYNC.WRITTEN_OFF, error: reason, settledAt: null, updatedAt: new Date() },
      });
      return count === 1;
    },

    async tenantIdsWithUnresolved(): Promise<string[]> {
      const rows = await prisma.chargebeeSync.findMany({
        where: { status: { in: [...UNRESOLVED] } },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      return rows.map((r) => r.tenantId);
    },

    /** The newest resolved sync — what the billing page calls "last synced". Money as plain strings. */
    async latestSettled(tenantId: string) {
      const row = await prisma.chargebeeSync.findFirst({
        where: { tenantId, status: SYNC.SUCCESS },
        orderBy: { settledAt: "desc" },
        select: { settledAt: true, toIngestedAt: true, billedUsd: true, amount: true, eventCount: true },
      });
      if (!row) return null;
      return {
        settledAt: row.settledAt,
        toIngestedAt: row.toIngestedAt,
        eventCount: row.eventCount,
        billedUsd: fromDb(row.billedUsd),
        amount: fromDb(row.amount),
      };
    },
  };
}

export type ChargebeeSyncRepository = ReturnType<typeof createChargebeeSyncRepository>;
