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
import {
  currencyCatalog,
  freeItemPriceIds,
  topUpItemPriceIds,
  topUpsOf,
  type TopUpSettingsForCurrency,
} from "../models/currency";
import { createBillingAccountRepository } from "../repositories/billing-account.repository";
import { createChargebeeSyncRepository } from "../repositories/chargebee-sync.repository";
import { createCurrencySwitchRepository } from "../repositories/currency-switch.repository";
import { createPlatformRepository } from "../repositories/platform.repository";
import { createTopUpGrantRepository } from "../repositories/topup-grant.repository";
import { createAccountService } from "../services/account.service";
import { createBillingAddressService } from "../services/billing-address.service";
import { createBillingOverviewService } from "../services/billing-overview.service";
import { createCheckoutService } from "../services/checkout.service";
import { createCurrencySwitchService } from "../services/currency-switch.service";
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
  const switches = createCurrencySwitchRepository();
  const topUps = createTopUpGrantRepository();
  const platform = createPlatformRepository();
  const budget = gatewayBudgetHooks();
  // What billing sells in each currency, and the rule that picks one — the
  // one place configuration becomes the catalog every service reads.
  const catalog = currencyCatalog(config.currencyRules, config.billing);

  const accountService = createAccountService({
    chargebee,
    accounts,
    platform,
    topUps,
    usdPerCredit: config.usdPerCredit,
    billingItemPriceIds: config.itemPriceIds,
    topUpItemPriceIds: topUpItemPriceIds(catalog),
    freeItemPriceIds: freeItemPriceIds(catalog),
    freePlanCredits: config.freePlanCredits,
    freePlanCreditUnit: config.freePlanCreditUnit,
    ...budget,
  });

  const billingPage = `${config.appUrl.replace(/\/+$/, "")}/organization/billing`;

  // One description of a currency's top-up for the page AND for the charge:
  // the limits the page offers are the ones checkout enforces.
  const topUpOffer = (topUp: TopUpSettingsForCurrency) =>
    describeTopUp(topUp, chargebee, { ttlMs: config.planCacheTtlMs });
  // A plan's currency, from the same cached catalogue read the page lists the
  // plans from — so checkout refuses exactly the plans the page did not offer.
  const planCurrency = async (itemPriceId: string) => {
    const [plan] = await describePlans([itemPriceId], chargebee, { ttlMs: config.planCacheTtlMs });
    return plan?.resolved ? plan.currencyCode : null;
  };

  const checkout = createCheckoutService({
    chargebee,
    accountService,
    accounts,
    itemPriceIds: config.itemPriceIds,
    defaultItemPriceId: config.defaultItemPriceId,
    catalog,
    freePlanDefault: config.freePlanDefault,
    // The page reads `from=checkout` (Chargebee appends `id` and `state`) and
    // pulls the new subscription at once, rather than waiting on the webhook.
    checkoutRedirectUrl: `${billingPage}?from=checkout`,
    topUpOffer,
    topUpChargebeeGrants: config.topUpChargebeeGrants,
    switches,
    planCurrency,
  });

  // The currency switch (services/currency-switch.service.ts). Inline — the
  // address sync — it runs on a client bounded by the request's remaining
  // time, one attempt per call (A3); the worker passes its alerting logger.
  const currencySwitch = (logger?: Logger) =>
    createCurrencySwitchService({
      chargebee,
      chargebeeFor: (timeoutMs) => createChargebee({ timeoutMs, maxAttempts: 1 }),
      accountService,
      accounts,
      switches,
      topUps,
      catalog,
      applyTopUps: (tenantId) => checkout.applyTopUps(tenantId),
      currencySwitchEnabled: config.currencySwitchEnabled,
      logger,
    });

  const billingAddress = createBillingAddressService({
    chargebee,
    accountService,
    accounts,
    switches,
    catalog,
    currencySwitchEnabled: config.currencySwitchEnabled,
    switchInlineMs: config.switchInlineMs,
    currencySwitch: currencySwitch(),
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
      autoSubscribe: freeItemPriceIds(catalog).length > 0 ? (tenantId) => checkout.provisionFreePlan(tenantId) : undefined,
      catalog,
      switches,
      currencySwitchEnabled: config.currencySwitchEnabled,
      addressEditEnabled: config.addressEditEnabled,
      freePlanDefault: config.freePlanDefault,
    }),

    checkout,

    billingAddress,

    /** Built on demand, like usageSync: the worker advances every open switch each minute with its alerting logger. */
    currencySwitch,

    // The billing page opens Chargebee's billing-address editor on this
    // portal's session (A29) — before the org has subscribed, too — so a
    // tenant with no customer yet gets one, as checkout would make it.
    portal: createPortalService({
      chargebee,
      accounts,
      redirectUrl: config.appUrl,
      enabled: config.portalEnabled,
      addressEditEnabled: config.addressEditEnabled,
      customerFor: (tenantId) => checkout.customerFor(tenantId),
    }),

    paymentMethod: createPaymentMethodService({
      chargebee,
      accounts,
      redirectUrl: billingPage,
    }),

    invoices: createInvoiceService({ chargebee, accounts }),

    webhooks: createWebhookService({
      accountService,
      accounts,
      topUps: topUpsOf(catalog).map((topUp) => ({
        itemPriceId: topUp.itemPriceId,
        creditsPerUnit: topUp.credits,
        chargebeeGrants: topUp.chargebeeGrants,
      })),
      chargebeeGrants: config.topUpChargebeeGrants,
      billingAddress,
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
