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

import type { ChargedInvoice, ChargebeeClient, ChargebeeError, PaymentSource } from "../integrations/chargebee";
import { ACCOUNT } from "../models/account-status";
import { add } from "../models/decimal";
import { freePlanFor } from "../models/free-plan";
import type { BillingAccount, BillingAccountRepository } from "../repositories/billing-account.repository";
import { conflict, invalid, notFound, upstream } from "../shared/errors";
import type { Logger } from "../shared/logger";
import type { AccountService } from "./account.service";

export function createCheckoutService(deps: {
  chargebee: ChargebeeClient;
  accountService: AccountService;
  accounts: BillingAccountRepository;
  /** The plans checkout may sell. An allowlist, not a menu — see config/config.ts. */
  itemPriceIds: string[];
  defaultItemPriceId: string;
  /** The plan an org it is for gets automatically, card-free. Empty: none. */
  freeItemPriceId?: string;
  /** Whether an org with no setting of its own gets the free plan (FREE_PLAN_DEFAULT). */
  freePlanDefault?: boolean;
  /** Where Chargebee sends the browser after a subscription checkout — the billing page. */
  checkoutRedirectUrl?: string;
  topUpItemPriceId: string;
  /** Credits ONE unit of the top-up charge grants. */
  topUpCredits: string;
  /** Most units one top-up checkout may sell. */
  topUpMaxQuantity?: number;
  /** The pack's charge carries its own Credit Grant: Chargebee grants, billing only records. */
  topUpChargebeeGrants?: boolean;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}) {
  const log = deps.logger ?? console;
  const maxQuantity = deps.topUpMaxQuantity ?? DEFAULT_TOPUP_MAX_QUANTITY;
  const chargebeeGrants = deps.topUpChargebeeGrants ?? false;
  const freePlanDefault = deps.freePlanDefault ?? false;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function startSubscription(tenantId: string, requestedItemPriceId?: string) {
    const itemPriceId = requestedItemPriceId ?? deps.defaultItemPriceId;

    // A security control, not a menu. Without it a tampered request could
    // subscribe this tenant to any item price in the catalogue.
    if (!deps.itemPriceIds.includes(itemPriceId)) throw invalid("Unknown plan", "plan-not-offered");
    // Nor to the free plan, when it is not for this org: it costs nothing, so
    // a request naming it would be the free plan an operator did not give.
    if (itemPriceId === deps.freeItemPriceId && !freePlanFor(await deps.accounts.findByTenantId(tenantId), freePlanDefault)) {
      throw invalid("Unknown plan", "plan-not-offered");
    }

    const customerId = await customerFor(tenantId);
    return deps.chargebee.checkoutPage({ customerId, itemPriceId, redirectUrl: deps.checkoutRedirectUrl });
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

    const freeItemPriceId = deps.freeItemPriceId ?? "";
    if (freeItemPriceId === "") throw conflict("No free plan is configured", "free-plan-not-configured");
    // The linking step below only links plans on the allowlist; one outside it
    // would be created in Chargebee and never reach the account.
    if (!deps.itemPriceIds.includes(freeItemPriceId)) {
      log.error?.(
        { metric: "billing.free_plan.misconfigured", tenantId, freeItemPriceId },
        "FREE_PLAN_ITEM_PRICE_ID is not in ITEM_PRICE_IDS; no subscription created",
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
      try {
        await deps.chargebee.subscribeCustomer({
          customerId,
          itemPriceId: freeItemPriceId,
          idempotencyKey: `free-plan:${tenantId}`,
        });
      } catch (err) {
        // A concurrent call may have created it first; that one is ours too.
        if ((await deps.chargebee.activeSubscriptions(customerId)).length === 0) throw err;
      }
    }

    const account = await linkWithLedger(tenantId);
    log.log?.(
      {
        metric: "billing.free_plan.provisioned",
        tenantId,
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
   * allocation of `topUpCredits` per unit invoiced — so a tampered number here
   * can at most change what the customer pays, never what they get for it.
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
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantity) {
      throw invalid(`Choose a whole number of units from 1 to ${maxQuantity}`, "topup-quantity-invalid");
    }
    const account = await subscribedAccount(tenantId);

    const owed = await deps.chargebee.unpaidInvoicesFor(account.chargebeeCustomerId!, deps.topUpItemPriceId);
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
        itemPriceId: deps.topUpItemPriceId,
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
   */
  async function payUnpaidTopUps(tenantId: string) {
    const account = await subscribedAccount(tenantId);
    const owed = await deps.chargebee.unpaidInvoicesFor(account.chargebeeCustomerId!, deps.topUpItemPriceId);
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
    // applyPaidTopUps allocates nothing to a cancelled account; it raises the alert.
    const result = await deps.accountService.applyPaidTopUps(tenantId, deps.topUpItemPriceId, deps.topUpCredits, {
      chargebeeGrants,
    });
    if (account.status === ACCOUNT.CANCELLED) throw subscriptionCancelled();
    return result;
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

  return { startSubscription, provisionFreePlan, setFreePlan, startTopUp, payUnpaidTopUps, applyTopUps };
}

/** Matches config's TOPUP_MAX_QUANTITY default, for callers that do not pass one. */
const DEFAULT_TOPUP_MAX_QUANTITY = 100;

/** MEASURED: a new subscription's credit ledger appeared three seconds after it. */
const LEDGER_WAIT_ATTEMPTS = 10;
const LEDGER_WAIT_MS = 1_000;

/** MEASURED: the grant block's `created_at` was one second after the invoice's `paid_at`. */
const GRANT_WAIT_ATTEMPTS = 5;
const GRANT_WAIT_MS = 1_000;

const noSubscription = () => conflict("Subscribe before topping up", "no-subscription");
const noPaymentMethod = () => conflict("Add a card before buying credits", "no-payment-method");

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

export type CheckoutService = ReturnType<typeof createCheckoutService>;
