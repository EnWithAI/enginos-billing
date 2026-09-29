/**
 * `billing_account` — which Chargebee customer and subscription a tenant is,
 * its operational status, and the usage cursor.
 *
 * Every write that carries a correctness guarantee is a named method here, so
 * the guarantee lives next to the SQL that provides it:
 *
 *   layCursorIfMissing   create-only (`IS NULL`): a replay can never rewind billing
 *   advanceCursor        compare-and-set: a stale worker can never rewind it either
 *   advancePastEmptyWindow
 *                        compare-and-set, under the account row's lock, and only
 *                        if no sync row already owns the window
 *   restartCursorAt      forward only: a resubscription skips the cancelled gap
 *   setStatusUnlessCancelled
 *                        never over `cancelled`: only a subscription link undoes it
 */

import { prisma as defaultPrisma, type PrismaClient } from "../db/prisma";
import { ACCOUNT, type AccountStatus } from "../models/account-status";

export type BillingAccount = NonNullable<Awaited<ReturnType<PrismaClient["billingAccount"]["findUnique"]>>>;

export interface SubscriptionLink {
  chargebeeSubscriptionId: string;
  chargebeeItemPriceId?: string;
  ledgerUnitId: string | null;
  currentTermStart?: Date;
  currentTermEnd?: Date;
  status: string;
}

export function createBillingAccountRepository(prisma: PrismaClient = defaultPrisma) {
  return {
    findByTenantId(tenantId: string) {
      return prisma.billingAccount.findUnique({ where: { tenantId } });
    },

    findBySlug(routingSlug: string) {
      return prisma.billingAccount.findUnique({ where: { routingSlug } });
    },

    async findTenantIdByCustomerId(chargebeeCustomerId: string): Promise<string | null> {
      const account = await prisma.billingAccount.findUnique({
        where: { chargebeeCustomerId },
        select: { tenantId: true },
      });
      return account?.tenantId ?? null;
    },

    /**
     * The local row for a tenant that has only looked at billing. A concurrent
     * request may create it first; the upsert makes that a no-op rather than a
     * unique violation.
     */
    createUnlinked(tenantId: string, routingSlug: string) {
      return prisma.billingAccount.upsert({
        where: { tenantId },
        create: { tenantId, routingSlug, status: ACCOUNT.UNLINKED },
        update: {},
      });
    },

    upsertCustomer(args: { tenantId: string; routingSlug: string; billingEmail?: string }) {
      return prisma.billingAccount.upsert({
        where: { tenantId: args.tenantId },
        create: {
          tenantId: args.tenantId,
          routingSlug: args.routingSlug,
          billingEmail: args.billingEmail ?? null,
          status: ACCOUNT.UNLINKED,
        },
        update: { routingSlug: args.routingSlug, billingEmail: args.billingEmail ?? undefined },
      });
    },

    setCustomerId(tenantId: string, chargebeeCustomerId: string) {
      return prisma.billingAccount.update({ where: { tenantId }, data: { chargebeeCustomerId } });
    },

    linkSubscription(tenantId: string, link: SubscriptionLink) {
      return prisma.billingAccount.update({ where: { tenantId }, data: link });
    },

    /**
     * Unconditional. Only cancel() uses it: a cancellation must land whatever
     * the account said before. Every other status write goes through
     * setStatusUnlessCancelled.
     */
    setStatus(tenantId: string, status: AccountStatus | string) {
      return prisma.billingAccount.update({ where: { tenantId }, data: { status } });
    },

    /**
     * Move an account to `status` — unless it is CANCELLED, which only a
     * subscription link (linkSubscription) may undo.
     *
     * A compare-and-set, because the writers are not serialised: an activation
     * that read the account a moment before a cancellation landed would
     * otherwise write `active` over `cancelled`, and the usage sync would bill
     * a subscription Chargebee has ended until the next daily resync. `changed`
     * false means the account was cancelled and was left so; `account` is the
     * row as it now stands either way. Throws for a tenant with no row, as
     * setStatus does.
     */
    async setStatusUnlessCancelled(tenantId: string, status: AccountStatus | string) {
      const { count } = await prisma.billingAccount.updateMany({
        where: { tenantId, status: { not: ACCOUNT.CANCELLED } },
        data: { status },
      });
      const account = await prisma.billingAccount.findUnique({ where: { tenantId } });
      if (!account) throw new Error(`No billing account for tenant ${tenantId}`);
      return { changed: count === 1, account };
    },

    /** Turn the free plan on or off for one org. Its subscription is not touched. */
    setFreePlan(tenantId: string, freePlan: boolean) {
      return prisma.billingAccount.update({ where: { tenantId }, data: { freePlan } });
    },

    /** Out of credits — but a cancelled account stays cancelled. False when it was cancelled. */
    async markExhaustedUnlessCancelled(tenantId: string): Promise<boolean> {
      const { count } = await prisma.billingAccount.updateMany({
        where: { tenantId, status: { not: ACCOUNT.CANCELLED } },
        data: { status: ACCOUNT.EXHAUSTED },
      });
      return count === 1;
    },

    /** CREATE-ONLY. True when this call laid the cursor; false when one was already there. */
    async layCursorIfMissing(tenantId: string, at: Date): Promise<boolean> {
      const { count } = await prisma.billingAccount.updateMany({
        where: { tenantId, lastProcessedIngestedAt: null },
        data: { lastProcessedIngestedAt: at },
      });
      return count === 1;
    },

    /** Compare-and-set from `from` to `to`. False means someone else already moved it. */
    async advanceCursor(tenantId: string, from: Date, to: Date): Promise<boolean> {
      const { count } = await prisma.billingAccount.updateMany({
        where: { tenantId, lastProcessedIngestedAt: from },
        data: { lastProcessedIngestedAt: to },
      });
      return count === 1;
    },

    /**
     * Move the cursor over a window that held no usage, unless a sync row
     * already owns a window starting here. `owner` is that row when one does.
     *
     * An empty window leaves no row, so on its own nothing would stop this
     * racing a worker with a LONGER window that has just written its row at
     * the same start: the cursor would land inside that row's range, and the
     * next window would bill part of it again. The first statement locks the
     * account row (the same compare-and-set-onto-itself `openWindow` uses), so
     * the look for an owner runs after any such insert has committed — or the
     * insert runs after this has moved the cursor, and finds it gone.
     */
    advancePastEmptyWindow(tenantId: string, from: Date, to: Date) {
      return prisma.$transaction(async (tx) => {
        const held = await tx.billingAccount.updateMany({
          where: { tenantId, lastProcessedIngestedAt: from },
          data: { lastProcessedIngestedAt: from },
        });
        if (held.count !== 1) return { moved: false, owner: null };

        // Only what the caller needs to step over it — not the money columns,
        // which leave the database only through chargebee-sync.repository.ts.
        const owner = await tx.chargebeeSync.findFirst({
          where: { tenantId, fromIngestedAt: from },
          select: { id: true, status: true, toIngestedAt: true, eventCount: true },
        });
        if (owner) return { moved: false, owner };

        const { count } = await tx.billingAccount.updateMany({
          where: { tenantId, lastProcessedIngestedAt: from },
          data: { lastProcessedIngestedAt: to },
        });
        return { moved: count === 1, owner: null };
      });
    },

    /**
     * Start billing again from `at`, for an account coming back from a
     * cancellation. FORWARD ONLY: a cursor already past `at` is left alone.
     *
     * The exception to create-only, and a narrow one. While an account is
     * cancelled its cursor is frozen where the cancellation found it, and every
     * span ingested since is free-plan usage — no subscription existed to pay
     * for it. Carrying on from the frozen cursor would bill all of it against
     * the NEW subscription on the first tick.
     */
    async restartCursorAt(tenantId: string, at: Date): Promise<boolean> {
      const { count } = await prisma.billingAccount.updateMany({
        where: { tenantId, OR: [{ lastProcessedIngestedAt: null }, { lastProcessedIngestedAt: { lt: at } }] },
        data: { lastProcessedIngestedAt: at },
      });
      return count === 1;
    },

    async listActivatingTenantIds(): Promise<string[]> {
      const rows = await prisma.billingAccount.findMany({
        where: { status: ACCOUNT.ACTIVATING },
        select: { tenantId: true },
      });
      return rows.map((r) => r.tenantId);
    },

    async listActiveTenantIds(): Promise<string[]> {
      const rows = await prisma.billingAccount.findMany({
        where: { status: ACCOUNT.ACTIVE },
        select: { tenantId: true },
      });
      return rows.map((r) => r.tenantId);
    },

    /**
     * Every tenant with a Chargebee customer — linked or not. A customer exists
     * only once checkout has started, so this is every tenant that has tried to
     * pay, including one whose subscription never reached us.
     */
    async listCustomerTenantIds(): Promise<string[]> {
      const rows = await prisma.billingAccount.findMany({
        where: { chargebeeCustomerId: { not: null } },
        select: { tenantId: true },
      });
      return rows.map((r) => r.tenantId);
    },

    listBySlugs(routingSlugs: string[]) {
      return prisma.billingAccount.findMany({ where: { routingSlug: { in: routingSlugs } } });
    },

    /**
     * Every account the usage sync should visit: billable ones, plus any tenant
     * still holding an unresolved sync whatever its status now.
     */
    listBillable(heldTenantIds: string[]) {
      return prisma.billingAccount.findMany({
        where: {
          OR: [
            { status: { in: [ACCOUNT.ACTIVE, ACCOUNT.EXHAUSTED] }, chargebeeSubscriptionId: { not: null } },
            { tenantId: { in: heldTenantIds } },
          ],
        },
      });
    },
  };
}

export type BillingAccountRepository = ReturnType<typeof createBillingAccountRepository>;
