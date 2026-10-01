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
 *                        if no sync row already owns the window — never while
 *                        the account is `switching`
 *   restartCursorAt      forward only: a resubscription skips the cancelled gap
 *   linkSubscription     compare-and-set on the subscription the caller CHOSE
 *                        from: a sync that read the account before another
 *                        writer relinked it cannot put the old link back — and
 *                        never while the account is `switching`
 *   setStatusUnlessCancelled
 *                        never over `cancelled`: only a subscription link undoes
 *                        it — and never over `switching` either, unless the
 *                        currency switch itself says so
 *   markExhaustedUnlessCancelled
 *                        never over `cancelled` or `switching`
 *   takeTopUpCharge      under the account row's lock: a live account, no
 *                        currency switch blocking, no other charge on the wire
 *   releaseTopUpCharge   the charge lease is still THIS one
 */

import { prisma as defaultPrisma, type PrismaClient } from "../db/prisma";
import { ACCOUNT, type AccountStatus } from "../models/account-status";
import type { CurrencyRules } from "../models/currency";
import { BLOCKING_SWITCH, OPEN_SWITCH, STARTED_SWITCH, SWITCH } from "./currency-switch.repository";

export type BillingAccount = NonNullable<Awaited<ReturnType<PrismaClient["billingAccount"]["findUnique"]>>>;

export interface SubscriptionLink {
  chargebeeSubscriptionId: string;
  chargebeeItemPriceId?: string;
  ledgerUnitId: string | null;
  currentTermStart?: Date;
  currentTermEnd?: Date;
  /** The subscription's `currency_code` (ISO 4217). Undefined keeps the one stored. */
  currency?: string;
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

    /** The tenant whose CURRENT subscription this is; null for any other (an ended one, or no org's). */
    async findTenantIdBySubscriptionId(chargebeeSubscriptionId: string): Promise<string | null> {
      const account = await prisma.billingAccount.findFirst({
        where: { chargebeeSubscriptionId },
        select: { tenantId: true },
      });
      return account?.tenantId ?? null;
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

    /**
     * Link the account to a subscription — if and only if it is still linked
     * to `expectedSubscriptionId`, the one the caller chose FROM (null for a
     * first link), and is not `switching`. `linked` false means another writer
     * got there first and nothing was written; `account` is the row as it now
     * stands either way, null for a tenant with no row.
     *
     * A compare-and-set, because a sync is not one statement: it reads the
     * account and Chargebee's subscriptions, chooses, reads the balance, and
     * only then writes. MEASURED in a simulation of a currency switch: a sync
     * that read [B, A] while A was still active chose A, and wrote its link
     * AFTER a second sync, which read [B] once A was cancelled, had linked B —
     * leaving the account `active` on a cancelled subscription until the next
     * daily resync, with every window pinned to A and refused, and the gateway
     * cap rebuilt from A's grant. Compared against what the chooser saw, the
     * stale write matches nothing.
     *
     * `switching` is refused outright: while a currency switch is moving an
     * org's credits, only the switch itself relinks it (currency-switch
     * repository `link`), in the transaction that re-pins its held windows.
     */
    async linkSubscription(
      tenantId: string,
      expectedSubscriptionId: string | null,
      link: SubscriptionLink,
    ): Promise<{ linked: boolean; account: BillingAccount | null }> {
      const { count } = await prisma.billingAccount.updateMany({
        where: { tenantId, chargebeeSubscriptionId: expectedSubscriptionId, status: { not: ACCOUNT.SWITCHING } },
        data: link,
      });
      const account = await prisma.billingAccount.findUnique({ where: { tenantId } });
      return { linked: count === 1, account };
    },

    /**
     * The country of the billing address the org confirmed (ISO 3166-1
     * alpha-2, upper case — the column CHECKs it), or null to forget it.
     * Plain: the address is the org's to change whenever it likes, and what a
     * change does to its subscription is decided by the caller, not here.
     */
    setBillingCountry(tenantId: string, billingCountry: string | null) {
      return prisma.billingAccount.update({ where: { tenantId }, data: { billingCountry } });
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
     * subscription link (linkSubscription) may undo, or SWITCHING, which only
     * the currency switch may end (`overSwitching`).
     *
     * A compare-and-set, because the writers are not serialised: an activation
     * that read the account a moment before a cancellation landed would
     * otherwise write `active` over `cancelled`, and the usage sync would bill
     * a subscription Chargebee has ended until the next daily resync. The same
     * activation landing on an account a currency switch has just quiesced
     * would reopen it to the usage sync mid-move.
     *
     * `changed` false means the account was cancelled or switching and was
     * left so; `account` is the row as it now stands either way, and its
     * status says which. A caller that hands the team back on a refusal must
     * do so ONLY when it reads `cancelled`: a `switching` account's team keeps
     * its cap, so the org keeps working while its credits move. Throws for a
     * tenant with no row, as setStatus does.
     */
    async setStatusUnlessCancelled(
      tenantId: string,
      status: AccountStatus | string,
      { overSwitching = false }: { overSwitching?: boolean } = {},
    ) {
      const refused = overSwitching ? [ACCOUNT.CANCELLED] : [ACCOUNT.CANCELLED, ACCOUNT.SWITCHING];
      const { count } = await prisma.billingAccount.updateMany({
        where: { tenantId, status: { notIn: refused } },
        data: { status },
      });
      const account = await prisma.billingAccount.findUnique({ where: { tenantId } });
      if (!account) throw new Error(`No billing account for tenant ${tenantId}`);
      return { changed: count === 1, account };
    },

    /**
     * Record the credit unit of a wallet billing itself created (the free
     * plan's first allocate) — only on the subscription it was made on, and
     * only while the account has none: a unit already linked is never moved.
     */
    async adoptLedgerUnit(tenantId: string, chargebeeSubscriptionId: string, ledgerUnitId: string): Promise<boolean> {
      const { count } = await prisma.billingAccount.updateMany({
        where: { tenantId, chargebeeSubscriptionId, ledgerUnitId: null },
        data: { ledgerUnitId },
      });
      return count === 1;
    },

    /**
     * Take the top-up CHARGE lease: a top-up or a "Pay now" is about to charge
     * the card on the account's subscription. One transaction, under the
     * account row's lock:
     *
     *   1. lock the row — a write that changes nothing that matters — if the
     *      account is ACTIVE or EXHAUSTED. No: "account".
     *   2. no currency switch is blocking: REQUESTED, MOVING, or LINKED and not
     *      yet activated. One is: "switch".
     *   3. no other charge's lease is live. One is: "charging".
     *   4. the lease, until `now + ms`.
     *
     * A currency switch STARTS under the same lock, and refuses a live charge
     * lease (currency-switch repository `start`). So a charge either holds the
     * lease before a switch starts — the switch waits for it, and carries what
     * it granted — or finds the switch and charges nothing. Without it a pack
     * paid a second after the switch's last look at A landed on a subscription
     * about to be emptied and cancelled: paid for, never spendable.
     *
     * `duringRequestedSwitch`: a switch only REQUESTED does not refuse the
     * lease — for collecting a top-up already owed ("Pay now"), which such a
     * switch waits for before it starts, and cannot start under.
     */
    async takeTopUpCharge(
      tenantId: string,
      now: Date,
      ms: number,
      { duringRequestedSwitch = false }: { duringRequestedSwitch?: boolean } = {},
    ): Promise<{ taken: true; until: Date } | { taken: false; reason: "account" | "switch" | "charging" }> {
      return prisma.$transaction(async (tx) => {
        const locked = await tx.billingAccount.updateMany({
          where: { tenantId, status: { in: [ACCOUNT.ACTIVE, ACCOUNT.EXHAUSTED] } },
          data: { updatedAt: now },
        });
        if (locked.count !== 1) return { taken: false as const, reason: "account" as const };
        const refusing = duringRequestedSwitch ? STARTED_SWITCH : BLOCKING_SWITCH;
        if ((await tx.currencySwitch.count({ where: { tenantId, ...refusing } })) > 0) {
          return { taken: false as const, reason: "switch" as const };
        }
        const until = new Date(now.getTime() + ms);
        const leased = await tx.billingAccount.updateMany({
          where: { tenantId, OR: [{ topupChargingUntil: null }, { topupChargingUntil: { lte: now } }] },
          data: { topupChargingUntil: until },
        });
        return leased.count === 1 ? { taken: true as const, until } : { taken: false as const, reason: "charging" as const };
      });
    },

    /** The charge is done (or failed): clear its lease — only if it is still THIS one. */
    async releaseTopUpCharge(tenantId: string, until: Date): Promise<boolean> {
      const { count } = await prisma.billingAccount.updateMany({
        where: { tenantId, topupChargingUntil: until },
        data: { topupChargingUntil: null },
      });
      return count === 1;
    },

    /**
     * Every account `switching` — for the worker to find one a currency switch
     * left there with no switch still moving it (an abort that crashed between
     * its two writes), and put it back.
     */
    async listSwitchingTenantIds(): Promise<string[]> {
      const rows = await prisma.billingAccount.findMany({ where: { status: ACCOUNT.SWITCHING }, select: { tenantId: true } });
      return rows.map((r) => r.tenantId);
    },

    /**
     * Live accounts on a free plan whose stored currency is not the one their
     * confirmed billing country is billed in — and that no switch is moving,
     * or has just given up on (an ABANDONED one updated since
     * `abandonedSince`). What the worker requests a switch for, so a country
     * saved without its switch (a crash between the two, a refused request)
     * converges instead of offering top-ups in the wrong currency for ever.
     * Oldest tenant id first, at most `limit`.
     */
    listCurrencyMismatches({
      rules,
      freeItemPriceIds,
      abandonedSince,
      limit,
    }: {
      rules: CurrencyRules;
      freeItemPriceIds: string[];
      abandonedSince: Date;
      limit: number;
    }) {
      const mapped = Object.entries(rules.byCountry);
      return prisma.billingAccount.findMany({
        where: {
          status: { in: [ACCOUNT.ACTIVE, ACCOUNT.EXHAUSTED] },
          chargebeeSubscriptionId: { not: null },
          chargebeeItemPriceId: { in: freeItemPriceIds },
          billingCountry: { not: null },
          currency: { not: null },
          OR: [
            ...mapped.map(([country, currency]) => ({ billingCountry: country, currency: { not: currency } })),
            { billingCountry: { notIn: mapped.map(([country]) => country) }, currency: { not: rules.defaultCurrency } },
          ],
          switches: {
            none: {
              OR: [{ status: { in: [...OPEN_SWITCH] } }, { status: SWITCH.ABANDONED, updatedAt: { gt: abandonedSince } }],
            },
          },
        },
        orderBy: { tenantId: "asc" },
        take: limit,
      });
    },

    /** Turn the free plan on or off for one org. Its subscription is not touched. */
    setFreePlan(tenantId: string, freePlan: boolean) {
      return prisma.billingAccount.update({ where: { tenantId }, data: { freePlan } });
    },

    /**
     * Out of credits — but a cancelled account stays cancelled, and a
     * switching one switching: its balance is the currency switch's to move,
     * and the switch decides what the account is once it has. False when it
     * was either; the caller then does nothing.
     */
    async markExhaustedUnlessCancelled(tenantId: string): Promise<boolean> {
      const { count } = await prisma.billingAccount.updateMany({
        where: { tenantId, status: { notIn: [ACCOUNT.CANCELLED, ACCOUNT.SWITCHING] } },
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
     *
     * Refused while the account is `switching`, like every other step of the
     * usage sync: the switch never moves the cursor, and nothing else may
     * while it runs.
     */
    advancePastEmptyWindow(tenantId: string, from: Date, to: Date) {
      return prisma.$transaction(async (tx) => {
        const held = await tx.billingAccount.updateMany({
          where: { tenantId, lastProcessedIngestedAt: from, status: { not: ACCOUNT.SWITCHING } },
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
     *
     * Only while the account is STILL cancelled and still linked to
     * `expectedSubscriptionId` — the state the resubscribing sync read. A sync
     * held up after that read (a slow balance call) while another relinked
     * the account and billing resumed would otherwise jump the live cursor
     * past usage not yet billed; it loses the link race too
     * (linkSubscription), and so changes nothing at all.
     */
    async restartCursorAt(tenantId: string, at: Date, expectedSubscriptionId: string | null): Promise<boolean> {
      const { count } = await prisma.billingAccount.updateMany({
        where: {
          tenantId,
          status: ACCOUNT.CANCELLED,
          chargebeeSubscriptionId: expectedSubscriptionId,
          OR: [{ lastProcessedIngestedAt: null }, { lastProcessedIngestedAt: { lt: at } }],
        },
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
