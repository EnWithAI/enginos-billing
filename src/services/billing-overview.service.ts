/**
 * Everything the billing page shows about one tenant.
 *
 * EVERY CREDIT FIGURE COMES FROM CHARGEBEE. There is no local ledger and no
 * cached balance column to go stale: the balance is `/ledger_account_balances`,
 * the grant is `/grant_blocks`, and the payments are Chargebee's transactions.
 * Postgres contributes the identifiers, the status, and how far the usage sync
 * has reached.
 *
 * That makes the page depend on Chargebee being reachable, so EACH read
 * degrades on its own rather than failing the whole overview: credits that
 * cannot be read are zeros with the status still correct, payments are null
 * ("could not load", not "none"), and the subscription is null.
 *
 * Two things come from Postgres, and both are about the sync rather than the
 * money: `lastSync` (the newest settled window) and the account status.
 * Chargebee cannot answer either — it knows what it was told, not what we
 * failed to tell it.
 *
 * CURRENCY. Every kind of overview also says what the page needs to ask for
 * a billing address first and to sell in one currency only (CurrencyFacts):
 * the country the org confirmed, the address Chargebee holds, the currency
 * the org is billed in, the rule that maps one to the other, and any
 * currency switch. A pack is offered only in the subscription's currency,
 * only once a country is confirmed, and never while a switch is open; the
 * plans only in the confirmed country's currency. A switch is only READ here
 * — the page polls while one runs, and advancing it from a read would spend
 * Chargebee's 150 calls a minute on polling (A22); the address sync and the
 * worker advance it. While the account is `switching` the page reads the
 * database alone.
 */

import type {
  ChargebeeClient,
  CustomerBillingAddress,
  PaymentSource,
  Transaction,
  UnpaidInvoice,
} from "../integrations/chargebee";
import { ACCOUNT } from "../models/account-status";
import {
  currencyForCountry,
  freeItemPriceIds,
  settingsFor,
  topUpItemPriceIds,
  type CurrencyCatalog,
  type CurrencyRules,
  type TopUpSettingsForCurrency,
} from "../models/currency";
import { compare, subtract, subtractFloorZero } from "../models/decimal";
import { freePlanFor } from "../models/free-plan";
import { isFreeSubscriptionRecord } from "../models/subscription";
import type { BillingAccount, BillingAccountRepository } from "../repositories/billing-account.repository";
import type { ChargebeeSyncRepository } from "../repositories/chargebee-sync.repository";
import { SWITCH, type CurrencySwitch, type CurrencySwitchRepository } from "../repositories/currency-switch.repository";
import { errorMessage } from "../shared/errors";
import type { Logger } from "../shared/logger";
import type { AccountService } from "./account.service";
import type { PlanOffer, TopUpOffer } from "./plan-catalog.service";

export interface Credits {
  granted: string;
  allocated: string;
  consumed: string;
  current: string;
}

export interface SubscriptionDetails {
  record: Record<string, unknown>;
  card: PaymentSource | null;
}

export type LastSync = NonNullable<Awaited<ReturnType<ChargebeeSyncRepository["latestSettled"]>>>;

/** The billing address Chargebee holds for the customer, as the page shows it and pre-fills its form from (§1.1). */
export type BillingAddressView = Pick<
  CustomerBillingAddress,
  "firstName" | "lastName" | "company" | "line1" | "line2" | "city" | "state" | "stateCode" | "zip" | "country"
>;

/** A currency switch as the page is told about it. */
export interface CurrencySwitchView {
  fromCurrency: string;
  toCurrency: string;
  /**
   *   pending    asked for, not started (REQUESTED)
   *   moving     the credits are being moved (MOVING)
   *   finishing  billing is on the new subscription, the cap not moved yet
   *              (LINKED, not activated)
   *   failed     given up in the last day, for a reason the org did not
   *              choose, and still not the currency it is billed in (A1)
   */
  state: "pending" | "moving" | "finishing" | "failed";
  /** Why it failed — a short machine token (`timed_out`, `chargebee_refused`). Null unless `failed`. */
  reason: string | null;
  since: Date;
}

/**
 * What saving a billing address in ANOTHER currency would do right now —
 * decided as the address sync decides it (billing-address.service.ts), so
 * the page can say so before the org saves (A6):
 *
 *   switch   the org is on a free subscription, live: it is switched, and its
 *            credits carry over
 *   locked   a paid plan keeps its currency (D4) — and so does every plan
 *            while the switch is turned off (BILLING_CURRENCY_SWITCH_ENABLED),
 *            or with no free plan configured to switch to
 *   none     nothing would be switched now: no subscription, a cancelled
 *            one, or one being set up or already switching
 */
export type CurrencyChange = "switch" | "locked" | "none";

/** What every kind of overview says about the org's billing address and currency (§1.1). */
export interface CurrencyFacts {
  /** The country the org CONFIRMED (ISO 3166-1 alpha-2). Null: the page asks for the address first, and sells nothing. */
  billingCountry: string | null;
  /** The address Chargebee holds. Null when there is none, or it could not be read. */
  billingAddress: BillingAddressView | null;
  /** The currency the org is billed in: its subscription's. Null with no subscription. */
  currency: string | null;
  /** How a country becomes a currency, so the page can warn before a change. Null only with no catalog wired (tests). */
  currencyRules: CurrencyRules | null;
  currencySwitch: CurrencySwitchView | null;
  /**
   * The subscription is in another currency than the confirmed country's and
   * keeps it — a paid plan (D4), or a free one while switching is off (A23) —
   * and the page says so.
   */
  currencyLocked: boolean;
  currencyChange: CurrencyChange;
  /** The confirmed country's currency has no paid plan on the allowlist (A24): `plansOffered` cannot offer one. */
  plansMissingForCurrency: boolean;
  /** Whether a saved billing address may be changed (BILLING_ADDRESS_EDIT_ENABLED). The first one is always added. */
  addressEditable: boolean;
}

/**
 * Every shape carries `freePlan`: whether this org is put on the free plan
 * (models/free-plan.ts). An org with no subscription and no free plan is one
 * that chooses from `plansOffered`, which then leaves the free plan out. And
 * every shape carries the same CurrencyFacts: the page asks for the address
 * whatever state the org is in.
 */
export type BillingOverview =
  /** No billing row at all — every org starts here, and it is a normal state. */
  | ({ kind: "unlinked"; plansOffered: PlanOffer[]; freePlan: boolean } & CurrencyFacts)
  /** Paid, but the gateway does not hold the budget yet, so no credits are shown. */
  | ({ kind: "activating"; plansOffered: PlanOffer[]; freePlan: boolean; account: BillingAccount } & CurrencyFacts)
  /** A currency switch is moving the credits: none are shown, and nothing but the database is read. */
  | ({ kind: "switching"; plansOffered: PlanOffer[]; freePlan: boolean; account: BillingAccount } & CurrencyFacts)
  | ({
      kind: "linked";
      plansOffered: PlanOffer[];
      freePlan: boolean;
      account: BillingAccount;
      credits: Credits;
      /** The newest page. Null when Chargebee could not be reached — distinct from "no payments". */
      payments: Transaction[] | null;
      /** Chargebee's cursor for the page after `payments`; null when there is none. */
      paymentsNextOffset: string | null;
      subscription: SubscriptionDetails | null;
      lastSync: LastSync | null;
      /**
       * What buying more credits costs — in the subscription's currency, and
       * only once the org has confirmed a billing country, with no currency
       * switch open and a live subscription. Null otherwise, when no top-up is
       * configured in that currency, or no describer is wired (tests).
       */
      topUp: TopUpOffer | null;
      /**
       * Top-ups whose card declined and Chargebee has not collected since —
       * their credits are already in use. Null when Chargebee could not be
       * asked, which is not "nothing owed".
       */
      unpaidTopUps: UnpaidInvoice[] | null;
    } & CurrencyFacts);

/** Payments shown per page of the billing page's history. */
export const PAYMENTS_PAGE_SIZE = 10;

/** How long a switch that was given up is shown as `failed`. */
export const FAILED_SWITCH_SHOWN_MS = 24 * 60 * 60_000;

const NO_CREDITS: Credits = { granted: "0", allocated: "0", consumed: "0", current: "0" };

/** Currencies `billing.plans.currency_missing` was raised for — once per process each. */
const reportedMissingPlans = new Set<string>();

/**
 * The page's view of an org's currency switch.
 *
 * Its OPEN switch, while it blocks anything: REQUESTED, MOVING, and LINKED
 * until the cap has moved. Once activated the switch is done as far as the
 * page is concerned: what is left — cancelling the old subscription — is a
 * background chore (A17).
 *
 * With none open, the most recent one if it FAILED: given up in the last
 * day, still towards the currency the confirmed country wants, and still not
 * the one the org is billed in — the page says the currency could not be
 * changed and that billing tries again (A1). Not a switch the org's own
 * address change made moot (`country_changed`): that one was not a failure.
 *
 * Shared by the billing page and the billing address sync, so both answer
 * the same.
 */
export function currencySwitchView(
  open: CurrencySwitch | null,
  latest: CurrencySwitch | null,
  org: { currency: string | null; wanted: string | null },
  now: number,
): CurrencySwitchView | null {
  if (open) {
    const view = (state: CurrencySwitchView["state"], since: Date): CurrencySwitchView => ({
      fromCurrency: open.fromCurrency,
      toCurrency: open.toCurrency,
      state,
      reason: null,
      since,
    });
    if (open.status === SWITCH.REQUESTED) return view("pending", open.createdAt);
    if (open.status === SWITCH.MOVING) return view("moving", open.movingAt ?? open.updatedAt);
    if (open.status === SWITCH.LINKED && open.activatedAt == null) return view("finishing", open.linkedAt ?? open.updatedAt);
    return null;
  }
  if (latest?.status !== SWITCH.ABANDONED) return null;
  // ABANDONED keeps `completed_at` null (only DONE sets it): when it ended is `updated_at`.
  if (now - latest.updatedAt.getTime() > FAILED_SWITCH_SHOWN_MS) return null;
  const reason = latest.error ?? "unknown";
  if (reason === "country_changed") return null;
  if (latest.toCurrency !== org.wanted || latest.toCurrency === org.currency) return null;
  return { fromCurrency: latest.fromCurrency, toCurrency: latest.toCurrency, state: "failed", reason, since: latest.updatedAt };
}

/** The address fields the page is given — never the email, phone or third line Chargebee also holds. */
function addressView(held: CustomerBillingAddress | null | undefined): BillingAddressView | null {
  if (!held) return null;
  const { firstName, lastName, company, line1, line2, city, state, stateCode, zip, country } = held;
  return { firstName, lastName, company, line1, line2, city, state, stateCode, zip, country };
}

export function createBillingOverviewService(deps: {
  chargebee: ChargebeeClient;
  accountService: AccountService;
  accounts: BillingAccountRepository;
  syncs: ChargebeeSyncRepository;
  /** The offered plans, described. Must never throw — see plan-catalog.service.ts. */
  plansOffered: () => Promise<PlanOffer[]>;
  /** One currency's top-up charge, described. Must never throw — see describeTopUp. */
  topUpOffer?: (topUp: TopUpSettingsForCurrency) => Promise<TopUpOffer>;
  /**
   * Puts an org with no subscription on the free plan (checkout.provisionFreePlan).
   * The billing page's fallback for the sign-up hook. Absent: none.
   */
  autoSubscribe?: (tenantId: string) => Promise<unknown>;
  /**
   * Every billing currency's free plan and top-up, and the rule that picks a
   * currency (models/currency.ts): the free plans are left out of
   * `plansOffered` for an org they are not for, every currency's top-up is
   * looked at for unpaid packs, and the one offered is the subscription's
   * currency's. Absent (tests): none of them, and no rules.
   */
  catalog?: CurrencyCatalog;
  /**
   * The org's currency switches (currency-switch.repository.ts) — READ only:
   * the page never advances one (A22). Absent: none.
   */
  switches?: Pick<CurrencySwitchRepository, "findOpen" | "latestFor">;
  /** BILLING_CURRENCY_SWITCH_ENABLED. Off, a free subscription's currency is `locked` like a paid one's (A23). */
  currencySwitchEnabled?: boolean;
  /** Whether an org with no setting of its own gets the free plan (FREE_PLAN_DEFAULT). */
  freePlanDefault?: boolean;
  /** BILLING_ADDRESS_EDIT_ENABLED. Absent: a saved address may be changed. */
  addressEditEnabled?: boolean;
  clock?: () => number;
  logger?: Logger;
}) {
  const log = deps.logger ?? console;
  const clock = deps.clock ?? (() => Date.now());
  const rules = deps.catalog?.rules ?? null;
  const freePlans = deps.catalog ? freeItemPriceIds(deps.catalog) : [];
  const topUpPrices = deps.catalog ? topUpItemPriceIds(deps.catalog) : [];
  const addressEditable = deps.addressEditEnabled ?? true;

  async function overview(tenantId: string): Promise<BillingOverview> {
    const account = await subscribeIfNeeded(tenantId, await findOrCreateAccount(tenantId));
    const freePlan = freePlanFor(account, deps.freePlanDefault ?? false);

    if (!account) {
      const plans = await offerPlans(null, freePlan, null);
      return {
        kind: "unlinked",
        plansOffered: plans.offered,
        freePlan,
        billingCountry: null,
        billingAddress: null,
        currency: null,
        currencyRules: rules,
        currencySwitch: null,
        currencyLocked: false,
        currencyChange: "none",
        plansMissingForCurrency: plans.missing,
        addressEditable,
      };
    }

    // The currency the org's confirmed country is billed in; none before it
    // has confirmed one — the page asks for the address first.
    const wanted = account.billingCountry && rules ? currencyForCountry(account.billingCountry, rules) : null;

    // Switching: the database alone (A22). The page polls every few seconds
    // while the credits move, and a site may make 150 Chargebee calls a
    // minute; the credits, payments and plans are shown again once it has.
    if (account.status === ACCOUNT.SWITCHING) {
      return {
        kind: "switching",
        plansOffered: [],
        freePlan,
        account,
        billingCountry: account.billingCountry,
        billingAddress: null,
        currency: account.currency,
        currencyRules: rules,
        currencySwitch: await readSwitch(account, wanted),
        currencyLocked: false,
        currencyChange: "none",
        plansMissingForCurrency: false,
        addressEditable,
      };
    }

    if (account.status === ACCOUNT.ACTIVATING) {
      const [plans, billingAddress, currencySwitch] = await Promise.all([
        offerPlans(account, freePlan, wanted),
        readAddress(account),
        readSwitch(account, wanted),
      ]);
      return {
        kind: "activating",
        plansOffered: plans.offered,
        freePlan,
        account,
        billingCountry: account.billingCountry,
        billingAddress,
        currency: account.currency,
        currencyRules: rules,
        currencySwitch,
        currencyLocked: locked(account, account.currency, wanted, onFreePlan(account)),
        currencyChange: "none",
        plansMissingForCurrency: plans.missing,
        addressEditable,
      };
    }

    const [plans, credits, paymentsPage, subscription, lastSync, unpaidTopUps, billingAddress, currencySwitch] = await Promise.all([
      offerPlans(account, freePlan, wanted),
      readCredits(account.chargebeeSubscriptionId, account.ledgerUnitId, account.chargebeeCustomerId),
      readPayments(account.chargebeeCustomerId),
      readSubscription(account.chargebeeSubscriptionId, account.chargebeeCustomerId),
      deps.syncs.latestSettled(account.tenantId),
      readUnpaidTopUps(account.chargebeeCustomerId),
      readAddress(account),
      readSwitch(account, wanted),
    ]);

    // The subscription's currency: stored at the link, else read off the live
    // record (an account linked before the currency was stored).
    const currency = account.chargebeeSubscriptionId ? (account.currency ?? recordCurrency(subscription?.record)) : null;
    // Free or paid, from the LIVE record where there is one (A20): a ₹0 plan
    // with a paid addon is not free. Unread, the plan's id is the best guess.
    const free = subscription ? isFreeSubscriptionRecord(subscription.record) : onFreePlan(account);

    return {
      kind: "linked",
      plansOffered: plans.offered,
      freePlan,
      account,
      credits,
      payments: paymentsPage?.transactions ?? null,
      paymentsNextOffset: paymentsPage?.nextOffset ?? null,
      subscription,
      lastSync,
      topUp: await offerTopUp(account, currency, currencySwitch),
      unpaidTopUps,
      billingCountry: account.billingCountry,
      billingAddress,
      currency,
      currencyRules: rules,
      currencySwitch,
      currencyLocked: locked(account, currency, wanted, free),
      currencyChange: currencyChange(account, free),
      plansMissingForCurrency: plans.missing,
      addressEditable,
    };
  }

  /**
   * The ONE top-up the page may offer: the subscription's currency's, and
   * only once the org has confirmed a billing country (R1), with no currency
   * switch blocking (a failed one does not), on a live subscription. So the
   * page can never show two currencies' packs, nor one in a currency the
   * subscription refuses to be charged in (R5, R6). Null when any of that
   * does not hold, or no top-up is configured in the currency.
   */
  async function offerTopUp(
    account: BillingAccount,
    currency: string | null,
    currencySwitch: CurrencySwitchView | null,
  ): Promise<TopUpOffer | null> {
    const live = account.status === ACCOUNT.ACTIVE || account.status === ACCOUNT.EXHAUSTED;
    const blocked = currencySwitch != null && currencySwitch.state !== "failed";
    if (!account.billingCountry || !account.chargebeeSubscriptionId || !live || blocked || !currency) return null;
    const topUp = deps.catalog ? settingsFor(deps.catalog, currency).topUp : null;
    return topUp && deps.topUpOffer ? deps.topUpOffer(topUp) : null;
  }

  /**
   * The plans the page offers, and whether the org's currency has none.
   *
   * In the confirmed country's currency only — read from the Chargebee
   * catalogue — and none before the org has confirmed one: the page asks for
   * the address first. The free plans are left out for an org they are not
   * for. The org's CURRENT plan is always kept, whatever its currency,
   * because the page names it from this list.
   *
   * `missing`: the currency has no paid plan on the allowlist at all — so an
   * org outside the countries that have one cannot subscribe (A24; no USD
   * plan exists today). Raised once per process per currency, as an error:
   * the catalogue needs a plan, or the org needs a person. Not while any
   * plan could not be read — that says nothing about the catalogue.
   */
  async function offerPlans(
    account: BillingAccount | null,
    freePlan: boolean,
    wanted: string | null,
  ): Promise<{ offered: PlanOffer[]; missing: boolean }> {
    const all = await deps.plansOffered();
    const current = account?.chargebeeItemPriceId ?? null;
    const offered = all.filter((plan) => {
      if (plan.itemPriceId === current) return true;
      if (!freePlan && freePlans.includes(plan.itemPriceId)) return false;
      return wanted != null && plan.currencyCode === wanted;
    });
    const paid = all.filter((plan) => !freePlans.includes(plan.itemPriceId));
    const missing = wanted != null && paid.every((plan) => plan.resolved) && !paid.some((plan) => plan.currencyCode === wanted);
    if (missing && !reportedMissingPlans.has(wanted)) {
      reportedMissingPlans.add(wanted);
      log.error?.(
        { metric: "billing.plans.currency_missing", currency: wanted, allowlisted: paid.map((plan) => plan.itemPriceId) },
        "No paid plan on ITEM_PRICE_IDS is priced in this currency; orgs billed in it cannot choose a plan. Add one to the catalogue and the allowlist",
      );
    }
    return { offered, missing };
  }

  /**
   * A subscription whose currency is not the one the confirmed country wants,
   * and that keeps it: a paid plan (D4) — or a free one that cannot be
   * switched, while switching is off (A23) or no free plan is configured to
   * switch it to. The page says so. Never before a country is confirmed.
   */
  function locked(account: BillingAccount, currency: string | null, wanted: string | null, free: boolean): boolean {
    if (!account.chargebeeSubscriptionId || account.status === ACCOUNT.CANCELLED) return false;
    return !switchable(free) && currency != null && wanted != null && currency !== wanted;
  }

  /** What saving an address in another currency would do now — the address sync's own rule (CurrencyChange). */
  function currencyChange(account: BillingAccount, free: boolean): CurrencyChange {
    if (!account.chargebeeSubscriptionId) return "none";
    if (account.status !== ACCOUNT.ACTIVE && account.status !== ACCOUNT.EXHAUSTED) return "none";
    return switchable(free) ? "switch" : "locked";
  }

  /**
   * Would a change of country switch this subscription's currency? Only a
   * free one (decided from the live record, A20), with switching on, and a
   * free plan to switch it to — the address sync's rule
   * (billing-address.service.ts), so the page predicts what a save does.
   */
  function switchable(free: boolean): boolean {
    return free && deps.currencySwitchEnabled === true && freePlans.length > 0;
  }

  /** On ANY currency's free plan, by the plan the account is linked to. */
  function onFreePlan(account: BillingAccount): boolean {
    return account.chargebeeItemPriceId != null && freePlans.includes(account.chargebeeItemPriceId);
  }

  /**
   * The billing address Chargebee holds — Chargebee's, never a copy (D3).
   * Fail-open: unread, the page shows the confirmed country alone.
   */
  async function readAddress(account: BillingAccount): Promise<BillingAddressView | null> {
    if (!account.chargebeeCustomerId) return null;
    try {
      return addressView((await deps.chargebee.customer(account.chargebeeCustomerId))?.billingAddress);
    } catch (err) {
      log.error?.(
        { metric: "billing.page.address_unreadable", tenantId: account.tenantId, err: errorMessage(err) },
        "Could not read the billing address from Chargebee; rendering the page with the country alone",
      );
      return null;
    }
  }

  /** The org's switch, from the database (currencySwitchView). */
  async function readSwitch(account: BillingAccount, wanted: string | null): Promise<CurrencySwitchView | null> {
    if (!deps.switches) return null;
    const open = await deps.switches.findOpen(account.tenantId);
    const latest = open ? null : await deps.switches.latestFor(account.tenantId);
    return currencySwitchView(open, latest, { currency: account.currency, wanted }, clock());
  }

  async function readUnpaidTopUps(customerId: string | null): Promise<UnpaidInvoice[] | null> {
    if (!customerId || topUpPrices.length === 0) return [];
    try {
      // Every currency's: a pack still owed is owed whatever it was bought in.
      return await deps.chargebee.unpaidInvoicesFor(customerId, topUpPrices);
    } catch (err) {
      log.error?.(
        { metric: "billing.page.unpaid_topups_unreadable", customerId, err: errorMessage(err) },
        "Could not read unpaid top-ups from Chargebee; rendering the page without them",
      );
      return null;
    }
  }

  /**
   * An org with no subscription is put on the free plan before the page is
   * rendered — the fallback for a sign-up hook that failed or never ran (an org
   * older than it). Fail-open: a failure is logged, the page renders the org
   * unsubscribed, and the next load tries again. An org the free plan is not
   * for is left to choose a paid plan.
   */
  async function subscribeIfNeeded(tenantId: string, account: BillingAccount | null) {
    if (!account || account.chargebeeSubscriptionId || !deps.autoSubscribe) return account;
    if (!freePlanFor(account, deps.freePlanDefault ?? false)) return account;
    try {
      await deps.autoSubscribe(tenantId);
    } catch (err) {
      log.error?.(
        { metric: "billing.free_plan.page_fallback_failed", tenantId, err: errorMessage(err) },
        "Could not put the org on the free plan on page load; rendering it unsubscribed",
      );
      return account;
    }
    return (await deps.accounts.findByTenantId(tenantId)) ?? account;
  }

  /**
   * Opening the billing page provisions the local row if it is missing.
   *
   * A read with a side effect, deliberately: this is the first moment we know
   * a real org is looking at billing, and billing is not wired into tenant
   * provisioning, so nothing else creates the row until someone checks out. It
   * creates NOTHING in Chargebee and no usage cursor.
   *
   * Idempotent, and a failure is logged and survived: a page that cannot
   * render because provisioning hiccuped would be worse than a missing row,
   * and the next load retries.
   */
  async function findOrCreateAccount(tenantId: string): Promise<BillingAccount | null> {
    try {
      return await deps.accountService.ensureLocalAccount(tenantId);
    } catch (err) {
      log.error?.(
        { metric: "billing.account.autoprovision_failed", tenantId, err: errorMessage(err) },
        "Could not create the billing row on page load; rendering unlinked",
      );
      return deps.accounts.findByTenantId(tenantId);
    }
  }

  /**
   * Granted, spent and remaining — all three from Chargebee.
   *
   * `consumed` is derived (granted − usable) rather than summed from operations:
   * a page of the last 50 operations is not the whole history, and a partial
   * sum rendered as "spent" would be worse than no number at all.
   */
  async function readCredits(
    subscriptionId: string | null,
    unitId: string | null,
    customerId: string | null,
  ): Promise<Credits> {
    if (!subscriptionId) return NO_CREDITS;
    try {
      const [balance, granted, unpaid] = await Promise.all([
        // The account's own unit, never "the first balance" (C57b).
        deps.chargebee.balance(subscriptionId, unitId),
        deps.chargebee.grantedCredits(subscriptionId, unitId ?? undefined),
        // Chargebee grants a top-up with its invoice, paid or not. A declined
        // top-up's credits are not the customer's until it is paid, so they
        // come off both figures — and stay off `consumed`. Any currency's.
        customerId && topUpPrices.length > 0
          ? deps.chargebee.unpaidTopUpCredits({
              customerId,
              subscriptionId,
              unitId: unitId ?? undefined,
              itemPriceId: topUpPrices,
            })
          : Promise.resolve("0"),
      ]);
      const grantedPaid = subtractFloorZero(granted.credits, unpaid);
      const current = subtractFloorZero(balance?.usable ?? "0", unpaid);
      // Exact, and never below zero: a float here printed "1e-7" for a tiny
      // difference and drifted on fractional grants.
      const spent = subtract(grantedPaid, current);
      return {
        granted: grantedPaid,
        allocated: grantedPaid,
        consumed: compare(spent, "0") > 0 ? spent : "0",
        current,
      };
    } catch (err) {
      log.error?.(
        { metric: "billing.page.credits_unreadable", subscriptionId, err: errorMessage(err) },
        "Could not read credit state from Chargebee; rendering the page without figures",
      );
      return NO_CREDITS;
    }
  }

  /**
   * The customer's payments, newest first — TRANSACTIONS, because only a
   * transaction can say a payment FAILED and why. Keyed on the customer, so a
   * receipt survives its subscription being cancelled and replaced.
   */
  async function readPayments(customerId: string | null) {
    if (!customerId) return { transactions: [] as Transaction[], nextOffset: null };
    try {
      return await deps.chargebee.transactionsPage(customerId, { limit: PAYMENTS_PAGE_SIZE });
    } catch (err) {
      log.error?.(
        { metric: "billing.page.payments_unreadable", customerId, err: errorMessage(err) },
        "Could not read payments from Chargebee; rendering the page without them",
      );
      return null;
    }
  }

  /**
   * The subscription as Chargebee currently sees it, read live because our
   * copy is a mirror a lost webhook can leave stale — and the card, because an
   * expired card is the most common cause of a failed payment and the one the
   * customer can fix themselves.
   */
  async function readSubscription(
    subscriptionId: string | null,
    customerId: string | null,
  ): Promise<SubscriptionDetails | null> {
    if (!subscriptionId) return null;
    try {
      const [record, card] = await Promise.all([
        deps.chargebee.subscription(subscriptionId),
        customerId ? deps.chargebee.paymentSource(customerId) : Promise.resolve(null),
      ]);
      return record ? { record, card } : null;
    } catch (err) {
      log.error?.(
        { metric: "billing.page.subscription_unreadable", subscriptionId, err: errorMessage(err) },
        "Could not read the subscription from Chargebee; rendering the page without its details",
      );
      return null;
    }
  }

  /**
   * An older page of the tenant's payments, from the cursor the page before it
   * returned. The customer is the tenant's own, resolved here — the cursor
   * only says where in that customer's list to continue.
   */
  async function paymentsPage(tenantId: string, offset?: string) {
    const account = await deps.accounts.findByTenantId(tenantId);
    if (!account?.chargebeeCustomerId) return { transactions: [] as Transaction[], nextOffset: null };
    return deps.chargebee.transactionsPage(account.chargebeeCustomerId, { limit: PAYMENTS_PAGE_SIZE, offset });
  }

  return { overview, paymentsPage };
}

/** A subscription record's `currency_code`, or null. */
function recordCurrency(record: Record<string, unknown> | undefined): string | null {
  return typeof record?.currency_code === "string" ? record.currency_code : null;
}
