/**
 * Buying: the subscription checkout, and the top-up that adds credits to it.
 *
 * SUBSCRIPTION. The customer is ensured first, with `id = tenantId`, so the
 * subscription belongs to a customer our webhook can map back to a tenant.
 * That is the whole reason checkout is created server-side rather than with
 * Chargebee's attribute drop-in: the drop-in sends no customer, Chargebee
 * creates a fresh one, and the webhook cannot tell whose credits they are.
 *
 * TOP-UP. The pack is invoiced onto the subscription and collected from the
 * card on file at once (the page asks the customer to confirm first) — the
 * admin UI's Add Charge. Only a PAID invoice grants: Chargebee issues the
 * pack's own Credit Grant once it is paid, and `applyTopUps` records that
 * grant and moves the gateway cap. There is no hosted page here — Chargebee
 * refuses one for a charge that carries a grant (see chargeItem in
 * integrations/chargebee/client.ts).
 */

import type { AddressFields, ChargedInvoice, ChargebeeClient, ChargebeeError, PaymentSource } from "../integrations/chargebee";
import { ACCOUNT } from "../models/account-status";
import {
  currencyForCountry,
  freeItemPriceIds,
  settingsFor,
  topUpItemPriceIds,
  topUpsOf,
  type CurrencyCatalog,
  type TopUpSettingsForCurrency,
} from "../models/currency";
import { add } from "../models/decimal";
import { freePlanFor } from "../models/free-plan";
import type { BillingAccount, BillingAccountRepository } from "../repositories/billing-account.repository";
import { SWITCH, type CurrencySwitchRepository } from "../repositories/currency-switch.repository";
import { conflict, errorMessage, invalid, notFound, upstream } from "../shared/errors";
import type { Logger } from "../shared/logger";
import type { AccountService } from "./account.service";
import { currencyDigits, type TopUpOffer } from "./plan-catalog.service";

export function createCheckoutService(deps: {
  chargebee: ChargebeeClient;
  accountService: AccountService;
  accounts: BillingAccountRepository;
  /** The plans checkout may sell. An allowlist, not a menu — see config/config.ts. */
  itemPriceIds: string[];
  defaultItemPriceId: string;
  /**
   * Every billing currency's free plan and top-up, and the rule that picks a
   * currency (models/currency.ts). A currency with no free plan puts no org
   * on one; with no top-up, sells none.
   */
  catalog: CurrencyCatalog;
  /** Whether an org with no setting of its own gets the free plan (FREE_PLAN_DEFAULT). */
  freePlanDefault?: boolean;
  /** Where Chargebee sends the browser after a subscription checkout — the billing page. */
  checkoutRedirectUrl?: string;
  /**
   * One currency's top-up as the page is offered it (plan-catalog.service
   * describeTopUp): its fewest and most units — TOPUP_MIN_AMOUNT_<CUR> /
   * TOPUP_MAX_AMOUNT_<CUR> in that charge's price. Absent: at least one unit,
   * and no maximum.
   */
  topUpOffer?: (topUp: TopUpSettingsForCurrency) => Promise<TopUpOffer>;
  /** The packs' charges carry their own Credit Grant: Chargebee grants, billing only records. A currency's own setting wins. */
  topUpChargebeeGrants?: boolean;
  /**
   * The org's currency switches (currency-switch.repository.ts): a top-up is
   * refused while one is open, before anything else is asked. Absent (a test
   * about something else): the charge lease still refuses one (A13).
   */
  switches?: Pick<CurrencySwitchRepository, "findOpen">;
  /**
   * A plan's currency, from the Chargebee catalogue — cached (plan-catalog
   * describePlans) in production; null when it could not be read. Absent: the
   * catalogue is asked directly. A plan's currency is never parsed from its id.
   */
  planCurrency?: (itemPriceId: string) => Promise<string | null>;
  clock?: () => number;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}) {
  const log = deps.logger ?? console;
  const chargebeeGrants = deps.topUpChargebeeGrants ?? false;
  const freePlanDefault = deps.freePlanDefault ?? false;
  const clock = deps.clock ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const planCurrency = deps.planCurrency ?? (async (itemPriceId: string) => (await deps.chargebee.itemPrice(itemPriceId))?.currencyCode ?? null);

  /**
   * A paid plan's checkout — in the org's billing currency only.
   *
   * The org's confirmed billing country decides the currency (models/
   * currency.ts), so there is no checkout before there is a country: 409
   * `billing-address-required`, and the page asks for the address first. A
   * plan in any other currency is not offered — `plan-not-offered`, as for
   * a plan off the allowlist — read from the Chargebee catalogue, never
   * from the plan's id. DEFAULT_ITEM_PRICE_ID is the plan when none is
   * named, and is held to the same rule.
   *
   * The hosted page is pre-filled with the address the org confirmed: it
   * writes the address it collects back onto the customer (MEASURED), and a
   * page left to ask could write one in another country than the one the
   * currency was chosen by (A21).
   */
  async function startSubscription(tenantId: string, requestedItemPriceId?: string) {
    const itemPriceId = requestedItemPriceId ?? deps.defaultItemPriceId;

    // A security control, not a menu. Without it a tampered request could
    // subscribe this tenant to any item price in the catalogue.
    if (!deps.itemPriceIds.includes(itemPriceId)) throw invalid("Unknown plan", "plan-not-offered");
    const account = await deps.accounts.findByTenantId(tenantId);
    // Nor to a free plan — any currency's — when it is not for this org: it
    // costs nothing, so a request naming one would be the free plan an
    // operator did not give.
    if (freeItemPriceIds(deps.catalog).includes(itemPriceId) && !freePlanFor(account, freePlanDefault)) {
      throw invalid("Unknown plan", "plan-not-offered");
    }

    if (!account?.billingCountry) throw billingAddressRequired();
    const currency = currencyForCountry(account.billingCountry, deps.catalog.rules);
    const sold = await planCurrency(itemPriceId);
    if (sold == null) throw upstream("Could not read the plan from Chargebee", "checkout-failed");
    if (sold !== currency) throw invalid(`That plan is not offered in ${currency}`, "plan-not-offered");

    const customerId = await customerFor(tenantId);
    const billingAddress = await confirmedAddress(tenantId, customerId, account.billingCountry);
    return deps.chargebee.checkoutPage({ customerId, itemPriceId, redirectUrl: deps.checkoutRedirectUrl, billingAddress });
  }

  /**
   * The address to pre-fill a hosted page with: the one Chargebee holds for
   * the customer when it is in the confirmed country — that is the address
   * the org saved — and otherwise the country alone. Best effort: a customer
   * that cannot be read pre-fills the country alone, said in the log.
   */
  async function confirmedAddress(tenantId: string, customerId: string, country: string): Promise<AddressFields> {
    try {
      const held = (await deps.chargebee.customer(customerId))?.billingAddress ?? null;
      if (held?.country !== country) return { country };
      const { email: _email, phone: _phone, line3: _line3, ...fields } = held;
      return fields;
    } catch (err) {
      log.warn?.(
        { metric: "billing.checkout.address_unreadable", tenantId, err: errorMessage(err) },
        "Could not read the customer's billing address to pre-fill the checkout; pre-filling the confirmed country alone",
      );
      return { country };
    }
  }

  /**
   * The tenant's Chargebee customer, created if missing.
   *
   * Idempotent on both counts: the local row is upserted, and the Chargebee
   * customer id is the tenant id, so a repeat finds the existing customer.
   * `billingEmail` fills a row that has none; it never replaces one.
   */
  async function customerFor(tenantId: string, billingEmail?: string): Promise<string> {
    const existing = await deps.accounts.findByTenantId(tenantId);
    const linked = existing
      ? await deps.accountService.ensureCustomer({
          tenantId: existing.tenantId,
          routingSlug: existing.routingSlug,
          billingEmail: existing.billingEmail ?? billingEmail,
        })
      : await deps.accountService.bootstrapFromTenant(tenantId, billingEmail);

    // No such tenant in the platform's own table — not our row to invent.
    if (!linked) throw notFound("Unknown tenant", "tenant-not-found");
    if (!linked.chargebeeCustomerId) {
      throw upstream("Could not create the billing customer", "customer-unavailable");
    }
    return linked.chargebeeCustomerId;
  }

  /**
   * Set up a new org's billing: its Chargebee customer always, and the free
   * plan — no checkout, no card, no plan to choose — when it is for the org.
   * Called by enginos-platform once an org is created, and, as the fallback, by
   * the billing page when an org the free plan is for has no subscription.
   *
   * THE CUSTOMER IS CREATED HERE, AT ONBOARDING, for every org — not first at
   * checkout. `billingEmail` is the admin's address the org was created with;
   * Chargebee uses it for invoices and receipts, and the checkout starts with
   * it filled in. A Chargebee that cannot be reached fails the call, and the
   * customer is then created at checkout instead.
   *
   * Only an org the free plan is for (models/free-plan.ts) is subscribed. Any
   * other is left with its customer — `not-eligible`, not an error — and
   * chooses a paid plan instead.
   *
   * Safe to call any number of times, concurrently:
   *   - an account that already has a subscription — live OR cancelled — is
   *     left exactly as it is; opening a page never undoes a cancellation;
   *   - a subscription Chargebee already holds for the customer (a call that
   *     died between creating and linking) is linked, not duplicated;
   *   - the create carries an idempotency key per tenant, and a create that
   *     loses a race is settled by looking again.
   *
   * Only a plan that costs NOTHING is created this way: with no card on file a
   * paid plan would be an unpaid invoice from day one. Its price is read from
   * the catalogue before every create, not trusted from config.
   *
   * IN THE CURRENCY OF THE ORG'S BILLING COUNTRY (models/currency.ts): the
   * free plan of the currency its confirmed country is billed in — and, with
   * no address yet (sign-up sends none), of the default currency, USD (R8).
   * The plan's catalogue currency is checked too, so a USD org is never put
   * on an INR plan by a typo in FREE_PLAN_ITEM_PRICE_ID_USD: Chargebee fixes
   * a subscription's currency for good. The idempotency key names the
   * currency: Chargebee replays a key for 30 minutes and refuses one sent
   * with another body, so an org whose address moved it to another currency
   * inside that window must not meet the key its first create used. Once the
   * subscription's currency is decided, the customer is told to prefer it
   * (A19) — best effort, never in the way.
   *
   * The billing address sync never calls this (A3): an org it gave a
   * country is put on its free plan by the billing page's next load, which
   * then picks the plan of the new country's currency.
   */
  async function provisionFreePlan(tenantId: string, { billingEmail }: { billingEmail?: string } = {}) {
    const existing = await deps.accounts.findByTenantId(tenantId);
    if (existing?.chargebeeSubscriptionId) {
      return { status: "already-subscribed" as const, subscriptionId: existing.chargebeeSubscriptionId };
    }

    // Every org gets its customer now, whatever plan it will be on.
    const customerId = await customerFor(tenantId, billingEmail);
    if (!freePlanFor(existing, freePlanDefault)) {
      log.log?.(
        { metric: "billing.customer.onboarded", tenantId, freePlan: false },
        "Created the org's Chargebee customer; the org chooses a paid plan",
      );
      return { status: "not-eligible" as const, subscriptionId: null, customerId };
    }

    const currency = currencyForCountry(existing?.billingCountry, deps.catalog.rules);
    const freeItemPriceId = settingsFor(deps.catalog, currency).freeItemPriceId ?? "";
    if (freeItemPriceId === "") throw conflict("No free plan is configured", "free-plan-not-configured");
    // The linking step below only links plans on the allowlist; one outside it
    // would be created in Chargebee and never reach the account.
    if (!deps.itemPriceIds.includes(freeItemPriceId)) {
      log.error?.(
        { metric: "billing.free_plan.misconfigured", tenantId, freeItemPriceId, currency },
        "The free plan (FREE_PLAN_ITEM_PRICE_ID_<currency>) is not in ITEM_PRICE_IDS; no subscription created",
      );
      throw conflict("The free plan is not configured correctly", "free-plan-misconfigured");
    }

    const live = await deps.chargebee.activeSubscriptions(customerId);

    if (live.length === 0) {
      const plan = await deps.chargebee.itemPrice(freeItemPriceId);
      if (plan?.priceMinor !== 0) {
        log.error?.(
          { metric: "billing.free_plan.not_free", tenantId, freeItemPriceId, priceMinor: plan?.priceMinor ?? null },
          "The configured free plan does not cost zero; refusing to subscribe a customer with no card to it",
        );
        throw conflict("The free plan is not configured correctly", "free-plan-misconfigured");
      }
      if (plan.currencyCode !== currency) {
        log.error?.(
          { metric: "billing.free_plan.wrong_currency", tenantId, freeItemPriceId, currency, planCurrency: plan.currencyCode },
          "The configured free plan is not priced in the currency it is configured for; refusing to subscribe the org to it",
        );
        throw conflict("The free plan is not configured correctly", "free-plan-misconfigured");
      }
      try {
        await deps.chargebee.subscribeCustomer({
          customerId,
          itemPriceId: freeItemPriceId,
          idempotencyKey: `free-plan:${tenantId}:${currency}`,
        });
      } catch (err) {
        // A concurrent call may have created it first; that one is ours too.
        if ((await deps.chargebee.activeSubscriptions(customerId)).length === 0) throw err;
      }
    }

    const account = await linkWithLedger(tenantId);
    // The currency is decided: the linked subscription's, or the plan's just created.
    await preferCurrency(tenantId, customerId, account?.currency ?? (live.length === 0 ? currency : null));
    log.log?.(
      {
        metric: "billing.free_plan.provisioned",
        tenantId,
        currency: account?.currency ?? currency,
        created: live.length === 0,
        status: account?.status ?? null,
        ledgerUnitId: account?.ledgerUnitId ?? null,
      },
      live.length === 0 ? "Subscribed the org to the free plan" : "Linked the org's existing subscription",
    );
    return {
      status: live.length === 0 ? ("subscribed" as const) : ("linked" as const),
      subscriptionId: account?.chargebeeSubscriptionId ?? null,
    };
  }

  /**
   * Tell Chargebee the currency the customer's subscription is in
   * (`preferred_currency_code`, A19): Chargebee routes a charge through the
   * gateway of the customer's PREFERRED currency, and every customer on the
   * test site prefers INR (MEASURED). Best effort — the subscription is what
   * fixes the currency, and a failure is said, never in the way.
   */
  async function preferCurrency(tenantId: string, customerId: string, currency: string | null) {
    if (!currency) return;
    try {
      await deps.chargebee.setPreferredCurrency(customerId, currency);
    } catch (err) {
      log.error?.(
        { metric: "billing.customer.preferred_currency_failed", tenantId, customerId, currency, err: errorMessage(err) },
        "Could not set the customer's preferred currency in Chargebee; its charges may be routed through another currency's gateway until it is set",
      );
    }
  }

  /**
   * Turn the free plan on or off for one org — an OPERATOR's call.
   *
   * Never the org's own: enginos-platform forwards only org-admin requests to
   * billing, and this route must not be among them, or any org could give
   * itself the free plan.
   *
   *   on    an org with no subscription is put on the free plan now, rather
   *         than when its billing page is next opened.
   *   off   the org is offered the paid plans. An org already ON the free
   *         plan keeps it: this decides who is put on the plan, and ending a
   *         subscription is not its business.
   */
  async function setFreePlan(tenantId: string, enabled: boolean) {
    const account = await deps.accountService.ensureLocalAccount(tenantId);
    if (!account) throw notFound("No such tenant", "no-tenant");
    await deps.accounts.setFreePlan(tenantId, enabled);
    log.log?.({ metric: "billing.free_plan.set", tenantId, enabled }, enabled ? "Free plan turned on for the org" : "Free plan turned off for the org");

    const provisioned = enabled && !account.chargebeeSubscriptionId ? await provisionFreePlan(tenantId) : null;
    return { tenantId, freePlan: enabled, subscriptionId: account.chargebeeSubscriptionId, ...(provisioned ? { provisioned } : {}) };
  }

  /**
   * Link the subscription, waiting out Chargebee's credit ledger. MEASURED: the
   * plan's grant block — and with it the ledger account whose unit billing
   * charges usage against — appeared three seconds after the subscription.
   * Linked sooner, the account is active with NO credit unit, and the usage
   * sync skips it (usage-sync.service.ts) until some later sync fills the unit
   * in. Still missing after the wait, it is left to the webhook and the daily
   * resync, and said so.
   */
  async function linkWithLedger(tenantId: string) {
    for (let attempt = 1; ; attempt += 1) {
      const account = await deps.accountService.syncFromChargebee(tenantId);
      if (!account || account.ledgerUnitId || attempt === LEDGER_WAIT_ATTEMPTS) {
        if (account && !account.ledgerUnitId) {
          log.warn?.(
            { metric: "billing.free_plan.no_ledger_yet", tenantId },
            "Free plan linked but Chargebee has no credit ledger for it yet; usage is billed once a later sync finds it",
          );
        }
        return account;
      }
      await sleep(LEDGER_WAIT_MS);
    }
  }

  /**
   * Charge `quantity` units of the top-up to the card on file, then grant.
   *
   * The quantity only sizes the charge. What gets GRANTED is read back off
   * the paid invoice — Chargebee's own grant block for it, or billing's
   * allocation of TOPUP_CREDITS_<CUR> per unit invoiced — so a tampered number here
   * can at most change what the customer pays, never what they get for it.
   *
   * IN THE SUBSCRIPTION'S CURRENCY, AND ONLY ITS (R5, R6). Chargebee refuses
   * a charge in any other (MEASURED: `currency_mismatched`), so the pack sold
   * is the top-up item price of the currency the org's subscription is in —
   * never the default currency's, never a choice the request makes. Refused,
   * in this order, each before anything is charged:
   *
   *   currency-switch-in-progress  a currency switch is open: no pack is sold
   *                                in either currency until it has finished
   *   no-subscription /            nothing live to add credits to
   *   subscription-cancelled
   *   billing-address-required     no billing country confirmed yet — the
   *                                page asks for the address first (R1)
   *   topup-not-offered            no top-up configured in this currency
   *   topup-quantity-invalid       outside the limits the page was offered
   *   topup-in-progress            another top-up is being charged right now
   *   topup-unpaid                 one is still owed, in any currency
   *   no-payment-method            no card Chargebee will charge
   *
   * THE CHARGE LEASE (A13). The charge runs under a lease on the account
   * row, taken in the same transaction that checks no currency switch is
   * open; a switch starts under the same row lock and refuses a live lease.
   * So a charge and a switch never overlap: without it, a pack paid a second
   * after the switch's last look at the old subscription landed on one about
   * to be emptied and cancelled — paid for, never spendable. It serialises
   * two top-ups of one org too: the second waits for the first to be
   * recorded, rather than both passing the one-owed-at-a-time check.
   *
   * A declined card grants NOTHING (decided 2026-09-28). MEASURED: the charge
   * then answers 200 with a `payment_due` invoice, not an error — and
   * Chargebee has already issued the pack's credits with it. Those are held
   * back from the balance and the gateway cap (`unpaidTopUpCredits`) until the
   * invoice is paid: by Chargebee's own retry a day later, or by "Pay now"
   * (`payUnpaidTopUps`). Then `payment_succeeded` records the pack and moves
   * the cap. The invoice is returned as it is, with its `nextRetryAt`, so the
   * page can say the card was declined.
   *
   * ONE unpaid top-up at a time: each would be charged again when Chargebee
   * retries, so a customer who tried twice after a decline would pay twice.
   * While one is owed, a new top-up is a 409 `topup-unpaid`; `payUnpaidTopUps`
   * settles it.
   *
   * A charge that fails outright is a named 409, with Chargebee's reason, so
   * the page does not call a declined card an outage.
   */
  async function startTopUp(tenantId: string, quantity: number = 1) {
    const open = (await deps.switches?.findOpen(tenantId)) ?? null;
    if (open && blocksTopUps(open)) throw currencySwitchInProgress();
    const account = await subscribedAccount(tenantId);
    if (!account.billingCountry) throw billingAddressRequired();

    // The subscription's own currency: stored at the link, or read off the
    // live subscription for an account linked before that was stored.
    const currency = account.currency ?? (await liveCurrency(account));
    const topUp = currency ? settingsFor(deps.catalog, currency).topUp : null;
    if (!topUp) throw topUpNotOffered();
    // The same limits the page was offered — never only the page's word for
    // them. describeTopUp never throws (a Chargebee outage leaves one unit).
    // No maximum while TOPUP_MAX_AMOUNT_<CUR> is unset.
    const offer = deps.topUpOffer ? await deps.topUpOffer(topUp) : null;
    const fewest = offer?.minQuantity ?? 1;
    const most = offer?.maxQuantity ?? null;
    if (!Number.isInteger(quantity) || quantity < fewest || (most != null && quantity > most)) {
      throw invalid(topUpRangeMessage(offer, fewest, most), "topup-quantity-invalid");
    }

    const lease = await takeCharge(tenantId);
    try {
      // Owed in ANY currency: one unpaid pack at a time, whatever it was bought in.
      const owed = await deps.chargebee.unpaidInvoicesFor(account.chargebeeCustomerId!, topUpItemPriceIds(deps.catalog));
      if (owed.length > 0) {
        throw conflict("Pay the unpaid top-up before buying more credits", "topup-unpaid");
      }

      // A free-plan org starts with no card, and Chargebee will not charge one
      // (MEASURED: 400 `payment_method_not_present`, "no valid card on file").
      // Asked first, so the page sends the customer to add a card rather than
      // reporting a failed charge.
      if (!isChargeable(await deps.chargebee.paymentSource(account.chargebeeCustomerId!))) {
        throw noPaymentMethod();
      }

      let invoice: ChargedInvoice;
      try {
        invoice = await deps.chargebee.chargeItem({
          subscriptionId: account.chargebeeSubscriptionId!,
          itemPriceId: topUp.itemPriceId,
          quantity,
        });
      } catch (err) {
        // The card went away between the check above and the charge.
        if ((err as ChargebeeError).apiErrorCode === "payment_method_not_present") throw noPaymentMethod();
        if (isPaymentFailure(err as ChargebeeError)) {
          log.warn?.(
            { metric: "billing.topup.payment_failed", tenantId, quantity, reason: (err as Error).message },
            "Top-up charge was not collected",
          );
          throw conflict(`Payment failed: ${(err as Error).message}`, "topup-payment-failed");
        }
        throw err;
      }

      if (invoice.status !== "paid") {
        log.warn?.(
          {
            metric: "billing.topup.unpaid",
            tenantId,
            invoiceId: invoice.id,
            status: invoice.status,
            amountDueMinor: invoice.amountDueMinor,
            nextRetryAt: invoice.nextRetryAt,
          },
          "Top-up invoiced but the card was not collected; nothing granted until Chargebee collects it",
        );
        return { invoice, quantity, applied: 0, credits: "0" };
      }

      const granted = await applyCharged(tenantId, invoice.id);
      return { invoice, quantity, applied: granted.applied, credits: granted.credits };
    } finally {
      await releaseCharge(tenantId, lease);
    }
  }

  /**
   * "Pay now": charge the card on file for every top-up Chargebee has not
   * collected, oldest first, and grant the ones paid.
   *
   * Adding a card does not collect them by itself (MEASURED 2026-09-28), and
   * Chargebee's own retry comes a day later — so a customer who has fixed
   * their card would otherwise wait for the credits, unable to buy more
   * (`topup-unpaid`).
   * Never retried. A card that declines again is the same 409 as a declined
   * top-up, and the invoices stay owed.
   *
   * Under the same charge lease as a top-up — but allowed while a currency
   * switch is only REQUESTED: such a switch waits for exactly this (it does
   * not start over an unpaid top-up), and it cannot start while the lease is
   * held. Refused once one is moving credits (`currency-switch-in-progress`).
   * Every currency's packs are collected: one left unpaid in INR is still
   * owed once the org is billed in USD.
   */
  async function payUnpaidTopUps(tenantId: string) {
    const account = await subscribedAccount(tenantId);
    const open = (await deps.switches?.findOpen(tenantId)) ?? null;
    if (open && open.status !== SWITCH.REQUESTED && blocksTopUps(open)) throw currencySwitchInProgress();

    const lease = await takeCharge(tenantId, { duringRequestedSwitch: true });
    try {
      const owed = await deps.chargebee.unpaidInvoicesFor(account.chargebeeCustomerId!, topUpItemPriceIds(deps.catalog));
      if (owed.length === 0) return { invoices: [], applied: 0, credits: "0" };
      if (!isChargeable(await deps.chargebee.paymentSource(account.chargebeeCustomerId!))) {
        throw noPaymentMethod();
      }

      const invoices: Array<{ id: string; status: string }> = [];
      for (const unpaid of owed) {
        let invoice: ChargedInvoice;
        try {
          invoice = await deps.chargebee.collectInvoice(unpaid.id);
        } catch (err) {
          if ((err as ChargebeeError).apiErrorCode === "payment_method_not_present") throw noPaymentMethod();
          if (isPaymentFailure(err as ChargebeeError)) {
            log.warn?.(
              { metric: "billing.topup.collect_failed", tenantId, invoiceId: unpaid.id, reason: (err as Error).message },
              "Unpaid top-up could not be collected; it stays owed",
            );
            throw conflict(`Payment failed: ${(err as Error).message}`, "topup-payment-failed");
          }
          throw err;
        }
        invoices.push({ id: invoice.id, status: invoice.status });
      }

      // Paid now: record the packs, which moves the cap to include them.
      const recorded = await applyTopUps(tenantId);
      return { invoices, applied: recorded.applied, credits: recorded.credits };
    } finally {
      await releaseCharge(tenantId, lease);
    }
  }

  /**
   * Take the account's top-up CHARGE lease (billing-account.repository
   * takeTopUpCharge), or say why not: a currency switch is open, another
   * charge holds it, or the account is not one a pack can be charged to —
   * cancelled, switching, or still being set up.
   */
  async function takeCharge(tenantId: string, opts: { duringRequestedSwitch?: boolean } = {}): Promise<Date> {
    const taken = await deps.accounts.takeTopUpCharge(tenantId, new Date(clock()), TOPUP_CHARGE_LEASE_MS, opts);
    if (taken.taken) return taken.until;
    if (taken.reason === "switch") throw currencySwitchInProgress();
    if (taken.reason === "charging") throw conflict("A top-up is already being charged", "topup-in-progress");
    const now = await deps.accounts.findByTenantId(tenantId);
    if (!now?.chargebeeSubscriptionId) throw noSubscription();
    if (now.status === ACCOUNT.CANCELLED) throw subscriptionCancelled();
    if (now.status === ACCOUNT.SWITCHING) throw currencySwitchInProgress();
    throw billingActivating();
  }

  /** Done charging — the lease goes, if it is still ours. A failure only delays the next top-up until the lease runs out. */
  async function releaseCharge(tenantId: string, until: Date) {
    try {
      await deps.accounts.releaseTopUpCharge(tenantId, until);
    } catch (err) {
      log.error?.(
        { metric: "billing.topup.charge_lease_release_failed", tenantId, err: errorMessage(err) },
        "Could not clear the top-up charge lease; the next top-up waits until it runs out",
      );
    }
  }

  /** The live subscription's `currency_code`, for an account linked before the currency was stored. Null when it says none. */
  async function liveCurrency(account: BillingAccount): Promise<string | null> {
    const record = await deps.chargebee.subscription(account.chargebeeSubscriptionId!);
    return typeof record?.currency_code === "string" ? record.currency_code : null;
  }

  /**
   * `applyTopUps` for an invoice just paid, waiting out the second or so
   * Chargebee takes to issue the pack's grant block. Still not visible after
   * that, it is left for the next apply — or the `payment_succeeded` webhook —
   * rather than allocated (see applyPaidTopUps `chargebeeGrants`). The credits
   * are in Chargebee either way; only the gateway cap waits.
   */
  async function applyCharged(tenantId: string, invoiceId: string) {
    let total = { applied: 0, credits: "0" };
    for (let attempt = 1; ; attempt += 1) {
      const result = await applyTopUps(tenantId);
      total = { applied: total.applied + result.applied, credits: add(total.credits, result.credits) };
      if (!result.pending?.includes(invoiceId) || attempt === GRANT_WAIT_ATTEMPTS) return total;
      await sleep(GRANT_WAIT_MS);
    }
  }

  /**
   * Grant credits for every PAID top-up invoice not yet applied.
   *
   * A CANCELLED account is still refused with the 409 — but only after the
   * account service has looked for packs paid anyway. A customer who opened
   * the top-up checkout before the cancellation and paid after it has given
   * us money for nothing, and that is raised as an error naming the invoices
   * (`billing.topup.refused_cancelled`) so someone refunds it, rather than
   * disappearing into a 409.
   */
  async function applyTopUps(tenantId: string) {
    const account = await deps.accounts.findByTenantId(tenantId);
    if (!account?.chargebeeSubscriptionId) throw noSubscription();
    // EVERY currency's packs, each with its own credits per unit: a pack paid
    // in INR is still to be recorded after the org has moved to USD. One after
    // another, totalled; an outage on one stops the rest, as it would anyway.
    // applyPaidTopUps allocates nothing to a cancelled account; it raises the alert.
    let applied = 0;
    let credits = "0";
    const pending: string[] = [];
    for (const topUp of topUpsOf(deps.catalog)) {
      const result = await deps.accountService.applyPaidTopUps(tenantId, topUp.itemPriceId, topUp.credits, {
        chargebeeGrants: topUp.chargebeeGrants ?? chargebeeGrants,
      });
      applied += result.applied;
      credits = add(credits, result.credits);
      pending.push(...(result.pending ?? []));
    }
    if (account.status === ACCOUNT.CANCELLED) throw subscriptionCancelled();
    return { applied, credits, ...(pending.length > 0 ? { pending } : {}) };
  }

  /**
   * A top-up adds to an existing ledger; without a live subscription there is
   * none to add to.
   *
   * A CANCELLED account still carries its subscription id, so the id alone
   * would let it buy credits — and the allocation's activate() would reopen a
   * LiteLLM team whose usage the sync no longer bills, because it skips
   * cancelled accounts. Refused before the customer pays, with its own code so
   * the page can offer the plans again instead of "Buy more credits".
   */
  async function subscribedAccount(tenantId: string): Promise<BillingAccount> {
    const account = await deps.accounts.findByTenantId(tenantId);
    if (!account?.chargebeeSubscriptionId) throw noSubscription();
    if (account.status === ACCOUNT.CANCELLED) throw subscriptionCancelled();
    return account;
  }

  return { startSubscription, provisionFreePlan, setFreePlan, startTopUp, payUnpaidTopUps, applyTopUps, customerFor };
}

export type CheckoutService = ReturnType<typeof createCheckoutService>;

/**
 * Does this open switch stop a top-up? One not started yet, one moving
 * credits, and one linked whose cap has not moved to the new subscription do
 * (currency-switch.repository BLOCKING_SWITCH); once it has, what is left —
 * cancelling the old subscription — blocks nothing (A17).
 */
function blocksTopUps(open: { status: string; activatedAt: Date | null }): boolean {
  return open.status === SWITCH.REQUESTED || open.status === SWITCH.MOVING || (open.status === SWITCH.LINKED && open.activatedAt == null);
}

/**
 * "Choose an amount from 50 to 10000 INR" — or "of at least 50 INR" with no
 * maximum — in the charge's own money when its unit price is known.
 */
function topUpRangeMessage(offer: TopUpOffer | null, fewest: number, most: number | null): string {
  if (offer?.unitPriceMinor && offer.currencyCode) {
    const scale = 10 ** currencyDigits(offer.currencyCode);
    const money = (units: number) => `${(units * offer.unitPriceMinor!) / scale}`;
    return most == null
      ? `Choose an amount of at least ${money(fewest)} ${offer.currencyCode}`
      : `Choose an amount from ${money(fewest)} to ${money(most)} ${offer.currencyCode}`;
  }
  return most == null
    ? `Choose a whole number of units, at least ${fewest}`
    : `Choose a whole number of units from ${fewest} to ${most}`;
}

/**
 * How long a top-up's charge holds the account's charge lease: longer than a
 * charge (never retried; 20 seconds at most) and the wait for its grant
 * block. A process that dies holding it costs the next top-up this long.
 */
const TOPUP_CHARGE_LEASE_MS = 2 * 60_000;

/** MEASURED: a new subscription's credit ledger appeared three seconds after it. */
const LEDGER_WAIT_ATTEMPTS = 10;
const LEDGER_WAIT_MS = 1_000;

/** MEASURED: the grant block's `created_at` was one second after the invoice's `paid_at`. */
const GRANT_WAIT_ATTEMPTS = 5;
const GRANT_WAIT_MS = 1_000;

const noSubscription = () => conflict("Subscribe before topping up", "no-subscription");
const noPaymentMethod = () => conflict("Add a card before buying credits", "no-payment-method");
const topUpNotOffered = () => conflict("Buying credits is not available right now", "topup-not-offered");
const billingAddressRequired = () => conflict("Add your billing address first", "billing-address-required");
const currencySwitchInProgress = () =>
  conflict("Your billing currency is being changed — try again once it has finished", "currency-switch-in-progress");
const billingActivating = () => conflict("Your credits are still being set up — try again in a minute", "billing-activating");

/** A card Chargebee will charge: `expiring` still is; `expired`, `invalid` and `pending_verification` are not. */
function isChargeable(card: PaymentSource | null): boolean {
  return card != null && (card.status === "valid" || card.status === "expiring");
}
const subscriptionCancelled = () =>
  conflict("Your subscription has ended — subscribe again to add credits", "subscription-cancelled");

/**
 * A declined card, no card on file, a gateway refusal: Chargebee's `payment`
 * errors. HTTP 402 — and, MEASURED on `collect_payment` with a declining card,
 * HTTP 400 `payment_processing_failed`.
 */
function isPaymentFailure(err: ChargebeeError): boolean {
  return err.apiErrorCode === "payment" || err.status === 402 || (err.apiErrorCode ?? "").startsWith("payment_");
}
