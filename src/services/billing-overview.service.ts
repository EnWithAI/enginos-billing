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
 */

import type { ChargebeeClient, PaymentSource, Transaction } from "../integrations/chargebee";
import { ACCOUNT } from "../models/account-status";
import { compare, subtract } from "../models/decimal";
import type { BillingAccount, BillingAccountRepository } from "../repositories/billing-account.repository";
import type { ChargebeeSyncRepository } from "../repositories/chargebee-sync.repository";
import { errorMessage } from "../shared/errors";
import type { Logger } from "../shared/logger";
import type { AccountService } from "./account.service";
import type { PlanOffer } from "./plan-catalog.service";

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

export type BillingOverview =
  /** No billing row at all — every org starts here, and it is a normal state. */
  | { kind: "unlinked"; plansOffered: PlanOffer[] }
  /** Paid, but the gateway does not hold the budget yet, so no credits are shown. */
  | { kind: "activating"; plansOffered: PlanOffer[]; account: BillingAccount }
  | {
      kind: "linked";
      plansOffered: PlanOffer[];
      account: BillingAccount;
      credits: Credits;
      /** Null when Chargebee could not be reached — distinct from "no payments". */
      payments: Transaction[] | null;
      subscription: SubscriptionDetails | null;
      lastSync: LastSync | null;
    };

const NO_CREDITS: Credits = { granted: "0", allocated: "0", consumed: "0", current: "0" };

export function createBillingOverviewService(deps: {
  chargebee: ChargebeeClient;
  accountService: AccountService;
  accounts: BillingAccountRepository;
  syncs: ChargebeeSyncRepository;
  /** The offered plans, described. Must never throw — see plan-catalog.service.ts. */
  plansOffered: () => Promise<PlanOffer[]>;
  logger?: Logger;
}) {
  const log = deps.logger ?? console;

  async function overview(tenantId: string): Promise<BillingOverview> {
    const plansOffered = await deps.plansOffered();

    const account = await findOrCreateAccount(tenantId);
    if (!account) return { kind: "unlinked", plansOffered };
    if (account.status === ACCOUNT.ACTIVATING) return { kind: "activating", plansOffered, account };

    const [credits, payments, subscription, lastSync] = await Promise.all([
      readCredits(account.chargebeeSubscriptionId, account.ledgerUnitId),
      readPayments(account.chargebeeCustomerId),
      readSubscription(account.chargebeeSubscriptionId, account.chargebeeCustomerId),
      deps.syncs.latestSettled(account.tenantId),
    ]);

    return { kind: "linked", plansOffered, account, credits, payments, subscription, lastSync };
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
  async function readCredits(subscriptionId: string | null, unitId: string | null): Promise<Credits> {
    if (!subscriptionId) return NO_CREDITS;
    try {
      const [balance, granted] = await Promise.all([
        // The account's own unit, never "the first balance" (C57b).
        deps.chargebee.balance(subscriptionId, unitId),
        deps.chargebee.grantedCredits(subscriptionId, unitId ?? undefined),
      ]);
      const current = balance?.usable ?? "0";
      // Exact, and never below zero: a float here printed "1e-7" for a tiny
      // difference and drifted on fractional grants.
      const spent = subtract(granted.credits, current);
      return {
        granted: granted.credits,
        allocated: granted.credits,
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
  async function readPayments(customerId: string | null): Promise<Transaction[] | null> {
    if (!customerId) return [];
    try {
      return await deps.chargebee.transactionsFor(customerId, 20);
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

  return { overview };
}

export type BillingOverviewService = ReturnType<typeof createBillingOverviewService>;
