/**
 * The billing address an org keeps in Chargebee — and, through its country,
 * the currency the org is billed in (models/currency.ts).
 *
 * WHERE IT IS ENTERED (A29). In CHARGEBEE'S OWN editor: the billing page
 * opens the portal's billing-address section with Chargebee.js, on a portal
 * session from POST /api/internal/portal, and Chargebee saves the address on
 * the customer — where invoices print it from, and where the page reads it
 * back. Billing never writes the address. When the editor closes, the page
 * asks billing to SYNC (POST /api/internal/billing-address/sync), and a
 * `customer_changed` webhook does the same for an org that has confirmed one
 * before. Billing keeps only the COUNTRY (`billing_account.billing_country`),
 * because that decides which subscription, in which currency, the org is on.
 *
 * THE COUNTRY IS ALWAYS KEPT. The address is already in Chargebee; refusing
 * its country here would only leave the two disagreeing. What it does to the
 * currency:
 *
 *   no subscription, or a cancelled one   nothing now. The org's next
 *                                         subscription — the free plan the
 *                                         billing page puts it on, or a paid
 *                                         checkout — is in the new country's
 *                                         currency. Never provisioned from
 *                                         here (A3): the page loads again
 *                                         right after the sync, and does it.
 *   the subscription's own currency       nothing.
 *   a FREE subscription, in another       a currency switch is asked for, and
 *   currency                              run inline for what is left of the
 *                                         request's time; the worker finishes
 *                                         it (currency-switch.service.ts).
 *                                         What it waits on — an unpaid top-up,
 *                                         credits still being set up — is the
 *                                         switch's to wait out in REQUESTED,
 *                                         and is said in `waitingOn`.
 *   a PAID plan, in another currency —    nothing: the plan keeps its currency
 *   or any plan while switching is off    (D4, A23), and the page says so
 *                                         (`currencyLocked`).
 *
 * A switch already MOVING the org is left to finish, whatever the new country
 * wants: the worker asks for the switch back once it is done (A1's
 * convergence). One only asked for, towards a currency the new country no
 * longer wants, is moot and abandoned.
 *
 * THE ANSWER IS WHAT HAPPENED (A3). 200 once the country is kept — even when
 * the switch could not be asked for or advanced inline: the country IS kept,
 * and the worker carries the switch on. A 5xx means nothing was kept: the
 * Chargebee customer could not be read, or the country not written.
 */

import type { ChargebeeClient } from "../integrations/chargebee";
import { ACCOUNT } from "../models/account-status";
import { currencyForCountry, freeItemPriceIds, normaliseCountry, settingsFor, type CurrencyCatalog } from "../models/currency";
import { isFreeSubscriptionRecord } from "../models/subscription";
import type { BillingAccount, BillingAccountRepository } from "../repositories/billing-account.repository";
import { SWITCH, type CurrencySwitch, type CurrencySwitchRepository } from "../repositories/currency-switch.repository";
import { errorMessage, notFound } from "../shared/errors";
import type { Logger } from "../shared/logger";
import type { AccountService } from "./account.service";
import { currencySwitchView, type CurrencySwitchView } from "./billing-overview.service";

/**
 * Why a currency switch is waiting on something the ORG must do, or wait
 * out — as the page names it:
 *
 *   topup-unpaid         a top-up is owed: "Pay the unpaid top-up to finish
 *                        changing your currency"
 *   topup-pending        a paid top-up is still being added to the balance
 *   billing-activating   the org's credits are still being set up
 *
 * Stable kebab-case codes, like the routes' error codes. A switch waiting on
 * anything else — Chargebee, usage still being billed — is not waiting on the
 * org, and says nothing.
 */
export type SwitchWaitReason = "topup-unpaid" | "topup-pending" | "billing-activating";

/** What one inline run of the org's currency switch left behind. */
export interface SwitchProgress {
  /** The org's open switch after the run; null when none is open any more (done, or given up). */
  open: CurrencySwitch | null;
  /** Why it is not moving on, when that is the org's to settle (SwitchWaitReason); null otherwise. */
  waitingOn: SwitchWaitReason | null;
}

/**
 * What the billing address sync asks of the currency switch
 * (services/currency-switch.service.ts, which implements it). Absent, a
 * change of currency is still kept — the country is the org's to set — and
 * the worker, finding a free subscription in another currency than its
 * country's, asks for the switch itself (A1's convergence).
 */
export interface CurrencySwitcher {
  /**
   * Ask for a switch of the org's subscription to `toCurrency`: a REQUESTED
   * row, and nothing else. Idempotent — an open REQUESTED switch to the same
   * currency is the answer, and an insert that loses the race to another (the
   * one-open-switch index) reads that one (A3). Returns the org's open switch
   * afterwards, which may be another one still finishing; null with none.
   */
  request(tenantId: string, toCurrency: string): Promise<CurrencySwitch | null>;
  /**
   * Run the org's open switch until it is done, waiting on something, or
   * `deadline` (epoch ms) — never STARTING a step with less than `minStepMs`
   * left, and bounding each Chargebee call by the time remaining (A3). Does
   * not throw for what Chargebee answers: the switch waits, and the worker
   * carries it on.
   */
  advance(tenantId: string, opts: { deadline: number; minStepMs: number }): Promise<SwitchProgress>;
}

/**
 * What a sync answers — the same keys whatever happened, so the page tells
 * the org what its save did without guessing (A29). The page loads the
 * billing state again afterwards.
 */
export interface BillingAddressSynced {
  /** Whether a country was read off the Chargebee address, and kept. */
  synced: boolean;
  /** Why not: the address in Chargebee has no country (`no-country`) — or there is none. Null when synced. */
  reason: "no-country" | null;
  /** The country kept: the address's when synced, else the one kept before (null for none). */
  billingCountry: string | null;
  /** The currency the org is billed in after the sync: its subscription's. Null with no subscription. */
  currency: string | null;
  currencySwitch: CurrencySwitchView | null;
  /** The org's subscription keeps a currency other than its country's (D4, A23); the page says so. */
  currencyLocked: boolean;
  /** Why the switch the sync asked for is waiting on the org (SwitchWaitReason); null when it is not. */
  waitingOn: SwitchWaitReason | null;
}

/** What a sync decided about the org's currency (logged, and part of the answer). */
type Outcome =
  /** No live subscription: the next one is in the country's currency. */
  | "unsubscribed"
  /** Already billed in the country's currency. */
  | "same"
  /** The subscription keeps its currency: paid, or switching is off or not set up. */
  | "locked"
  /** A switch to the country's currency was asked for, or is under way. */
  | "switch"
  /** The subscription's currency could not be told; the worker decides later. */
  | "unknown";

/**
 * The least time left for the request to START a step of the switch inline;
 * any less, and the worker does it. A Chargebee call is about a third of a
 * second warm (MEASURED), and a step makes a few (A3).
 */
export const MIN_INLINE_STEP_MS = 1_500;

export function createBillingAddressService(deps: {
  chargebee: ChargebeeClient;
  accountService: Pick<AccountService, "ensureLocalAccount">;
  accounts: BillingAccountRepository;
  switches: Pick<CurrencySwitchRepository, "findOpen" | "latestFor" | "abandonIfRequested">;
  /** Every billing currency's free plan and top-up, and the rule that picks a currency. */
  catalog: CurrencyCatalog;
  /** BILLING_CURRENCY_SWITCH_ENABLED. Off, a live free subscription keeps its currency like a paid one (A23). */
  currencySwitchEnabled?: boolean;
  /** BILLING_SWITCH_INLINE_MS: how long, from the request's start, the switch may run inline. */
  switchInlineMs?: number;
  currencySwitch?: CurrencySwitcher;
  clock?: () => number;
  logger?: Logger;
}) {
  const log = deps.logger ?? console;
  const clock = deps.clock ?? (() => Date.now());
  const switchInlineMs = deps.switchInlineMs ?? 6_000;
  const rules = deps.catalog.rules;
  // A switch makes the new subscription on the target currency's free plan:
  // with none configured (all or none, config.ts), there is nothing to make.
  const freePlansConfigured = freeItemPriceIds(deps.catalog).length > 0;

  /**
   * Keep the country of the billing address the org saved in Chargebee, and
   * with it the currency it is billed in. `startedAt` is when the request
   * arrived: the inline switch is budgeted from there, so the whole request
   * answers within the platform's timeout. `inline` false asks for a switch
   * and leaves running it to the worker — for a webhook, which Chargebee
   * waits on and retries.
   */
  async function syncBillingAddress(
    tenantId: string,
    { startedAt, inline = true }: { startedAt?: number; inline?: boolean } = {},
  ): Promise<BillingAddressSynced> {
    const deadline = (startedAt ?? clock()) + switchInlineMs;
    const account = await deps.accountService.ensureLocalAccount(tenantId);
    if (!account) throw notFound("Unknown tenant", "tenant-not-found");

    // The address as Chargebee holds it — read, never taken from the caller.
    // No customer has no address: the portal makes the customer before it
    // opens (portal.service.ts), so that is an org that never saved one.
    const customer = account.chargebeeCustomerId ? await deps.chargebee.customer(account.chargebeeCustomerId) : null;
    const country = normaliseCountry(customer?.billingAddress?.country);
    if (country == null) {
      // An address saved with no country, or none at all: there is nothing
      // to bill by, and a country kept before stays kept — an org is never
      // moved back to the default currency by an address it half-cleared.
      log[account.billingCountry ? "warn" : "log"]?.(
        { metric: "billing.address.no_country", tenantId, billingCountry: account.billingCountry, hasAddress: customer?.billingAddress != null },
        account.billingCountry
          ? "The billing address in Chargebee has no country; the country confirmed before is kept"
          : "No billing address with a country in Chargebee yet; nothing to keep",
      );
      return answer(account.tenantId, { synced: false, reason: "no-country", wanted: null, current: null, locked: false, waitingOn: null });
    }

    if (account.billingCountry !== country) await deps.accounts.setBillingCountry(tenantId, country);
    const target = currencyForCountry(country, rules);

    // The country is kept. What follows decides the currency, and never
    // fails the sync: whatever does not happen here, the worker does.
    let decided: { outcome: Outcome; current: string | null; waitingOn: SwitchWaitReason | null };
    try {
      decided = await moveCurrency(account, target, { deadline, inline });
    } catch (err) {
      log.error?.(
        { metric: "billing.address.currency_sync_failed", tenantId, country, toCurrency: target, err: errorMessage(err) },
        "The billing country is kept, but its currency could not be decided now; the worker asks for any switch it needs",
      );
      decided = { outcome: "unknown", current: null, waitingOn: null };
    }
    log.log?.(
      {
        metric: "billing.address.synced",
        tenantId,
        country,
        from: account.billingCountry,
        toCurrency: target,
        currency: decided.current,
        outcome: decided.outcome,
        waitingOn: decided.waitingOn,
      },
      decided.outcome === "switch" ? "Billing address synced; its country moves the org to another currency" : "Billing address synced",
    );
    return answer(account.tenantId, {
      synced: true,
      reason: null,
      wanted: target,
      current: decided.current,
      locked: decided.outcome === "locked",
      waitingOn: decided.waitingOn,
    });
  }

  /**
   * Bring the org's currency to `target`, its country's — or say why not.
   *
   * A REQUESTED switch to another currency is moot whatever else holds, and
   * is abandoned first — if and only if it has not started meanwhile (A1);
   * START reads the country under the account's row lock too, so one racing
   * this sync abandons itself instead. Then the subscription: its currency
   * stored at the link, else read off the live record — which is read anyway
   * when the currency would change, because whether it is FREE is decided
   * from the live record (A20), never from the plan's id.
   */
  async function moveCurrency(
    account: BillingAccount,
    target: string,
    { deadline, inline }: { deadline: number; inline: boolean },
  ): Promise<{ outcome: Outcome; current: string | null; waitingOn: SwitchWaitReason | null }> {
    const tenantId = account.tenantId;
    const open = await deps.switches.findOpen(tenantId);
    if (open?.status === SWITCH.REQUESTED && open.toCurrency !== target) {
      const abandoned = await deps.switches.abandonIfRequested(open.id, "country_changed", new Date(clock()));
      log.log?.(
        { metric: "billing.currency_switch.abandoned", tenantId, switchId: open.id, toCurrency: open.toCurrency, reason: "country_changed", abandoned },
        abandoned
          ? "The org's billing country no longer wants the currency its switch was asked for; the switch is abandoned"
          : "The switch the new country makes moot had already started; it finishes, and the worker asks for the way back",
      );
    }

    const subscribed = account.chargebeeSubscriptionId != null && account.status !== ACCOUNT.CANCELLED;
    if (!subscribed) return { outcome: "unsubscribed", current: null, waitingOn: null };

    const record = account.currency === target ? null : await deps.chargebee.subscription(account.chargebeeSubscriptionId!);
    const current = account.currency ?? recordCurrency(record);
    if (current == null) {
      log.warn?.(
        { metric: "billing.address.currency_unknown", tenantId, subscriptionId: account.chargebeeSubscriptionId },
        "The subscription's currency could not be read; the country is kept, and the worker decides whether to switch",
      );
      return { outcome: "unknown", current: null, waitingOn: null };
    }
    if (current === target) return { outcome: "same", current, waitingOn: null };
    if (!isFreeSubscriptionRecord(record) || !deps.currencySwitchEnabled) return { outcome: "locked", current, waitingOn: null };
    if (!freePlansConfigured || !settingsFor(deps.catalog, target).freeItemPriceId) {
      log.error?.(
        { metric: "billing.currency_switch.misconfigured", tenantId, toCurrency: target, reason: "no free plan" },
        "A free subscription's billing country wants a currency with no free plan (FREE_PLAN_ITEM_PRICE_ID_<currency>); it keeps its currency",
      );
      return { outcome: "locked", current, waitingOn: null };
    }

    // A switch already moving the org finishes first — to wherever it was
    // going. If that is not the country's currency any more, the worker asks
    // for the way back once it is done (A1's convergence); nothing here can.
    const now = await deps.switches.findOpen(tenantId);
    if (now && hasStarted(now) && now.toCurrency !== target) {
      log.warn?.(
        { metric: "billing.currency_switch.request_deferred", tenantId, toCurrency: target, open: { id: now.id, status: now.status, toCurrency: now.toCurrency } },
        "A currency switch of this org is still moving it elsewhere; the worker asks for this one once it has finished",
      );
      return { outcome: "switch", current, waitingOn: null };
    }
    return { outcome: "switch", current, waitingOn: await switchCurrency(tenantId, target, { deadline, inline }) };
  }

  /**
   * Ask for the switch, then run what fits of it before the request's
   * deadline. Never fails the sync: the country is kept, and whatever did not
   * happen here the worker does (A3). Returns what the switch says it waits
   * on, when that is the org's to settle.
   */
  async function switchCurrency(
    tenantId: string,
    target: string,
    { deadline, inline }: { deadline: number; inline: boolean },
  ): Promise<SwitchWaitReason | null> {
    if (!deps.currencySwitch) {
      log.warn?.(
        { metric: "billing.currency_switch.not_wired", tenantId, toCurrency: target },
        "No currency switch is wired here; the country is kept, and the worker asks for the switch",
      );
      return null;
    }
    try {
      const open = await deps.currencySwitch.request(tenantId, target);
      if (open?.toCurrency !== target) {
        // The one-open-switch index keeps a new one out while the last is
        // still finishing (cancelling its old subscription).
        log.warn?.(
          { metric: "billing.currency_switch.request_deferred", tenantId, toCurrency: target, open: open ? { id: open.id, status: open.status, toCurrency: open.toCurrency } : null },
          "Another currency switch of this org is still finishing; the worker asks for this one once it has",
        );
        return null;
      }
      if (!inline || deadline - clock() < MIN_INLINE_STEP_MS) return null;
      return (await deps.currencySwitch.advance(tenantId, { deadline, minStepMs: MIN_INLINE_STEP_MS })).waitingOn;
    } catch (err) {
      log.error?.(
        { metric: "billing.currency_switch.inline_failed", tenantId, toCurrency: target, err: errorMessage(err) },
        "The billing country is kept, but its currency switch could not be asked for or advanced inline; the worker carries it on",
      );
      return null;
    }
  }

  /** The answer, from the account and its switches as they now stand — the inline switch may have moved them. */
  async function answer(
    tenantId: string,
    d: { synced: boolean; reason: "no-country" | null; wanted: string | null; current: string | null; locked: boolean; waitingOn: SwitchWaitReason | null },
  ): Promise<BillingAddressSynced> {
    const after = await deps.accounts.findByTenantId(tenantId);
    const currency = after?.chargebeeSubscriptionId ? (after.currency ?? d.current) : null;
    const wanted = d.wanted ?? (after?.billingCountry ? currencyForCountry(after.billingCountry, rules) : null);
    const open = await deps.switches.findOpen(tenantId);
    const latest = open ? null : await deps.switches.latestFor(tenantId);
    return {
      synced: d.synced,
      reason: d.reason,
      billingCountry: after?.billingCountry ?? null,
      currency,
      currencySwitch: currencySwitchView(open, latest, { currency, wanted }, clock()),
      // Still in another currency than the country's: a switch that finished
      // inline has unlocked nothing to say.
      currencyLocked: d.locked && currency != null && currency !== wanted,
      waitingOn: d.waitingOn,
    };
  }

  return { syncBillingAddress };
}

export type BillingAddressService = ReturnType<typeof createBillingAddressService>;

/**
 * Has this open switch started moving the org — credits moving, or linked
 * with its cap not moved yet? Then it finishes before any other is asked
 * for. One only REQUESTED has not; one whose cap has moved blocks nothing
 * (A17), and keeps a new one out only until it is done.
 */
function hasStarted(open: CurrencySwitch): boolean {
  return open.status === SWITCH.MOVING || (open.status === SWITCH.LINKED && open.activatedAt == null);
}

/** A subscription record's `currency_code`, or null. */
function recordCurrency(record: Record<string, unknown> | null): string | null {
  return typeof record?.currency_code === "string" ? record.currency_code : null;
}
