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
import { describePlans } from "../services/plan-catalog.service";
import { createPortalService } from "../services/portal.service";
import { createUsageSyncService } from "../services/usage-sync.service";
import { createWebhookService } from "../services/webhook.service";
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
    ...budget,
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
    }),

    checkout: createCheckoutService({
      chargebee,
      accountService,
      accounts,
      itemPriceIds: config.itemPriceIds,
      defaultItemPriceId: config.defaultItemPriceId,
      topUpItemPriceId: config.topUpItemPriceId,
      topUpCredits: config.topUpCredits,
    }),

    portal: createPortalService({ chargebee, accounts, redirectUrl: config.appUrl, enabled: config.portalEnabled }),

    invoices: createInvoiceService({ chargebee, accounts }),

    webhooks: createWebhookService({ accountService, accounts }),

    /** Built on demand: it opens a ClickHouse client, which only the sync needs. */
    usageSync(hatchetRunId?: string) {
      return createUsageSyncService({
        usage: createUsageSource(),
        chargebee,
        accounts,
        syncs,
        usdPerCredit: config.usdPerCredit,
        lagMs: config.lagMs,
        windowMs: config.windowMs,
        maxWindowsPerTick: config.maxWindowsPerTick,
        maxAttempts: config.maxAttempts,
        hatchetRunId,
        blockBudget: budget.blockBudget,
        releaseBudget: budget.releaseBudget,
      });
    },
  };
}

export type Services = ReturnType<typeof createServices>;
