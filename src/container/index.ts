/**
 * The composition root: the one place that reads configuration and decides
 * which concrete client, repository and service each part of the system gets.
 *
 * Everything below it depends on interfaces and receives its collaborators —
 * no service constructs its own Chargebee client or reaches for the config.
 * That is what lets a test hand a service a fake, and what makes this file the
 * only one to change when a dependency does.
 *
 * Built per request (and per worker tick), not once per process. The objects
 * are cheap, and it means nothing here can hold a stale client across a
 * config reset or a test's swapped dependency.
 */

import { getConfig } from "../config/config";
import { createChargebee } from "../integrations/chargebee";
import { createUsageSource } from "../integrations/clickhouse/usage-source";
import { createBillingAccountRepository } from "../repositories/billing-account.repository";
import { createChargebeeSyncRepository } from "../repositories/chargebee-sync.repository";
import { createPlatformRepository } from "../repositories/platform.repository";
import { createAccountService } from "../services/account.service";
import { createBillingOverviewService } from "../services/billing-overview.service";
import { createCheckoutService } from "../services/checkout.service";
import { createInvoiceService } from "../services/invoice.service";
import { describePlans, describeTopUp } from "../services/plan-catalog.service";
import { createPortalService } from "../services/portal.service";
import { createPaymentMethodService } from "../services/payment-method.service";
import { createUsageSyncService } from "../services/usage-sync.service";
import { createWebhookService } from "../services/webhook.service";
import type { Logger } from "../shared/logger";
import { gatewayBudgetHooks } from "./budget-hooks";

export function createServices() {
  const config = getConfig();
  const chargebee = createChargebee();
  const accounts = createBillingAccountRepository();
  const syncs = createChargebeeSyncRepository();
  const platform = createPlatformRepository();
  const budget = gatewayBudgetHooks();

  const accountService = createAccountService({
    chargebee,
    accounts,
    platform,
    usdPerCredit: config.usdPerCredit,
    billingItemPriceIds: config.itemPriceIds,
    topUpItemPriceId: config.topUpItemPriceId,
    freeItemPriceId: config.freeItemPriceId,
    freePlanCredits: config.freePlanCredits,
    freePlanCreditUnit: config.freePlanCreditUnit,
    ...budget,
  });

  const billingPage = `${config.appUrl.replace(/\/+$/, "")}/organization/billing`;

  // One description of the top-up for the page AND for the charge: the limits
  // the page offers are the ones checkout enforces.
  const topUpOffer = () =>
    describeTopUp(
      {
        itemPriceId: config.topUpItemPriceId,
        presetAmounts: config.topUpAmounts,
        minAmount: config.topUpMinAmount,
        maxAmount: config.topUpMaxAmount,
      },
      chargebee,
      { ttlMs: config.planCacheTtlMs },
    );

  const checkout = createCheckoutService({
    chargebee,
    accountService,
    accounts,
    itemPriceIds: config.itemPriceIds,
    defaultItemPriceId: config.defaultItemPriceId,
    freeItemPriceId: config.freeItemPriceId,
    freePlanDefault: config.freePlanDefault,
    // The page reads `from=checkout` (Chargebee appends `id` and `state`) and
    // pulls the new subscription at once, rather than waiting on the webhook.
    checkoutRedirectUrl: `${billingPage}?from=checkout`,
    topUpItemPriceId: config.topUpItemPriceId,
    topUpCredits: config.topUpCredits,
    topUpOffer,
    topUpChargebeeGrants: config.topUpChargebeeGrants,
  });

  return {
    config,
    platform,
    accounts: accountService,

    overview: createBillingOverviewService({
      chargebee,
      accountService,
      accounts,
      syncs,
      plansOffered: () => describePlans(config.itemPriceIds, chargebee, { ttlMs: config.planCacheTtlMs }),
      topUpOffer,
      autoSubscribe: config.freeItemPriceId ? (tenantId) => checkout.provisionFreePlan(tenantId) : undefined,
      freeItemPriceId: config.freeItemPriceId,
      freePlanDefault: config.freePlanDefault,
      topUpItemPriceId: config.topUpItemPriceId,
    }),

    checkout,

    portal: createPortalService({ chargebee, accounts, redirectUrl: config.appUrl, enabled: config.portalEnabled }),

    paymentMethod: createPaymentMethodService({
      chargebee,
      accounts,
      redirectUrl: billingPage,
    }),

    invoices: createInvoiceService({ chargebee, accounts }),

    webhooks: createWebhookService({
      accountService,
      accounts,
      topUp: {
        itemPriceId: config.topUpItemPriceId,
        creditsPerUnit: config.topUpCredits,
        chargebeeGrants: config.topUpChargebeeGrants,
      },
    }),

    /**
     * Built on demand: it opens a ClickHouse client, which only the sync needs.
     * The worker passes a logger that also raises its alerts (worker/alerts.ts).
     */
    usageSync(hatchetRunId?: string, logger?: Logger) {
      return createUsageSyncService({
        usage: createUsageSource(),
        chargebee,
        accounts,
        syncs,
        usdPerCredit: config.usdPerCredit,
        lagMs: config.lagMs,
        maxRangeMs: config.maxRangeMs,
        maxAttempts: config.maxAttempts,
        hatchetRunId,
        logger,
        blockBudget: budget.blockBudget,
        releaseBudget: budget.releaseBudget,
      });
    },
  };
}
