/**
 * The currency switch — moving an org on a FREE plan from its subscription in
 * one currency (A) to a new one in its billing country's currency (B), with
 * its credits, its usage figures and its LiteLLM cap carried across unchanged
 * (DESIGN §3, as amended by DESIGN-ADDENDUM A1–A17).
 *
 * One `currency_switch` row per switch (currency-switch.repository.ts). Every
 * money movement is STORED before it is sent and re-sent only under the same
 * key or id; every write is a compare-and-set under the advancer's lease, so
 * a crash, a retry or a second advancer never moves money twice.
 *
 *   REQUESTED  B is made (deterministic id `cs_<switch id>`, A11), then the
 *              switch waits until the org has nothing owed or on its way
 *              (top-ups, the free plan's credits, captures in flight), and
 *              STARTS: the account `switching`, the switch MOVING, together.
 *   MOVING     CARRY every live block of A onto B (allocateOnce, oldest first,
 *              stopping at the first not applied; held-back unsettled top-up
 *              blocks are skipped, A2) → DRAIN A to zero → RESCAN A → MIRROR
 *              A's consumption onto B, read from B's actual ledger once its own
 *              plan grant can have landed (A11) → LINK the account to B.
 *   LINKED     ACTIVATE (the cap moves onto B unchanged, A17) → CANCEL A →
 *              final check → DONE.
 *
 * A step that Chargebee definitely refuses before any money moved ABORTS the
 * switch (the account goes back to A). Anything else WAITS: the worker
 * advances every open switch each minute (advanceOpen), recovers an account a
 * crashed abort left `switching`, and requests a switch for a free org whose
 * currency drifted from its country's (A1's convergence).
 */

import type { ChargebeeClient, GrantBlock } from "../integrations/chargebee";
import {
  CAPTURE_INSUFFICIENT,
  CAPTURE_OK,
  CAPTURE_REPLAYED,
  CAPTURE_TERMINAL,
  isDefiniteRefusal,
  isLiveGrantBlock,
  isUnsettledTopUpGrant,
  type ChargebeeError,
} from "../integrations/chargebee";
import { ACCOUNT } from "../models/account-status";
import { currencyForCountry, freeItemPriceIds, settingsFor, topUpItemPriceIds, type CurrencyCatalog } from "../models/currency";
import { add, compare, isPositive, subtract, subtractFloorZero } from "../models/decimal";
import { isFreeSubscriptionRecord } from "../models/subscription";
import type { BillingAccount, BillingAccountRepository } from "../repositories/billing-account.repository";
import {
  SWITCH,
  carryInvoiceId,
  carryPrefix,
  type CurrencySwitch,
  type CurrencySwitchRepository,
  type SwitchLease,
} from "../repositories/currency-switch.repository";
import { TOPUP, type TopUpGrantRepository } from "../repositories/topup-grant.repository";
import { errorMessage } from "../shared/errors";
import type { Logger } from "../shared/logger";
import { TOPUP_MIN_EXPIRY_LEAD_MS, type AccountService } from "./account.service";
import type { CurrencySwitcher, SwitchProgress, SwitchWaitReason } from "./billing-address.service";

/** A REQUESTED switch that has not started after this long is abandoned (`timed_out`, A5). */
export const SWITCH_REQUEST_TTL_MS = 30 * 60_000;
/** B's own plan grant is read only this long after B was made (A11; MEASURED ~3 s). */
export const B_GRANT_SETTLE_MS = 10_000;
/** An open switch older than this is logged `billing.currency_switch.stuck` (alerted). */
export const SWITCH_STUCK_MS = 30 * 60_000;
/** The least time left to START a step (A3). */
export const SWITCH_MIN_STEP_MS = 1_500;
/** Convergence: at most this many accounts a pass, and none whose last switch was abandoned this recently (A1). */
export const CONVERGE_LIMIT = 20;
export const CONVERGE_BACKOFF_MS = 30 * 60_000;

const DRAIN_ROUNDS = 5;
const RESCAN_ROUNDS = 3;
const MAX_STEPS = 12;
const TEN_YEARS_MS = 10 * 365 * 86_400_000;

/** B's subscription id: deterministic, so a lost answer is found again by id (A11). ≤ 50 characters. */
export function targetSubscriptionId(switchId: string): string {
  return `cs_${switchId.replace(/-/g, "")}`;
}

/** The switch cannot move on now; the worker tries again. `waitingOn` when it is the org's to settle. */
class Wait {
  constructor(
    readonly reason: string,
    readonly waitingOn: SwitchWaitReason | null = null,
  ) {}
}

/** This advancer must stop: the switch ended, or another advancer holds it. */
class Stop {
  constructor(readonly reason: string) {}
}

export interface CurrencySwitchDeps {
  /** The ordinary client (retries): what the worker advances with. */
  chargebee: ChargebeeClient;
  /** A client bounded by the time left (`timeoutMs`, one attempt), for an advance with a deadline (A3). */
  chargebeeFor?: (timeoutMs: number) => ChargebeeClient;
  accountService: Pick<AccountService, "activate" | "activateAfterSwitch" | "allocateOnce" | "freePlanCreditsOwed">;
  accounts: Pick<BillingAccountRepository, "findByTenantId" | "listSwitchingTenantIds" | "listCurrencyMismatches">;
  switches: CurrencySwitchRepository;
  topUps: Pick<TopUpGrantRepository, "withInvoicePrefix" | "countUnresolved">;
  catalog: CurrencyCatalog;
  /** checkout.applyTopUps: records paid packs; a pack whose grant is not visible yet is `pending`. */
  applyTopUps?: (tenantId: string) => Promise<{ pending?: string[] }>;
  /** BILLING_CURRENCY_SWITCH_ENABLED — gates convergence (the address sync gates requests itself). */
  currencySwitchEnabled?: boolean;
  clock?: () => number;
  logger?: Logger;
}

export interface AdvanceOpenSummary {
  open: number;
  advanced: number;
  done: number;
  stuck: number;
  recovered: number;
  requested: number;
}

export function createCurrencySwitchService(deps: CurrencySwitchDeps) {
  const clock = deps.clock ?? (() => Date.now());
  const log = deps.logger ?? console;
  const rules = deps.catalog.rules;
  const topUpIds = topUpItemPriceIds(deps.catalog);
  const freeIds = freeItemPriceIds(deps.catalog);
  const at = () => new Date(clock());

  // ── request ──────────────────────────────────────────────────────────────

  async function request(tenantId: string, toCurrency: string): Promise<CurrencySwitch | null> {
    const open = await deps.switches.findOpen(tenantId);
    if (open) return open;

    const account = await deps.accounts.findByTenantId(tenantId);
    if (!account?.chargebeeSubscriptionId || account.status === ACCOUNT.CANCELLED) return null;
    const toItemPriceId = settingsFor(deps.catalog, toCurrency).freeItemPriceId;
    if (!toItemPriceId) {
      log.error?.(
        { metric: "billing.currency_switch.misconfigured", tenantId, toCurrency, reason: "no free plan" },
        "No free plan is configured in the currency the org's country wants; no switch is requested",
      );
      return null;
    }
    let fromCurrency = account.currency;
    if (!fromCurrency) {
      const record = await deps.chargebee.subscription(account.chargebeeSubscriptionId);
      fromCurrency = typeof record?.currency_code === "string" ? record.currency_code : null;
    }
    if (!fromCurrency) throw new Error(`The currency of subscription ${account.chargebeeSubscriptionId} could not be read`);
    if (fromCurrency === toCurrency) return null;

    const created = await deps.switches.create({
      tenantId,
      fromSubscriptionId: account.chargebeeSubscriptionId,
      fromCurrency,
      toCurrency,
      toItemPriceId,
      at: at(),
    });
    if (!created) return deps.switches.findOpen(tenantId);
    log.log?.(
      { metric: "billing.currency_switch.requested", tenantId, switchId: created.id, fromCurrency, toCurrency },
      "Currency switch requested",
    );
    return created;
  }

  // ── advance ──────────────────────────────────────────────────────────────

  async function advance(
    tenantId: string,
    { deadline, minStepMs = SWITCH_MIN_STEP_MS }: { deadline: number; minStepMs?: number },
  ): Promise<SwitchProgress> {
    const open = await deps.switches.findOpen(tenantId);
    if (!open) return { open: null, waitingOn: null };
    const lease = await deps.switches.takeLease(open.id, at());
    if (!lease) return { open, waitingOn: null };

    const cb = deps.chargebeeFor ? deps.chargebeeFor(Math.max(minStepMs, deadline - clock())) : deps.chargebee;
    const run = runner(lease, cb, deadline, minStepMs);
    let waitingOn: SwitchWaitReason | null = null;
    try {
      for (let i = 0; i < MAX_STEPS; i += 1) {
        const sw = await deps.switches.findById(open.id);
        if (!sw || sw.leaseOwner !== lease.owner) break;
        if (sw.status === SWITCH.REQUESTED) await run.requested(sw);
        else if (sw.status === SWITCH.MOVING) await run.moving(sw);
        else if (sw.status === SWITCH.LINKED) await run.linked(sw);
        else break;
      }
    } catch (err) {
      if (err instanceof Wait) {
        waitingOn = err.waitingOn;
        log.log?.(
          { metric: "billing.currency_switch.waiting", tenantId, switchId: open.id, reason: err.reason, waitingOn },
          "Currency switch waiting",
        );
        await deps.switches.noteError(open.id, err.reason, at()).catch(() => undefined);
      } else if (!(err instanceof Stop)) {
        log.warn?.(
          { metric: "billing.currency_switch.waiting", tenantId, switchId: open.id, err: errorMessage(err) },
          "Currency switch step failed; it is retried with the same keys",
        );
        await deps.switches.noteError(open.id, errorMessage(err), at()).catch(() => undefined);
      }
    } finally {
      await deps.switches.releaseLease(lease).catch(() => undefined);
    }
    return { open: await deps.switches.findOpen(tenantId), waitingOn };
  }

  /** The steps of one advance, under one lease, one client and one deadline. */
  function runner(lease: SwitchLease, cb: ChargebeeClient, deadline: number, minStepMs: number) {
    /** Never START a step with less than minStepMs left. */
    const time = () => {
      if (deadline - clock() < minStepMs) throw new Wait("deadline");
    };
    const cas = (ok: boolean) => {
      if (!ok) throw new Stop("lease lost or state changed");
    };

    async function account(sw: CurrencySwitch): Promise<BillingAccount> {
      const found = await deps.accounts.findByTenantId(sw.tenantId);
      if (!found) throw new Stop("no account");
      return found;
    }

    async function cancelBestEffort(sw: CurrencySwitch, subscriptionId: string | null) {
      if (!subscriptionId) return;
      try {
        await cb.cancelSubscription(subscriptionId);
      } catch (err) {
        log.error?.(
          { metric: "billing.currency_switch.cancel_failed", tenantId: sw.tenantId, switchId: sw.id, subscriptionId, err: errorMessage(err) },
          "Could not cancel the unused subscription of an abandoned currency switch; cancel it by hand",
        );
      }
    }

    /** REQUESTED → ABANDONED (nothing moved; the account was never touched). */
    async function abandon(sw: CurrencySwitch, reason: string) {
      cas(await deps.switches.abandonRequested(lease, reason, at()));
      log.warn?.(
        { metric: "billing.currency_switch.abandoned", tenantId: sw.tenantId, switchId: sw.id, reason },
        "Currency switch abandoned before it started",
      );
      await cancelBestEffort(sw, sw.toSubscriptionId);
      throw new Stop("abandoned");
    }

    /** MOVING → ABANDONED, only while no money moved (A14): the account back on A, B cancelled. */
    async function abort(sw: CurrencySwitch, reason: string): Promise<void> {
      if (!(await deps.switches.abort(lease, reason, at()))) return;
      log.error?.(
        { metric: "billing.currency_switch.aborted", tenantId: sw.tenantId, switchId: sw.id, reason },
        "Currency switch aborted before any credit moved; the org stays on its old subscription",
      );
      try {
        await deps.accountService.activate(sw.tenantId, ACCOUNT.ACTIVE, { fromSwitching: true });
      } catch (err) {
        log.error?.(
          { metric: "billing.currency_switch.abort_activate_failed", tenantId: sw.tenantId, switchId: sw.id, err: errorMessage(err) },
          "Could not put the account back on its old subscription; the worker's orphan recovery retries it",
        );
      }
      await cancelBestEffort(sw, sw.toSubscriptionId);
      throw new Stop("aborted");
    }

    /** Make (or find, by its deterministic id) B. A definite refusal ends the switch. */
    async function ensureTarget(sw: CurrencySwitch, customerId: string) {
      const refuse = (reason: string) => (sw.status === SWITCH.REQUESTED ? abandon(sw, reason) : abort(sw, reason));
      time();
      const price = await cb.itemPrice(sw.toItemPriceId);
      if (!price || price.priceMinor !== 0 || price.currencyCode !== sw.toCurrency) {
        log.error?.(
          {
            metric: "billing.currency_switch.misconfigured",
            tenantId: sw.tenantId,
            switchId: sw.id,
            itemPriceId: sw.toItemPriceId,
            toCurrency: sw.toCurrency,
            price: price ? { priceMinor: price.priceMinor, currencyCode: price.currencyCode } : null,
          },
          "The target free plan is not a zero-price plan in the target currency",
        );
        await refuse("misconfigured");
        throw new Wait("misconfigured");
      }
      time();
      let sub: Record<string, unknown>;
      try {
        sub = await cb.subscribeCustomer({
          customerId,
          itemPriceId: sw.toItemPriceId,
          idempotencyKey: `currency-switch:${sw.id}`,
          subscriptionId: targetSubscriptionId(sw.id),
        });
      } catch (err) {
        if (isDefiniteRefusal(err as ChargebeeError)) {
          log.error?.(
            { metric: "billing.currency_switch.target_refused", tenantId: sw.tenantId, switchId: sw.id, err: errorMessage(err) },
            "Chargebee refused the new subscription",
          );
          await refuse("chargebee_refused");
        }
        throw err;
      }
      const id = typeof sub?.id === "string" ? sub.id : targetSubscriptionId(sw.id);
      cas(await deps.switches.setToSubscription(lease, id, at()));
    }

    // ── REQUESTED ──────────────────────────────────────────────────────────

    async function requested(sw: CurrencySwitch) {
      if (clock() - sw.createdAt.getTime() > SWITCH_REQUEST_TTL_MS) await abandon(sw, "timed_out");
      const acct = await account(sw);
      if (acct.status === ACCOUNT.CANCELLED || acct.chargebeeSubscriptionId !== sw.fromSubscriptionId) {
        await abandon(sw, "account_changed");
      }
      if (currencyForCountry(acct.billingCountry, rules) !== sw.toCurrency) await abandon(sw, "country_changed");
      if (!acct.chargebeeCustomerId) await abandon(sw, "no_customer");

      if (!sw.toSubscriptionId) return ensureTarget(sw, acct.chargebeeCustomerId!);

      if (acct.status === ACCOUNT.ACTIVATING || (await deps.accountService.freePlanCreditsOwed(acct))) {
        throw new Wait("the org's credits are still being set up", "billing-activating");
      }
      if (acct.status !== ACCOUNT.ACTIVE && acct.status !== ACCOUNT.EXHAUSTED) throw new Wait(`account ${acct.status}`);

      if (topUpIds.length > 0) {
        time();
        const unsettled = await cb.unsettledTopUpInvoices(acct.chargebeeCustomerId!, topUpIds);
        if (unsettled.some((i) => i.status === "payment_due" || i.status === "not_paid")) {
          throw new Wait("a top-up is unpaid", "topup-unpaid");
        }
        if (unsettled.some((i) => i.status === "pending")) throw new Wait("a top-up invoice is pending", "topup-pending");
        if (deps.applyTopUps) {
          time();
          const applied = await deps.applyTopUps(sw.tenantId);
          if ((applied.pending?.length ?? 0) > 0) throw new Wait("a paid top-up's grant is not visible yet", "topup-pending");
        }
      }
      if ((await deps.topUps.countUnresolved(sw.tenantId)) > 0) throw new Wait("a top-up grant is unresolved", "topup-pending");

      const started = await deps.switches.start(lease, { at: at(), rules });
      if (started.started) {
        log.log?.(
          { metric: "billing.currency_switch.started", tenantId: sw.tenantId, switchId: sw.id, unit: started.switch.ledgerUnitId },
          "Currency switch started; the account is switching",
        );
        return;
      }
      switch (started.reason) {
        case "country-changed":
          log.warn?.(
            { metric: "billing.currency_switch.abandoned", tenantId: sw.tenantId, switchId: sw.id, reason: "country_changed" },
            "Currency switch abandoned at start: the billing country changed",
          );
          await cancelBestEffort(sw, sw.toSubscriptionId);
          throw new Stop("abandoned");
        case "switch":
          throw new Stop("not ours");
        case "in-flight":
          throw new Wait("a usage capture is in flight");
        case "topup-charging":
          throw new Wait("a top-up charge is on the wire");
        default:
          throw new Wait(`account not live on the old subscription`);
      }
    }

    // ── MOVING ─────────────────────────────────────────────────────────────

    const liveBlock = (b: GrantBlock, now: number) =>
      isPositive(b.grantedAmount) && isLiveGrantBlock({ status: b.status, expires_at: b.expiresAtMs ? b.expiresAtMs / 1000 : 0 }, now);

    /**
     * CARRY (A2, A12): every live block of A in the unit that is not held
     * back, oldest first, through allocateOnce — stopping at the first not
     * applied. `send` false only counts what is not carried yet (the rescan).
     */
    async function carry(sw: CurrencySwitch, unit: string, customerId: string, send: boolean): Promise<number> {
      time();
      const listed = await cb.grantBlocks(sw.fromSubscriptionId);
      if (!listed.complete) throw new Wait("A's grant blocks could not all be read");
      const now = clock();
      const live = listed.blocks.filter((b) => liveBlock(b, now));
      const otherUnits = live.filter((b) => b.unitId !== unit);
      if (otherUnits.length > 0 && send) {
        log.error?.(
          { metric: "billing.currency_switch.carry_other_unit", tenantId: sw.tenantId, switchId: sw.id, blocks: otherUnits.map((b) => b.id), unit },
          "Grant blocks on the old subscription in another unit are not carried; a person moves them",
        );
      }
      const inUnit = live.filter((b) => b.unitId === unit);
      let held: GrantBlock[] = [];
      if (topUpIds.length > 0) {
        time();
        const unsettled = new Set((await cb.unsettledTopUpInvoices(customerId, topUpIds)).map((i) => i.id));
        held = inUnit.filter((b) => isUnsettledTopUpGrant(b, unsettled, topUpIds));
      }
      if (send && held.length > 0 && compare(sw.heldBack, "0") === 0) {
        const heldBack = add("0", ...held.map((b) => b.grantedAmount));
        cas(await deps.switches.recordHeldBack(lease, heldBack, at()));
        sw = (await deps.switches.findById(sw.id))!;
      }

      const rows = new Map((await deps.topUps.withInvoicePrefix(sw.tenantId, carryPrefix(sw.id))).map((r) => [r.invoiceId, r]));
      const toCarry = inUnit.filter((b) => !held.includes(b) && rows.get(carryInvoiceId(sw.id, b.id))?.status !== TOPUP.APPLIED);
      if (!send) return toCarry.length;

      let carried = "0";
      for (const block of toCarry) {
        time();
        const result = await deps.accountService.allocateOnce({
          tenantId: sw.tenantId,
          guardId: carryInvoiceId(sw.id, block.id),
          subscriptionId: sw.toSubscriptionId!,
          unitId: unit,
          credits: block.grantedAmount,
          expiresAt: new Date(Math.max(block.expiresAtMs ?? clock() + TEN_YEARS_MS, clock() + TOPUP_MIN_EXPIRY_LEAD_MS)),
        });
        if (result.kind === "pending") {
          if (result.refused) await abort(sw, "chargebee_refused");
          throw new Wait(`carry of ${block.id} pending: ${result.reason}`);
        }
        carried = add(carried, result.credits);
      }
      if (toCarry.length > 0) {
        log.log?.(
          { metric: "billing.currency_switch.carried", tenantId: sw.tenantId, switchId: sw.id, blocks: toCarry.length, credits: carried },
          "Grant blocks carried to the new subscription",
        );
      }
      return 0;
    }

    /** DRAIN A to zero (A14): the drain stored before it is sent, settled or dropped by its id. */
    async function drain(swId: string, unit: string) {
      for (let round = 0; round < DRAIN_ROUNDS; round += 1) {
        const sw = (await deps.switches.findById(swId))!;
        const metadata = { reason: "currency_switch", switch_id: sw.id, to_subscription_id: sw.toSubscriptionId };
        if (sw.drainOperationId) {
          time();
          const result = await cb.captureIdempotent({
            id: sw.drainOperationId,
            subscriptionId: sw.fromSubscriptionId,
            unitId: unit,
            amount: sw.drainAmount!,
            metadata,
          });
          if (result.kind === CAPTURE_OK || result.kind === CAPTURE_REPLAYED) {
            cas(await deps.switches.settleDrain(lease, sw.drainOperationId, at()));
            log.log?.(
              { metric: "billing.currency_switch.drained", tenantId: sw.tenantId, switchId: sw.id, amount: sw.drainAmount },
              "Old subscription drained",
            );
            continue;
          }
          if (result.kind === CAPTURE_INSUFFICIENT) {
            time();
            const op = await cb.findOperation(sw.drainOperationId, sw.fromSubscriptionId);
            if (op) cas(await deps.switches.settleDrain(lease, sw.drainOperationId, at()));
            else cas(await deps.switches.dropDrain(lease, sw.drainOperationId, at()));
            continue;
          }
          throw new Wait(`drain ${result.kind}`);
        }
        time();
        const balance = await cb.balance(sw.fromSubscriptionId, unit);
        if (balance == null) {
          // Null is two different facts. A subscription with NO ledger account
          // in this unit — a free plan that granted nothing, with no free
          // credits, so nothing ever opened a wallet (it is still linked to
          // FREE_PLAN_CREDIT_UNIT) — has nothing to drain. Anything else that
          // reads as null is not knowing, and a drain never guesses: wait.
          // ledgerUnits throws when Chargebee cannot answer, which waits too.
          time();
          const units = await cb.ledgerUnits(sw.fromSubscriptionId);
          if (!units.includes(unit)) return;
          throw new Wait("the old subscription's balance is unreadable");
        }
        if (!isPositive(balance.usable)) return;
        cas((await deps.switches.recordDrain(lease, balance.usable, at())) != null);
      }
      throw new Wait("the drain did not settle");
    }

    /**
     * MIRROR (A11), from B's actual ledger: what A had consumed, captured on
     * B, so B's granted, consumed and usable read as A's did (B's own grant
     * netted out). Never clamped: a negative mirror waits for a person.
     */
    async function mirror(swId: string, unit: string) {
      let sw = (await deps.switches.findById(swId))!;
      if (!sw.mirrorOperationId && !sw.mirroredAt) {
        if (clock() - (sw.toSubscriptionAt?.getTime() ?? clock()) < B_GRANT_SETTLE_MS) {
          throw new Wait("waiting for the new subscription's own grant to land");
        }
        time();
        const listed = await cb.grantBlocks(sw.toSubscriptionId!);
        if (!listed.complete) throw new Wait("B's grant blocks could not all be read");
        const now = clock();
        const live = listed.blocks.filter((b) => liveBlock(b, now));
        const elsewhere = live.filter((b) => b.unitId !== unit);
        if (elsewhere.length > 0) {
          log.error?.(
            { metric: "billing.currency_switch.target_other_unit", tenantId: sw.tenantId, switchId: sw.id, blocks: elsewhere.map((b) => b.id) },
            "The new subscription holds grant blocks in another unit; ignored",
          );
        }
        const onB = add("0", ...live.filter((b) => b.unitId === unit).map((b) => b.grantedAmount));
        const rows = (await deps.topUps.withInvoicePrefix(sw.tenantId, carryPrefix(sw.id))).filter((r) => r.status === TOPUP.APPLIED);
        const carriedRows = add("0", ...rows.map((r) => r.credits));
        const ownGrant = subtract(onB, carriedRows);
        if (compare(ownGrant, "0") < 0) {
          log.error?.(
            { metric: "billing.currency_switch.carry_short", tenantId: sw.tenantId, switchId: sw.id, onB, carriedRows },
            "The new subscription holds less than was carried; a person must look before the switch goes on",
          );
          throw new Wait("carry short");
        }
        if (isPositive(ownGrant)) {
          if (compare(sw.ownGrant, "0") === 0) {
            cas(await deps.switches.recordOwnGrant(lease, ownGrant, at()));
            log.error?.(
              { metric: "billing.currency_switch.target_plan_grants", tenantId: sw.tenantId, switchId: sw.id, ownGrant, itemPriceId: sw.toItemPriceId },
              "FREE_PLAN_ITEM_PRICE_ID_<CUR> must grant 0 — its own grant is netted out",
            );
          } else if (compare(sw.ownGrant, ownGrant) !== 0) {
            log.error?.(
              { metric: "billing.currency_switch.own_grant_changed", tenantId: sw.tenantId, switchId: sw.id, stored: sw.ownGrant, now: ownGrant },
              "The new subscription's own grant changed after it was recorded",
            );
          }
        }
        const mirrorAmount = subtract(onB, subtractFloorZero(sw.drained, sw.heldBack));
        if (compare(mirrorAmount, "0") < 0) {
          log.error?.(
            { metric: "billing.currency_switch.carry_short", tenantId: sw.tenantId, switchId: sw.id, onB, drained: sw.drained, heldBack: sw.heldBack },
            "More was drained than the new subscription holds; a person must look before the switch goes on",
          );
          throw new Wait("mirror would be negative");
        }
        if (!isPositive(mirrorAmount)) return;
        cas((await deps.switches.recordMirror(lease, mirrorAmount, at())) != null);
        sw = (await deps.switches.findById(swId))!;
      }
      if (sw.mirrorOperationId && !sw.mirroredAt) {
        time();
        const result = await cb.captureIdempotent({
          id: sw.mirrorOperationId,
          subscriptionId: sw.toSubscriptionId!,
          unitId: unit,
          amount: sw.mirrorAmount!,
          metadata: { reason: "currency_switch_mirror", switch_id: sw.id, from_subscription_id: sw.fromSubscriptionId },
        });
        if (result.kind === CAPTURE_OK || result.kind === CAPTURE_REPLAYED) {
          cas(await deps.switches.settleMirror(lease, sw.mirrorOperationId, at()));
          log.log?.(
            { metric: "billing.currency_switch.mirrored", tenantId: sw.tenantId, switchId: sw.id, amount: sw.mirrorAmount },
            "Consumption mirrored onto the new subscription",
          );
          return;
        }
        if (result.kind === CAPTURE_INSUFFICIENT || result.kind === CAPTURE_TERMINAL) {
          log.error?.(
            { metric: "billing.currency_switch.mirror_refused", tenantId: sw.tenantId, switchId: sw.id, kind: result.kind, err: errorMessage(result.error) },
            "Chargebee refused the mirror capture; a person must look",
          );
        }
        throw new Wait(`mirror ${result.kind}`);
      }
    }

    async function moving(sw: CurrencySwitch) {
      const acct = await account(sw);
      if (!acct.chargebeeCustomerId) throw new Wait("no customer");
      if (!sw.toSubscriptionId) return ensureTarget(sw, acct.chargebeeCustomerId);
      const unit = sw.ledgerUnitId;

      if (unit) {
        if (!sw.mirrorOperationId && !sw.mirroredAt) {
          for (let round = 0; ; round += 1) {
            await carry(sw, unit, acct.chargebeeCustomerId, true);
            await drain(sw.id, unit);
            const left = await carry((await deps.switches.findById(sw.id))!, unit, acct.chargebeeCustomerId, false);
            if (left === 0) break;
            if (round + 1 >= RESCAN_ROUNDS) {
              log.error?.(
                { metric: "billing.currency_switch.rescan_unsettled", tenantId: sw.tenantId, switchId: sw.id, left },
                "Grant blocks keep landing on the old subscription",
              );
              throw new Wait("rescan did not settle");
            }
          }
        }
        await mirror(sw.id, unit);

        // B's usable must now be exactly what A displayed (A11).
        const now = (await deps.switches.findById(sw.id))!;
        const expected = subtractFloorZero(now.drained, now.heldBack);
        time();
        const balance = await cb.balance(now.toSubscriptionId!, unit);
        if (balance == null ? isPositive(expected) : compare(balance.usable, expected) !== 0) {
          log.error?.(
            { metric: "billing.currency_switch.target_balance_mismatch", tenantId: sw.tenantId, switchId: sw.id, expected, usable: balance?.usable ?? null },
            "The new subscription's balance is not what the old one displayed; a person must look before linking",
          );
          throw new Wait("B's balance does not match");
        }
      }

      time();
      const record = await cb.subscription(sw.toSubscriptionId);
      if (!record) throw new Wait("the new subscription is not readable");
      const seconds = (v: unknown) => (typeof v === "number" ? new Date(v * 1000) : null);
      const linkUnit = unit ?? (await cb.balance(sw.toSubscriptionId, null))?.unitId ?? null;
      const linked = await deps.switches.link(lease, {
        subscriptionId: sw.toSubscriptionId,
        ledgerUnitId: linkUnit,
        currentTermStart: seconds(record.current_term_start),
        currentTermEnd: seconds(record.current_term_end),
        at: at(),
      });
      if (!linked.linked) {
        if (linked.reason === "switch") throw new Stop("not ours");
        throw new Wait("the account is not switching on the old subscription");
      }
      log.log?.(
        { metric: "billing.currency_switch.linked", tenantId: sw.tenantId, switchId: sw.id, toSubscriptionId: sw.toSubscriptionId, repointed: linked.repointed },
        "Billing moved to the new subscription",
      );
      try {
        await cb.setPreferredCurrency(acct.chargebeeCustomerId, sw.toCurrency);
      } catch (err) {
        log.error?.(
          { metric: "billing.customer.preferred_currency_failed", tenantId: sw.tenantId, currency: sw.toCurrency, err: errorMessage(err) },
          "Could not set the customer's preferred currency in Chargebee",
        );
      }
    }

    // ── LINKED ─────────────────────────────────────────────────────────────

    async function linked(sw: CurrencySwitch) {
      if (!sw.activatedAt) {
        time();
        const after = await deps.accountService.activateAfterSwitch(sw.tenantId, { ownGrant: sw.ownGrant });
        if (after.status === ACCOUNT.SWITCHING) throw new Wait("the cap has not moved onto the new subscription yet");
        cas(await deps.switches.markActivated(lease, at()));
        log.log?.(
          { metric: "billing.currency_switch.activated", tenantId: sw.tenantId, switchId: sw.id, status: after.status },
          "The org's cap is on the new subscription",
        );
        return;
      }

      time();
      await cb.cancelSubscription(sw.fromSubscriptionId);
      await finalCheck(sw);
      cas(await deps.switches.markDone(lease, at()));
      log.log?.(
        {
          metric: "billing.currency_switch.done",
          tenantId: sw.tenantId,
          switchId: sw.id,
          drained: sw.drained,
          heldBack: sw.heldBack,
          ownGrant: sw.ownGrant,
          mirror: sw.mirrorAmount,
        },
        "Currency switch done",
      );
    }

    /** Best effort: credits that reached A after the move, or a plan grant on B after the mirror, are a person's to move. */
    async function finalCheck(sw: CurrencySwitch) {
      try {
        const left = await cb.balance(sw.fromSubscriptionId, sw.ledgerUnitId);
        if (left && isPositive(left.usable)) {
          log.error?.(
            { metric: "billing.currency_switch.stranded_credits", tenantId: sw.tenantId, switchId: sw.id, subscriptionId: sw.fromSubscriptionId, usable: left.usable },
            "Credits reached the old subscription after the move; a person moves them",
          );
        }
        if (sw.ledgerUnitId && sw.toSubscriptionId && sw.mirroredAt) {
          const listed = await cb.grantBlocks(sw.toSubscriptionId);
          const late = listed.blocks.filter(
            (b) => b.unitId === sw.ledgerUnitId && b.itemPriceId != null && (b.createdAtMs ?? 0) > sw.mirroredAt!.getTime() && liveBlock(b, clock()),
          );
          if (late.length > 0) {
            log.error?.(
              { metric: "billing.currency_switch.late_target_grant", tenantId: sw.tenantId, switchId: sw.id, blocks: late.map((b) => b.id) },
              "The new subscription's plan granted credits after the mirror; a person claws them back",
            );
          }
        }
      } catch (err) {
        log.warn?.(
          { metric: "billing.currency_switch.final_check_failed", tenantId: sw.tenantId, switchId: sw.id, err: errorMessage(err) },
          "The switch's final check could not read Chargebee",
        );
      }
    }

    return { requested, moving, linked };
  }

  // ── the worker ───────────────────────────────────────────────────────────

  /**
   * Each minute: put back any account a crashed abort left `switching`
   * (A14), advance every open switch until `deadline`, log the ones open too
   * long, and request a switch for free orgs whose currency drifted from
   * their country's (A1).
   */
  async function advanceOpen({ deadline, minStepMs = SWITCH_MIN_STEP_MS }: { deadline: number; minStepMs?: number }): Promise<AdvanceOpenSummary> {
    const summary: AdvanceOpenSummary = { open: 0, advanced: 0, done: 0, stuck: 0, recovered: 0, requested: 0 };

    for (const tenantId of await deps.accounts.listSwitchingTenantIds()) {
      const open = await deps.switches.findOpen(tenantId);
      if (open && (open.status === SWITCH.MOVING || open.status === SWITCH.LINKED)) continue;
      log.warn?.(
        { metric: "billing.currency_switch.orphan_recovered", tenantId },
        "An account was left switching with no switch moving it; activating it on its subscription",
      );
      try {
        await deps.accountService.activate(tenantId, ACCOUNT.ACTIVE, { fromSwitching: true });
        summary.recovered += 1;
      } catch (err) {
        log.error?.({ metric: "billing.currency_switch.orphan_recovery_failed", tenantId, err: errorMessage(err) }, "Orphan recovery failed");
      }
    }

    const open = await deps.switches.listOpen();
    summary.open = open.length;
    for (const sw of open) {
      if (deadline - clock() >= minStepMs) {
        const progress = await advance(sw.tenantId, { deadline, minStepMs });
        summary.advanced += 1;
        if (!progress.open || progress.open.id !== sw.id) {
          const after = await deps.switches.findById(sw.id);
          if (after?.status === SWITCH.DONE) summary.done += 1;
          continue;
        }
      }
      if (clock() - sw.createdAt.getTime() > SWITCH_STUCK_MS) {
        summary.stuck += 1;
        log.error?.(
          { metric: "billing.currency_switch.stuck", tenantId: sw.tenantId, switchId: sw.id, status: sw.status, error: sw.error, since: sw.createdAt },
          "A currency switch has been open for more than 30 minutes",
        );
      }
    }

    if (deps.currencySwitchEnabled && freeIds.length > 0) {
      const mismatched = await deps.accounts.listCurrencyMismatches({
        rules,
        freeItemPriceIds: freeIds,
        abandonedSince: new Date(clock() - CONVERGE_BACKOFF_MS),
        limit: CONVERGE_LIMIT,
      });
      for (const acct of mismatched) {
        if (deadline - clock() < minStepMs) break;
        try {
          const target = currencyForCountry(acct.billingCountry, rules);
          if (!settingsFor(deps.catalog, target).freeItemPriceId) continue;
          const record = await deps.chargebee.subscription(acct.chargebeeSubscriptionId!);
          if (!isFreeSubscriptionRecord(record)) continue;
          log.warn?.(
            { metric: "billing.currency_switch.mismatch", tenantId: acct.tenantId, currency: acct.currency, billingCountry: acct.billingCountry, toCurrency: target },
            "A free org is billed in another currency than its country's; requesting a switch",
          );
          if (await request(acct.tenantId, target)) summary.requested += 1;
        } catch (err) {
          log.warn?.({ metric: "billing.currency_switch.converge_failed", tenantId: acct.tenantId, err: errorMessage(err) }, "Could not request a switch");
        }
      }
    }
    return summary;
  }

  const service: CurrencySwitcher & { advanceOpen: typeof advanceOpen } = { request, advance, advanceOpen };
  return service;
}

export type CurrencySwitchService = ReturnType<typeof createCurrencySwitchService>;
