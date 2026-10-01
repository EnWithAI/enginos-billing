/**
 * `currency_switch` — one row per currency switch, and the stored request for
 * each money movement of it (see the model in schema.prisma, and
 * services/currency-switch.service.ts for the state machine).
 *
 * THE LEASE FENCES EVERY WRITE. An advancer takes the switch's lease
 * (takeLease), which names it as the `lease_owner`; every write that advances
 * the switch is then a compare-and-set on the switch's expected status AND on
 * that owner. An advancer whose lease ran out and was taken over — a paused
 * process, a slow Chargebee call outliving its deadline — therefore writes
 * nothing more, whatever it learns: two advancers can never both record a
 * drain, settle the same one twice, or move a switch another has abandoned.
 * The lease is long (SWITCH_LEASE_MS) because it must outlive any ONE step; a
 * request's deadline only stops an advancer STARTING a step.
 *
 * Each compare-and-set, and what it compares (besides the lease):
 *
 *   create             no switch of the tenant is open — the partial unique
 *                      index `currency_switch_open_uq` refuses a second one
 *   takeLease          the switch is open and nobody holds it, or the lease
 *                      ran out
 *   releaseLease       the lease is still THIS one
 *   abandonIfRequested still REQUESTED (no lease: the address change that
 *                      makes a requested switch moot does not hold one)
 *   setToSubscription  B is not recorded yet (REQUESTED or MOVING)
 *   start              (one transaction, under the account row's lock) still
 *                      REQUESTED; the account active or exhausted on A with no
 *                      top-up charge on the wire; its billing country still
 *                      wants this currency (else the switch is abandoned);
 *                      none of its captures on the wire or unsure — then
 *                      MOVING and the account `switching`, together
 *   recordHeldBack     before anything is drained, once
 *   recordDrain        MOVING, no drain outstanding
 *   settleDrain /      the outstanding drain is still THIS one
 *   dropDrain
 *   recordOwnGrant     before the mirror, once
 *   recordMirror       MOVING, no drain outstanding, no mirror recorded
 *   settleMirror       the mirror recorded is THIS one, and has not settled
 *   link               (one transaction, under the account row's lock) the
 *                      account `switching` on A, the switch MOVING to THIS B
 *                      with nothing in flight — then the account on B, its
 *                      held windows re-pinned, LINKED, together
 *   markActivated      LINKED, not activated yet
 *   markDone           LINKED and activated
 *   abandonRequested   REQUESTED
 *   abort              MOVING, nothing drained or outstanding, and no carry
 *                      of it APPLIED (checked in the same transaction)
 *
 * Each transaction here CHECKS before it WRITES: its first statement locks the
 * account row with a write that changes nothing that matters (`updated_at`),
 * every condition is read under that lock, and the writes that change state
 * come last, when none of them can be refused. So no expected outcome depends
 * on a rollback — the same shape as chargebee-sync openWindow.
 *
 * Money leaves this file as plain decimal strings (see fromDb()).
 */

import { randomUUID } from "node:crypto";

import { isUniqueViolation, prisma as defaultPrisma, type PrismaClient } from "../db/prisma";
import { ACCOUNT } from "../models/account-status";
import { currencyForCountry, type CurrencyRules } from "../models/currency";
import { decimal, fromDb, isPositive } from "../models/decimal";
import type { BillingAccount } from "./billing-account.repository";
import { createChargebeeSyncRepository } from "./chargebee-sync.repository";
import { TOPUP } from "./topup-grant.repository";

type CurrencySwitchRow = NonNullable<Awaited<ReturnType<PrismaClient["currencySwitch"]["findFirst"]>>>;

const AMOUNTS = ["drained", "heldBack", "ownGrant", "drainAmount", "mirrorAmount"] as const;

/** A switch as the rest of the service sees it: its amounts as plain decimal strings, never Prisma Decimals. */
export type CurrencySwitch = Omit<CurrencySwitchRow, (typeof AMOUNTS)[number]> & {
  drained: string;
  heldBack: string;
  ownGrant: string;
  drainAmount: string | null;
  mirrorAmount: string | null;
};

export const SWITCH = {
  /** Asked for. Nothing has changed on the account; B may already have been made (unlinked, harmless). */
  REQUESTED: "REQUESTED",
  /** The account is `switching`: credits are being carried to B, A drained, B mirrored. */
  MOVING: "MOVING",
  /** Billing points at B. The cap is moved to B (activated_at), then A is cancelled. */
  LINKED: "LINKED",
  DONE: "DONE",
  /** Given up before anything moved: the address changed back, the org was cancelled, a step was refused. */
  ABANDONED: "ABANDONED",
} as const;

/** A switch still to finish. At most one per tenant (`currency_switch_open_uq`). */
export const OPEN_SWITCH = [SWITCH.REQUESTED, SWITCH.MOVING, SWITCH.LINKED] as const;

/**
 * A switch that blocks top-ups and address edits: one not started yet, one
 * moving credits, and one linked whose cap has not moved to B. Once ACTIVATED
 * what is left — cancelling A — is a background chore, and blocks nothing. A
 * `where` fragment, for the queries that ask.
 */
export const BLOCKING_SWITCH = {
  OR: [{ status: { in: [SWITCH.REQUESTED, SWITCH.MOVING] } }, { status: SWITCH.LINKED, activatedAt: null }],
};

/**
 * A blocking switch that has STARTED: moving credits, or linked with its cap
 * not moved yet — BLOCKING_SWITCH without REQUESTED. What refuses collecting
 * a top-up already owed, which a REQUESTED switch waits for. A `where` fragment.
 */
export const STARTED_SWITCH = {
  OR: [{ status: SWITCH.MOVING }, { status: SWITCH.LINKED, activatedAt: null }],
};

/**
 * How long an advancer holds a switch: longer than any ONE step can take — a
 * Chargebee call is three 20-second attempts with backoff — and than a carry
 * allocate's claim lease (TOPUP_CLAIM_LEASE_MS). Five minutes, as the usage
 * sync's PROCESSING lease. A request's deadline stops an advancer starting
 * a step; it never shortens the lease.
 */
export const SWITCH_LEASE_MS = 5 * 60_000;

/** One advancer's hold on a switch: which switch, which advancer, and until when. */
export interface SwitchLease {
  id: string;
  owner: string;
  until: Date;
}

/** A capture of the switch, as stored before it is sent: re-sent only under this id, for this amount. */
export interface SwitchCapture {
  operationId: string;
  amount: string;
}

export interface NewCurrencySwitch {
  tenantId: string;
  /** A: the subscription the org is billed on now. */
  fromSubscriptionId: string;
  fromCurrency: string;
  toCurrency: string;
  /** The plan B is made on — `to_currency`'s free plan. */
  toItemPriceId: string;
  at: Date;
}

/** Why `start` did not start. Only "country-changed" writes anything: it abandons the switch. */
export type StartRefusal =
  /** The switch is not REQUESTED under this lease — another advancer has it, or it ended. */
  | "switch"
  /** The account is not active or exhausted on the switch's old subscription (activating, cancelled, relinked, switching). */
  | "account"
  /** A top-up charge is on the wire (billing_account.topup_charging_until); wait for it. */
  | "topup-charging"
  /** The billing country no longer wants this currency: the switch was ABANDONED (`country_changed`). */
  | "country-changed"
  /** A capture of the tenant is on the wire or may have landed (PROCESSING, UNKNOWN, RATE_LIMITING); wait for it to settle. */
  | "in-flight";

/** Why `link` did not link. Nothing was written, whichever it is. */
export type LinkRefusal =
  /** The account is not `switching` on the switch's old subscription. */
  | "account"
  /** The switch is not MOVING to this B under this lease, or a drain or the mirror is still outstanding. */
  | "switch";

/** The `topup_grant` invoice id a carry allocate is guarded under: one per switch and block of A. */
export function carryInvoiceId(switchId: string, grantBlockId: string): string {
  return `${carryPrefix(switchId)}${grantBlockId}`;
}

/** What every carry row of one switch starts with. */
export function carryPrefix(switchId: string): string {
  return `carry:${switchId}:`;
}

/** Is this `topup_grant` invoice id a carry — any switch's copy of a grant block? */
export function isCarryInvoiceId(invoiceId: string): boolean {
  return invoiceId.startsWith("carry:");
}

function toSwitch(row: CurrencySwitchRow): CurrencySwitch;
function toSwitch(row: CurrencySwitchRow | null): CurrencySwitch | null;
function toSwitch(row: CurrencySwitchRow | null): CurrencySwitch | null {
  if (!row) return null;
  return {
    ...row,
    drained: fromDb(row.drained),
    heldBack: fromDb(row.heldBack),
    ownGrant: fromDb(row.ownGrant),
    drainAmount: row.drainAmount == null ? null : fromDb(row.drainAmount),
    mirrorAmount: row.mirrorAmount == null ? null : fromDb(row.mirrorAmount),
  };
}

/** A capture amount to store: exact, and greater than zero — Chargebee refuses a zero capture, so one stored would never settle. */
function captureAmount(amount: string, what: string): string {
  const exact = decimal(amount);
  if (!isPositive(exact)) throw new RangeError(`A ${what} must capture more than zero credits, got ${amount}`);
  return exact;
}

/** The compare-and-set every write of an advancing switch makes: in `status`, under THIS lease. */
function held(lease: SwitchLease, status: string) {
  return { id: lease.id, leaseOwner: lease.owner, status };
}

export function createCurrencySwitchRepository(prisma: PrismaClient = defaultPrisma) {
  const syncs = createChargebeeSyncRepository(prisma);

  async function countOne(where: Record<string, unknown>, data: Record<string, unknown>): Promise<boolean> {
    const { count } = await prisma.currencySwitch.updateMany({ where, data });
    return count === 1;
  }

  return {
    /**
     * Ask for a switch: a REQUESTED row, and nothing else — the account is not
     * touched until it starts. Null when the tenant already has an open switch
     * (the partial unique index); that one is the switch, and the caller
     * reads it with findOpen.
     */
    async create(data: NewCurrencySwitch): Promise<CurrencySwitch | null> {
      try {
        const row = await prisma.currencySwitch.create({
          data: {
            tenantId: data.tenantId,
            fromSubscriptionId: data.fromSubscriptionId,
            fromCurrency: data.fromCurrency,
            toCurrency: data.toCurrency,
            toItemPriceId: data.toItemPriceId,
            status: SWITCH.REQUESTED,
            createdAt: data.at,
            updatedAt: data.at,
          },
        });
        return toSwitch(row);
      } catch (err) {
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },

    /** The tenant's open switch (REQUESTED, MOVING or LINKED), if it has one. */
    async findOpen(tenantId: string): Promise<CurrencySwitch | null> {
      return toSwitch(await prisma.currencySwitch.findFirst({ where: { tenantId, status: { in: [...OPEN_SWITCH] } } }));
    },

    /** The tenant's switch that blocks top-ups and address edits (BLOCKING_SWITCH), if any. */
    async findBlocking(tenantId: string): Promise<CurrencySwitch | null> {
      return toSwitch(await prisma.currencySwitch.findFirst({ where: { tenantId, ...BLOCKING_SWITCH } }));
    },

    async findById(id: string): Promise<CurrencySwitch | null> {
      return toSwitch(await prisma.currencySwitch.findUnique({ where: { id } }));
    },

    /**
     * The tenant's most recent switch, whatever its state — what the page
     * reads to say a switch FAILED (it ended ABANDONED lately), and what the
     * worker reads to leave an org alone for a while after one did.
     */
    async latestFor(tenantId: string): Promise<CurrencySwitch | null> {
      return toSwitch(await prisma.currencySwitch.findFirst({ where: { tenantId }, orderBy: { createdAt: "desc" } }));
    },

    /** Every open switch, oldest first — what the worker advances each minute. */
    async listOpen(): Promise<CurrencySwitch[]> {
      const rows = await prisma.currencySwitch.findMany({
        where: { status: { in: [...OPEN_SWITCH] } },
        orderBy: { createdAt: "asc" },
      });
      return rows.map((row) => toSwitch(row));
    },

    /**
     * Hold the switch for one advance — if and only if it is open and nobody
     * else holds it (no lease, or one that has run out). A fresh owner each
     * time: the lease a stale advancer remembers is no longer the one on the
     * row. Null when someone holds it; they advance it. Counts the attempt.
     */
    async takeLease(id: string, now: Date, ms: number = SWITCH_LEASE_MS): Promise<SwitchLease | null> {
      const lease = { id, owner: randomUUID(), until: new Date(now.getTime() + ms) };
      const taken = await countOne(
        { id, status: { in: [...OPEN_SWITCH] }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        { leaseOwner: lease.owner, leaseUntil: lease.until, attemptCount: { increment: 1 }, updatedAt: now },
      );
      return taken ? lease : null;
    },

    /** Let the switch go — only if the lease is still THIS one. False when another advancer has taken it over. */
    async releaseLease(lease: SwitchLease): Promise<boolean> {
      return countOne({ id: lease.id, leaseOwner: lease.owner }, { leaseOwner: null, leaseUntil: null });
    },

    /**
     * Give up a switch that has not started — the org's address changed back,
     * or to a third currency — if and only if it is still REQUESTED. False
     * when it has started meanwhile: then it is no longer the caller's to
     * stop. No lease: the caller is not advancing it, and an advancer that is
     * finds the status changed at its next write.
     */
    async abandonIfRequested(id: string, reason: string, at: Date): Promise<boolean> {
      return countOne({ id, status: SWITCH.REQUESTED }, { status: SWITCH.ABANDONED, error: reason, updatedAt: at });
    },

    /**
     * Record B, the new subscription, and when — once. Made while the switch
     * is still REQUESTED (an unlinked B is harmless), or while MOVING.
     */
    async setToSubscription(lease: SwitchLease, toSubscriptionId: string, at: Date): Promise<boolean> {
      return countOne(
        { id: lease.id, leaseOwner: lease.owner, status: { in: [SWITCH.REQUESTED, SWITCH.MOVING] }, toSubscriptionId: null },
        { toSubscriptionId, toSubscriptionAt: at, updatedAt: at },
      );
    },

    /**
     * REQUESTED → MOVING, with the account `switching`: from here no window is
     * opened and no capture is sent for the tenant, no top-up is charged, and
     * nothing but the switch may change the account. One transaction:
     *
     *   1. the switch is REQUESTED under this lease. No: "switch".
     *   2. lock the account row — a write that changes nothing that matters —
     *      but only if it is ACTIVE or EXHAUSTED on the switch's old
     *      subscription with no top-up charge on the wire. No: "account", or
     *      "topup-charging" (wait for the charge).
     *   3. its billing country, read UNDER THE LOCK, still wants this
     *      currency. An address saved meanwhile writes the same row, so it
     *      either committed before this — and is seen — or waits behind it.
     *      No: the switch is ABANDONED (`country_changed`), "country-changed".
     *   4. none of its captures is on the wire or may have landed (PROCESSING,
     *      UNKNOWN, RATE_LIMITING). A claim takes the same lock and refuses a
     *      `switching` account (chargebee-sync claim), so one either committed
     *      before this — and is counted — or runs after, and sends nothing.
     *      Any: "in-flight".
     *   5. the switch → MOVING, recording the account's credit unit (every
     *      carry, drain and mirror is in it).
     *   6. the account → `switching`. Cannot be refused: 2 holds the lock.
     *
     * Every check precedes every write but 3's, which is the outcome itself.
     */
    async start(
      lease: SwitchLease,
      { at, rules }: { at: Date; rules: CurrencyRules },
    ): Promise<{ started: true; switch: CurrencySwitch } | { started: false; reason: StartRefusal }> {
      return prisma.$transaction(async (tx) => {
        const sw = await tx.currencySwitch.findUnique({ where: { id: lease.id } });
        if (!sw || sw.status !== SWITCH.REQUESTED || sw.leaseOwner !== lease.owner) {
          return { started: false as const, reason: "switch" as const };
        }

        const live = { tenantId: sw.tenantId, status: { in: [ACCOUNT.ACTIVE, ACCOUNT.EXHAUSTED] }, chargebeeSubscriptionId: sw.fromSubscriptionId };
        const notCharging = { OR: [{ topupChargingUntil: null }, { topupChargingUntil: { lte: at } }] };
        const locked = await tx.billingAccount.updateMany({ where: { ...live, ...notCharging }, data: { updatedAt: at } });
        if (locked.count !== 1) {
          const account = await tx.billingAccount.findUnique({ where: { tenantId: sw.tenantId } });
          const onA =
            account != null &&
            account.chargebeeSubscriptionId === sw.fromSubscriptionId &&
            (account.status === ACCOUNT.ACTIVE || account.status === ACCOUNT.EXHAUSTED);
          return { started: false as const, reason: onA ? ("topup-charging" as const) : ("account" as const) };
        }

        const account = await tx.billingAccount.findUnique({ where: { tenantId: sw.tenantId } });
        if (currencyForCountry(account?.billingCountry, rules) !== sw.toCurrency) {
          await tx.currencySwitch.updateMany({
            where: held(lease, SWITCH.REQUESTED),
            data: { status: SWITCH.ABANDONED, error: "country_changed", updatedAt: at },
          });
          return { started: false as const, reason: "country-changed" as const };
        }

        if ((await syncs.countInFlight(tx, sw.tenantId)) > 0) return { started: false as const, reason: "in-flight" as const };

        const moved = await tx.currencySwitch.updateMany({
          where: held(lease, SWITCH.REQUESTED),
          data: { status: SWITCH.MOVING, movingAt: at, ledgerUnitId: account?.ledgerUnitId ?? null, updatedAt: at },
        });
        if (moved.count !== 1) return { started: false as const, reason: "switch" as const };

        const flipped = await tx.billingAccount.updateMany({ where: { ...live, ...notCharging }, data: { status: ACCOUNT.SWITCHING } });
        // Unreachable while the lock holds; thrown so Postgres rolls the
        // switch back to REQUESTED rather than leave it MOVING on an account
        // that is not switching.
        if (flipped.count !== 1) throw new Error(`Account ${sw.tenantId} changed under its own row lock while switch ${sw.id} started`);

        return { started: true as const, switch: toSwitch((await tx.currencySwitch.findUnique({ where: { id: sw.id } }))!) };
      });
    },

    /**
     * Credits on A that belong to top-up invoices not settled — never
     * carried, and taken off what the drain counts. Recorded once, before
     * anything is drained: the mirror is computed from it, and must not move
     * under it. False when already recorded (or drained from), or not ours.
     */
    async recordHeldBack(lease: SwitchLease, amount: string, at: Date): Promise<boolean> {
      return countOne(
        { ...held(lease, SWITCH.MOVING), heldBack: 0, drained: 0, drainOperationId: null },
        { heldBack: decimal(amount), updatedAt: at },
      );
    },

    /**
     * Store a drain of `amount` credits off A BEFORE it is sent — if and only
     * if no drain is outstanding. Returns the id to send it under, or null
     * when one is (re-send that one first: a second drain beside an unsettled
     * first could take what is not there to take, or count it twice).
     */
    async recordDrain(lease: SwitchLease, amount: string, at: Date, operationId: string = randomUUID()): Promise<SwitchCapture | null> {
      const exact = captureAmount(amount, "drain");
      const recorded = await countOne(
        { ...held(lease, SWITCH.MOVING), drainOperationId: null },
        { drainOperationId: operationId, drainAmount: exact, updatedAt: at },
      );
      return recorded ? { operationId, amount: exact } : null;
    },

    /**
     * The drain under `operationId` landed (captured, or Chargebee says it
     * already had): add its STORED amount to `drained` and clear it — if and
     * only if it is still the outstanding drain under this lease, so a settle
     * repeated adds nothing twice. The amount is read from the row, never
     * taken from the caller: the id and its amount were written together, and
     * neither changes while the id is set.
     */
    async settleDrain(lease: SwitchLease, operationId: string, at: Date): Promise<boolean> {
      const current = await prisma.currencySwitch.findUnique({ where: { id: lease.id } });
      if (!current || current.drainOperationId !== operationId || current.drainAmount == null) return false;
      return countOne(
        { ...held(lease, SWITCH.MOVING), drainOperationId: operationId },
        { drained: { increment: current.drainAmount }, drainOperationId: null, drainAmount: null, updatedAt: at },
      );
    },

    /**
     * Forget the drain under `operationId` without counting it — for one
     * Chargebee provably never applied (its operation answered 404 to the
     * lease holder, AFTER it was refused). The next round reads A again.
     */
    async dropDrain(lease: SwitchLease, operationId: string, at: Date): Promise<boolean> {
      return countOne(
        { ...held(lease, SWITCH.MOVING), drainOperationId: operationId },
        { drainOperationId: null, drainAmount: null, updatedAt: at },
      );
    },

    /**
     * What B's own plan granted on creation, netted out of the mirror.
     * Recorded once, before the mirror: false when already recorded, or the
     * mirror is.
     */
    async recordOwnGrant(lease: SwitchLease, amount: string, at: Date): Promise<boolean> {
      return countOne(
        { ...held(lease, SWITCH.MOVING), ownGrant: 0, mirrorOperationId: null },
        { ownGrant: decimal(amount), updatedAt: at },
      );
    },

    /**
     * Store the mirror — the capture on B that carries A's consumption — BEFORE
     * it is sent, if and only if no drain is outstanding and no mirror is
     * recorded. Returns the id to send it under; null when one already is,
     * and that one is the mirror. Recorded once: re-sending a recomputed
     * amount under a new id would mirror twice.
     */
    async recordMirror(lease: SwitchLease, amount: string, at: Date, operationId: string = randomUUID()): Promise<SwitchCapture | null> {
      const exact = captureAmount(amount, "mirror");
      const recorded = await countOne(
        { ...held(lease, SWITCH.MOVING), drainOperationId: null, mirrorOperationId: null, mirroredAt: null },
        { mirrorOperationId: operationId, mirrorAmount: exact, updatedAt: at },
      );
      return recorded ? { operationId, amount: exact } : null;
    },

    /** The mirror under `operationId` landed. Only if it is the recorded mirror and not settled already. */
    async settleMirror(lease: SwitchLease, operationId: string, at: Date): Promise<boolean> {
      return countOne(
        { ...held(lease, SWITCH.MOVING), mirrorOperationId: operationId, mirroredAt: null },
        { mirroredAt: at, updatedAt: at },
      );
    },

    /**
     * MOVING → LINKED: billing moves to B. One transaction:
     *
     *   1. the switch, read: MOVING under this lease. No: "switch".
     *   2. lock the account row, but only if it is `switching` and still on A.
     *   3. the switch MOVING → LINKED — only if it is moving to THIS B, and
     *      nothing of it is in flight: no drain outstanding, and the mirror
     *      (if one was recorded) settled. The table CHECKs the same.
     *   4. the account relinked to B: its plan, unit, currency and term. It
     *      STAYS `switching` — nothing but the switch may activate it.
     *   5. every window pinned to A that A never applied is re-pinned to B
     *      (chargebee-sync repointHeld), in the same transaction, so no claim
     *      can send one to A after the account has left it.
     *
     * The cursor is not touched: usage after it is billed to B from where A
     * stopped. Every check precedes every write.
     */
    async link(
      lease: SwitchLease,
      to: {
        subscriptionId: string;
        /** The unit the account bills in on B — the carried unit; never "B's oldest". */
        ledgerUnitId: string | null;
        currentTermStart?: Date | null;
        currentTermEnd?: Date | null;
        at: Date;
      },
    ): Promise<
      | { linked: true; switch: CurrencySwitch; account: BillingAccount; repointed: number }
      | { linked: false; reason: LinkRefusal }
    > {
      return prisma.$transaction(async (tx) => {
        const sw = await tx.currencySwitch.findUnique({ where: { id: lease.id } });
        if (!sw || sw.status !== SWITCH.MOVING || sw.leaseOwner !== lease.owner) {
          return { linked: false as const, reason: "switch" as const };
        }

        const onA = { tenantId: sw.tenantId, status: ACCOUNT.SWITCHING, chargebeeSubscriptionId: sw.fromSubscriptionId };
        const locked = await tx.billingAccount.updateMany({ where: onA, data: { updatedAt: to.at } });
        if (locked.count !== 1) return { linked: false as const, reason: "account" as const };

        const linked = await tx.currencySwitch.updateMany({
          where: {
            ...held(lease, SWITCH.MOVING),
            toSubscriptionId: to.subscriptionId,
            drainOperationId: null,
            OR: [{ mirrorOperationId: null }, { mirroredAt: { not: null } }],
          },
          data: { status: SWITCH.LINKED, linkedAt: to.at, updatedAt: to.at },
        });
        if (linked.count !== 1) return { linked: false as const, reason: "switch" as const };

        const relinked = await tx.billingAccount.updateMany({
          where: onA,
          data: {
            chargebeeSubscriptionId: to.subscriptionId,
            chargebeeItemPriceId: sw.toItemPriceId,
            ledgerUnitId: to.ledgerUnitId,
            currency: sw.toCurrency,
            currentTermStart: to.currentTermStart ?? null,
            currentTermEnd: to.currentTermEnd ?? null,
          },
        });
        // Unreachable while the lock holds; thrown so Postgres rolls the
        // switch back to MOVING rather than leave it LINKED to an account
        // still on A.
        if (relinked.count !== 1) throw new Error(`Account ${sw.tenantId} changed under its own row lock while switch ${sw.id} linked`);

        const repointed = await syncs.repointHeld(tx, {
          tenantId: sw.tenantId,
          fromSubscriptionId: sw.fromSubscriptionId,
          toSubscriptionId: to.subscriptionId,
          ledgerUnitId: to.ledgerUnitId,
        });

        return {
          linked: true as const,
          switch: toSwitch((await tx.currencySwitch.findUnique({ where: { id: sw.id } }))!),
          account: (await tx.billingAccount.findUnique({ where: { tenantId: sw.tenantId } }))!,
          repointed,
        };
      });
    },

    /**
     * The org's cap moved to B. From here the switch blocks nothing: what is
     * left (cancelling A) is a background chore. Once, from LINKED.
     */
    async markActivated(lease: SwitchLease, at: Date): Promise<boolean> {
      return countOne({ ...held(lease, SWITCH.LINKED), activatedAt: null }, { activatedAt: at, updatedAt: at });
    },

    /** LINKED and activated → DONE. */
    async markDone(lease: SwitchLease, at: Date): Promise<boolean> {
      return countOne(
        { ...held(lease, SWITCH.LINKED), activatedAt: { not: null } },
        { status: SWITCH.DONE, completedAt: at, error: null, updatedAt: at },
      );
    },

    /**
     * Give up a switch the advancer holds and has not started — the account
     * was cancelled or relinked, the request timed out — saying why.
     */
    async abandonRequested(lease: SwitchLease, reason: string, at: Date): Promise<boolean> {
      return countOne(held(lease, SWITCH.REQUESTED), { status: SWITCH.ABANDONED, error: reason, updatedAt: at });
    },

    /**
     * Give up a MOVING switch — a step Chargebee definitely refused — but only
     * while it has moved NO money: nothing drained, no drain outstanding, no
     * mirror, and no carry allocate of it APPLIED (its `topup_grant` rows,
     * read in the same transaction; under the lease no other advancer is
     * adding one). The account is then the caller's to put back on A, and B
     * to cancel. False when any money moved: then it must be finished, not
     * abandoned.
     */
    async abort(lease: SwitchLease, reason: string, at: Date): Promise<boolean> {
      return prisma.$transaction(async (tx) => {
        const sw = await tx.currencySwitch.findUnique({ where: { id: lease.id } });
        if (!sw) return false;
        const carried = await tx.topUpGrant.count({
          where: { tenantId: sw.tenantId, invoiceId: { startsWith: carryPrefix(sw.id) }, status: TOPUP.APPLIED },
        });
        if (carried > 0) return false;
        const { count } = await tx.currencySwitch.updateMany({
          where: { ...held(lease, SWITCH.MOVING), drained: 0, drainOperationId: null, mirrorOperationId: null },
          data: { status: SWITCH.ABANDONED, error: reason, updatedAt: at },
        });
        return count === 1;
      });
    },

    /**
     * Note why an open switch is waiting, for a person reading the row. No
     * guarantee rides on it; a switch that has ended keeps the reason it ended
     * with.
     */
    async noteError(id: string, error: string, at: Date): Promise<void> {
      await prisma.currencySwitch.updateMany({
        where: { id, status: { in: [...OPEN_SWITCH] } },
        data: { error, updatedAt: at },
      });
    },
  };
}

export type CurrencySwitchRepository = ReturnType<typeof createCurrencySwitchRepository>;
