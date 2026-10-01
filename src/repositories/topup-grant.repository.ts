/**
 * `topup_grant` — one row per paid top-up invoice, the guard that grants a
 * paid pack exactly once.
 *
 * Every write that changes what a row SAYS is a compare-and-set, as in
 * chargebee-sync.repository.ts, and each one names what it compares:
 *
 *   claim             nobody has a row for this invoice yet (the unique index
 *                     `topup_grant_invoice_uq` refuses a second one)
 *   takeAttempt       the row is still exactly as it was read (status and
 *                     attempt count) — so two callers that both find it
 *                     PENDING cannot both send it
 *   markApplied /     the row is still SENDING under THIS attempt — so a caller
 *   markUnresolved    whose attempt was taken over cannot overwrite what the
 *                     new owner recorded, and APPLIED is never undone
 *
 * Money leaves this file as plain decimal strings (see fromDb()).
 */

import { isUniqueViolation, prisma as defaultPrisma, type PrismaClient } from "../db/prisma";
import { fromDb } from "../models/decimal";

type TopUpGrantRow = NonNullable<Awaited<ReturnType<PrismaClient["topUpGrant"]["findFirst"]>>>;

export type TopUpGrant = Omit<TopUpGrantRow, "credits"> & { credits: string };

export const TOPUP = {
  /** Claimed; an allocate is on the wire under this attempt. */
  SENDING: "SENDING",
  /** An allocate may have landed; the outcome is not known. Retried, never forgotten. */
  PENDING: "PENDING",
  /** Granted: by our allocate, or by Chargebee's own Credit Grant. */
  APPLIED: "APPLIED",
} as const;

export const TOPUP_SOURCE = {
  ALLOCATION: "allocation",
  CATALOGUE_GRANT: "catalogue_grant",
} as const;

/**
 * The row that grants the free plan's credits (`FREE_PLAN_CREDITS`), stored
 * under this in place of an invoice id — so the unique index allows one per
 * tenant, ever, and the rest of the guard treats it exactly as a pack.
 */
export const FREE_PLAN_GRANT = "free-plan-credits";

/** One caller's right to send a row's allocate: which row, and the attempt it claimed. */
export interface TopUpAttempt {
  id: string;
  attemptCount: number;
}

export interface NewTopUpClaim {
  tenantId: string;
  invoiceId: string;
  chargebeeSubscriptionId: string;
  ledgerUnitId: string;
  credits: string;
  expiresAt: Date;
  idempotencyKey: string;
  at: Date;
}

function toGrant(row: TopUpGrantRow): TopUpGrant;
function toGrant(row: TopUpGrantRow | null): TopUpGrant | null;
function toGrant(row: TopUpGrantRow | null): TopUpGrant | null {
  if (!row) return null;
  return { ...row, credits: fromDb(row.credits) };
}

export function createTopUpGrantRepository(prisma: PrismaClient = defaultPrisma) {
  return {
    /** The rows for these invoices, keyed by invoice id. */
    async forInvoices(tenantId: string, invoiceIds: string[]): Promise<Map<string, TopUpGrant>> {
      if (invoiceIds.length === 0) return new Map();
      const rows = await prisma.topUpGrant.findMany({ where: { tenantId, invoiceId: { in: invoiceIds } } });
      return new Map(rows.map((row) => [row.invoiceId, toGrant(row)]));
    },

    async findByInvoice(tenantId: string, invoiceId: string): Promise<TopUpGrant | null> {
      return toGrant(await prisma.topUpGrant.findFirst({ where: { tenantId, invoiceId } }));
    },

    /**
     * Every row whose invoice id starts with `prefix` — a currency switch's
     * carry rows are `carry:<switch id>:<grant block id>`, and what the switch
     * carried is the sum of those APPLIED.
     */
    async withInvoicePrefix(tenantId: string, prefix: string): Promise<TopUpGrant[]> {
      const rows = await prisma.topUpGrant.findMany({ where: { tenantId, invoiceId: { startsWith: prefix } } });
      return rows.map((row) => toGrant(row));
    },

    /**
     * How many of the tenant's grants are not settled — SENDING or PENDING, an
     * allocate that may yet land. A currency switch does not start over one:
     * it would land on the subscription the switch is emptying.
     */
    countUnresolved(tenantId: string): Promise<number> {
      return prisma.topUpGrant.count({ where: { tenantId, status: { in: [TOPUP.SENDING, TOPUP.PENDING] } } });
    },

    /**
     * Allocations this service has made and seen land, for a subscription and
     * unit — what the evidence check subtracts, so a grant block of ANOTHER
     * invoice's allocation is not mistaken for this one's.
     */
    async appliedAllocations(tenantId: string, chargebeeSubscriptionId: string, ledgerUnitId: string): Promise<TopUpGrant[]> {
      const rows = await prisma.topUpGrant.findMany({
        where: {
          tenantId,
          chargebeeSubscriptionId,
          ledgerUnitId,
          status: TOPUP.APPLIED,
          source: TOPUP_SOURCE.ALLOCATION,
        },
      });
      return rows.map((row) => toGrant(row));
    },

    /**
     * Claim an invoice for its FIRST send: the row, with the whole request,
     * committed before the allocate leaves. Null when a row for this invoice
     * already exists — another caller has it, and that caller sends it.
     */
    async claim(data: NewTopUpClaim): Promise<TopUpGrant | null> {
      try {
        const row = await prisma.topUpGrant.create({
          data: {
            tenantId: data.tenantId,
            invoiceId: data.invoiceId,
            chargebeeSubscriptionId: data.chargebeeSubscriptionId,
            ledgerUnitId: data.ledgerUnitId,
            credits: data.credits,
            expiresAt: data.expiresAt,
            idempotencyKey: data.idempotencyKey,
            keyIssuedAt: data.at,
            status: TOPUP.SENDING,
            source: TOPUP_SOURCE.ALLOCATION,
            attemptCount: 1,
            createdAt: data.at,
            updatedAt: data.at,
          },
        });
        return toGrant(row);
      } catch (err) {
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },

    /**
     * Record a pack Chargebee granted by itself (its item price carries a
     * Credit Grant). Nothing is sent, so it is APPLIED from the start, with the
     * grant block as the proof. False when a row for the invoice already exists.
     */
    async recordCatalogueGrant(data: {
      tenantId: string;
      invoiceId: string;
      chargebeeSubscriptionId: string;
      ledgerUnitId: string;
      credits: string;
      grantBlockId: string;
      at: Date;
    }): Promise<boolean> {
      try {
        await prisma.topUpGrant.create({
          data: {
            tenantId: data.tenantId,
            invoiceId: data.invoiceId,
            chargebeeSubscriptionId: data.chargebeeSubscriptionId,
            ledgerUnitId: data.ledgerUnitId,
            credits: data.credits,
            status: TOPUP.APPLIED,
            source: TOPUP_SOURCE.CATALOGUE_GRANT,
            chargebeeRef: `grant_block:${data.grantBlockId}`,
            attemptCount: 0,
            createdAt: data.at,
            updatedAt: data.at,
            appliedAt: data.at,
          },
        });
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },

    /**
     * Take a SENDING/PENDING row for one more send — if and only if it is still
     * exactly as it was read. `reissue` replaces the idempotency key (and its
     * issue time) once Chargebee no longer replays the old one, and with it the
     * request's `expires_at`: a new key may carry a new body, and the stored
     * one may have gone stale. Null when another caller changed the row first.
     */
    async takeAttempt(
      row: Pick<TopUpGrant, "id" | "status" | "attemptCount">,
      at: Date,
      reissue?: { idempotencyKey: string; expiresAt: Date },
    ): Promise<TopUpAttempt | null> {
      const attemptCount = row.attemptCount + 1;
      const { count } = await prisma.topUpGrant.updateMany({
        where: { id: row.id, status: row.status, attemptCount: row.attemptCount },
        data: {
          status: TOPUP.SENDING,
          attemptCount,
          updatedAt: at,
          ...(reissue ? { idempotencyKey: reissue.idempotencyKey, expiresAt: reissue.expiresAt, keyIssuedAt: at } : {}),
        },
      });
      return count === 1 ? { id: row.id, attemptCount } : null;
    },

    /**
     * Granted. False when the attempt was taken over; whoever holds it records it.
     * `operationAt` is when Chargebee made the grant, when it said.
     */
    async markApplied(attempt: TopUpAttempt, chargebeeRef: string, at: Date, operationAt: Date | null = null): Promise<boolean> {
      const { count } = await prisma.topUpGrant.updateMany({
        where: { id: attempt.id, status: TOPUP.SENDING, attemptCount: attempt.attemptCount },
        data: { status: TOPUP.APPLIED, chargebeeRef, operationAt, appliedAt: at, error: null, updatedAt: at },
      });
      return count === 1;
    },

    /**
     * Fill in when an APPLIED allocation's grant was made, read back from
     * Chargebee by operation id. Only ever fills a gap: a time already
     * recorded is never replaced.
     */
    async recordOperationAt(id: string, operationAt: Date): Promise<void> {
      await prisma.topUpGrant.updateMany({
        where: { id, status: TOPUP.APPLIED, operationAt: null },
        data: { operationAt },
      });
    },

    /**
     * Resolved without a send: the allocation is found among the
     * subscription's grant blocks. Compare-and-set on the row as read.
     */
    async markAppliedFromEvidence(
      row: Pick<TopUpGrant, "id" | "status" | "attemptCount">,
      chargebeeRef: string,
      at: Date,
      operationAt: Date | null = null,
    ): Promise<boolean> {
      const { count } = await prisma.topUpGrant.updateMany({
        where: { id: row.id, status: row.status, attemptCount: row.attemptCount },
        data: { status: TOPUP.APPLIED, chargebeeRef, operationAt, appliedAt: at, error: null, updatedAt: at },
      });
      return count === 1;
    },

    /** The send failed or its answer was lost: the allocate MAY have landed. */
    async markUnresolved(attempt: TopUpAttempt, error: string, at: Date): Promise<boolean> {
      const { count } = await prisma.topUpGrant.updateMany({
        where: { id: attempt.id, status: TOPUP.SENDING, attemptCount: attempt.attemptCount },
        data: { status: TOPUP.PENDING, error, updatedAt: at },
      });
      return count === 1;
    },
  };
}

export type TopUpGrantRepository = ReturnType<typeof createTopUpGrantRepository>;
