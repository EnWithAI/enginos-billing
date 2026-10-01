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
 *   openWindow       the cursor is still at the window's start, the account
 *                    is still on the subscription and unit the row is pinned
 *                    to, and it is not `switching` (and holds the account row
 *                    while the window is written)
 *   claim            the row is still in the state it was read in, pinned
 *                    where it was read — and the account is not `switching`,
 *                    checked under the account row's lock
 *   markSuccess /    the row is still PROCESSING under THIS claim — so a
 *   markUnresolved   caller whose claim was taken over cannot overwrite the
 *                    answer the new owner wrote, and a SUCCESS is never
 *                    turned back into anything else
 *   writeOff         the row is still the refusal it was read as, pinned where
 *                    it was read — and its subscription has ENDED by the
 *                    account as it now stands, checked under the account
 *                    row's lock (cancelled, or moved off and not `switching`)
 *   repointHeld      only rows NEVER APPLIED on the old subscription, inside
 *                    the currency switch's link transaction
 */

import { prisma as defaultPrisma, type PrismaClient, type TransactionClient } from "../db/prisma";
import { ACCOUNT } from "../models/account-status";
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

/**
 * Unresolved rows that Chargebee has provably NEVER APPLIED: PENDING was never
 * sent, and OUT_OF_CREDITS and INVALID were refused. Only these may move to
 * another subscription (repointHeld).
 *
 * Not RATE_LIMITING. A 429 on the capture itself proves nothing landed, but
 * the row does not say which call was throttled — and a recovery's LOOKUP
 * throttled after a capture whose answer was lost leaves a row that DID land
 * as RATE_LIMITING (reproduced with the harness: lose the response, then
 * throttle the lookup). It is settled where it was sent, like PROCESSING and
 * UNKNOWN, by lookup.
 */
const NEVER_APPLIED = [SYNC.PENDING, SYNC.OUT_OF_CREDITS, SYNC.INVALID];

/** On the wire, or of unknown outcome: what a currency switch must wait out before it starts (see NEVER_APPLIED). */
const IN_FLIGHT = [SYNC.PROCESSING, SYNC.UNKNOWN, SYNC.RATE_LIMITING];

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
     * different lengths — which is what two workers reading the same cursor a
     * moment apart produce, since a range runs to `now − lag`. One could move
     * the cursor over an empty first minute and bill the second, while the
     * other, which read the cursor before that, went on to bill both minutes
     * under another id: the second minute, twice.
     *
     * The first statement is a compare-and-set of the cursor onto itself, which
     * both checks it and LOCKS the account row until the insert commits. The
     * empty-window advance takes the same lock (billing-account.repository.ts
     * advancePastEmptyWindow), so the two serialise: either the cursor has
     * already moved and this returns null, or the row exists before the other
     * side looks for one.
     *
     * The same statement compares the row's PINS — the subscription and unit
     * the window will be sent to — with the account's, and refuses an account
     * that is `switching`. A pass reads the account once and opens windows
     * from that read for up to three minutes; MEASURED in a simulation of a
     * currency switch, a pass that read A went on opening and capturing
     * windows pinned to A after the account had been relinked to B: usage
     * written off when A refused it, or paid twice from credits already
     * carried to B. Compared under the lock, a stale pass gets null and backs
     * off; the next pass reads B.
     */
    async openWindow(data: NewWindowSync): Promise<ChargebeeSync | null> {
      const row = await prisma.$transaction(async (tx) => {
        const held = await tx.billingAccount.updateMany({
          where: {
            tenantId: data.tenantId,
            lastProcessedIngestedAt: data.fromIngestedAt,
            status: { not: ACCOUNT.SWITCHING },
            chargebeeSubscriptionId: data.chargebeeSubscriptionId,
            ledgerUnitId: data.ledgerUnitId,
          },
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
     * first, and that caller is the one sending it — or when the account is
     * `switching`, and nothing is sent at all.
     *
     * Committed BEFORE the request leaves, so a row still PENDING has provably
     * never been sent. The compare-and-set is what keeps that true with more
     * than one caller: two that read the same PENDING row both try to claim it,
     * and only one of them gets to send. It compares the row's PINS as read
     * too, so a caller holding the row from before a currency switch re-pinned
     * it to the new subscription cannot send it to the old one.
     *
     * A TRANSACTION, opened by a write to the account row: it takes that row's
     * lock, and refuses an account that is `switching`. A currency switch
     * starts by flipping the account to `switching` under the same lock and
     * only then looks for rows on the wire (PROCESSING, UNKNOWN). So a claim
     * either committed first — the switch sees it PROCESSING and waits for it
     * to settle — or runs after, sees `switching`, and sends nothing. Without
     * the lock a claim could slip between the switch's look and its flip, and
     * capture on the old subscription credits already counted for the new one.
     */
    async claim(
      row: Pick<ChargebeeSync, "id" | "tenantId" | "status" | "attemptCount" | "chargebeeSubscriptionId" | "ledgerUnitId">,
    ): Promise<SyncClaim | null> {
      const attemptCount = row.attemptCount + 1;
      return prisma.$transaction(async (tx) => {
        const account = await tx.billingAccount.updateMany({
          where: { tenantId: row.tenantId, status: { not: ACCOUNT.SWITCHING } },
          data: { updatedAt: new Date() },
        });
        if (account.count !== 1) return null;
        const { count } = await tx.chargebeeSync.updateMany({
          where: {
            id: row.id,
            status: row.status,
            attemptCount: row.attemptCount,
            chargebeeSubscriptionId: row.chargebeeSubscriptionId,
            ledgerUnitId: row.ledgerUnitId,
          },
          // Explicit, not left to @updatedAt: the claim's time IS the lease.
          data: { status: SYNC.PROCESSING, attemptCount, updatedAt: new Date() },
        });
        return count === 1 ? { id: row.id, attemptCount } : null;
      });
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
     * it is still exactly as it was read, pinned where it was read, so a
     * caller that has just claimed it keeps it. False when someone else
     * changed it first, or the row's subscription has not ended after all.
     *
     * Decided against the account AS IT NOW STANDS, under its row lock — not
     * the copy the caller read. "Ended" means the account is cancelled, or it
     * bills another subscription than the row's and is not `switching`. A
     * usage pass can hold a stale copy for minutes (two LiteLLM calls while it
     * blocks an exhausted team), long enough for a currency switch to
     * re-pin this very row to the new subscription; judged on that copy, the
     * re-pinned row read as "pinned to a subscription the account left" and
     * its usage was written off, never billed. Under the lock, the switch's
     * link transaction has either committed — the row now matches the
     * account — or not begun.
     */
    async writeOff(
      row: Pick<ChargebeeSync, "id" | "tenantId" | "status" | "attemptCount" | "chargebeeSubscriptionId">,
      reason: string,
    ): Promise<boolean> {
      // A row pinned to nothing (from before rows were pinned) bills whatever
      // the account bills: only a cancellation ends it, as usage-sync's
      // pinnedToLinked says. Spelled out for NULL, which `<>` never matches.
      const movedOff =
        row.chargebeeSubscriptionId == null
          ? []
          : [
              { status: { not: ACCOUNT.SWITCHING }, chargebeeSubscriptionId: null },
              { status: { not: ACCOUNT.SWITCHING }, chargebeeSubscriptionId: { not: row.chargebeeSubscriptionId } },
            ];
      return prisma.$transaction(async (tx) => {
        const ended = await tx.billingAccount.updateMany({
          where: { tenantId: row.tenantId, OR: [{ status: ACCOUNT.CANCELLED }, ...movedOff] },
          data: { updatedAt: new Date() },
        });
        if (ended.count !== 1) return false;
        const { count } = await tx.chargebeeSync.updateMany({
          where: {
            id: row.id,
            status: row.status,
            attemptCount: row.attemptCount,
            chargebeeSubscriptionId: row.chargebeeSubscriptionId,
          },
          data: { status: SYNC.WRITTEN_OFF, error: reason, settledAt: null, updatedAt: new Date() },
        });
        return count === 1;
      });
    },

    /**
     * Move a currency switch's held windows from the old subscription to the
     * new one: every unresolved row of the tenant pinned to `fromSubscriptionId`
     * that Chargebee has NEVER APPLIED (PENDING, RATE_LIMITING, OUT_OF_CREDITS,
     * INVALID) is pinned to `toSubscriptionId` and `ledgerUnitId`, as it
     * stands — same id, same window, same amount — and is billed there by the
     * ordinary recovery. The number moved.
     *
     * Only inside the switch's link transaction (`tx`), with the account row
     * locked and `switching`, so no claim can be sending one meanwhile. Without
     * it a refused window on the old subscription is written off once the
     * account moves (usage-sync.service.ts abandoned) — usage the org had
     * incurred, never billed. PROCESSING and UNKNOWN rows are never moved: they
     * may have landed on the old subscription, and the switch does not start
     * while there are any (countInFlight).
     */
    async repointHeld(
      tx: TransactionClient,
      args: { tenantId: string; fromSubscriptionId: string; toSubscriptionId: string; ledgerUnitId: string | null },
    ): Promise<number> {
      const { count } = await tx.chargebeeSync.updateMany({
        where: { tenantId: args.tenantId, chargebeeSubscriptionId: args.fromSubscriptionId, status: { in: NEVER_APPLIED } },
        data: { chargebeeSubscriptionId: args.toSubscriptionId, ledgerUnitId: args.ledgerUnitId },
      });
      return count;
    },

    /**
     * The tenant's rows on the wire or of unknown outcome (PROCESSING,
     * UNKNOWN). A currency switch starts only when this is zero, read inside
     * its start transaction under the account row's lock — see claim.
     */
    countInFlight(tx: TransactionClient, tenantId: string): Promise<number> {
      return tx.chargebeeSync.count({ where: { tenantId, status: { in: IN_FLIGHT } } });
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
