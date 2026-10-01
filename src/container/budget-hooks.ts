/**
 * The LiteLLM budget hooks for this process's configuration.
 *
 * Its own module so a test can replace the gateway without touching the rest
 * of the composition root.
 */

import { getConfig } from "../config/config";
import { createChargebee, type ChargebeeClient } from "../integrations/chargebee";
import { currencyCatalog, topUpItemPriceIds } from "../models/currency";
import { subtractFloorZero } from "../models/decimal";
import { createGatewayClient } from "../integrations/litellm/client";
import { createBillingAccountRepository, type BillingAccount } from "../repositories/billing-account.repository";
import { createPlatformRepository } from "../repositories/platform.repository";
import { budgetHooksFor, createGatewayBudget, type BudgetHooks } from "../services/gateway-budget.service";

let warnedUnconfigured = false;

/** Hooks for the configured gateway; none — with one warning per process — when unconfigured. */
export function gatewayBudgetHooks(): BudgetHooks {
  const config = getConfig();
  if (!config.litellm.masterKey) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        { metric: "billing.budget.gateway_unconfigured" },
        "LITELLM_MASTER_KEY is not set; LiteLLM team budgets will not be pushed",
      );
    }
    return {};
  }

  const chargebee = createChargebee();
  const accounts = createBillingAccountRepository();
  const platform = createPlatformRepository();
  // Every currency's top-up: an unpaid pack is held back whatever it was bought in.
  const topUps = topUpItemPriceIds(currencyCatalog(config.currencyRules, config.billing));

  return budgetHooksFor(
    createGatewayBudget({
      gateway: createGatewayClient(config.litellm),
      usdPerCredit: config.usdPerCredit,
      teamIdFor: (tenantId) => platform.litellmTeamId(tenantId),
      grantedCreditsFor: async (tenantId) => paidGrantedCredits(chargebee, await accounts.findByTenantId(tenantId), topUps),
    }),
  );
}

/**
 * The credits the gateway cap is built from: every live grant on the
 * account's unit, less a declined top-up's.
 *
 * Chargebee grants a top-up with its invoice, paid or not (MEASURED
 * 2026-09-28), so an unpaid top-up's credits must not raise the cap until the
 * money arrives. Throws on a Chargebee outage, and should: activate() catches
 * it, holds the account `activating` and blocks the team. A cap of zero would
 * look deliberate and silently cut off a paying customer.
 *
 * `topUpItemPriceIds` is one top-up item price or every currency's. None
 * configured: nothing to hold back, and Chargebee is not asked.
 */
export async function paidGrantedCredits(
  chargebee: Pick<ChargebeeClient, "grantedCredits" | "unpaidTopUpCredits">,
  account: Pick<BillingAccount, "chargebeeCustomerId" | "chargebeeSubscriptionId" | "ledgerUnitId"> | null,
  topUpItemPriceIds: string | string[],
): Promise<string> {
  if (!account?.chargebeeSubscriptionId) return "0";
  const unitId = account.ledgerUnitId ?? undefined;
  const { credits } = await chargebee.grantedCredits(account.chargebeeSubscriptionId, unitId);
  const noTopUps = Array.isArray(topUpItemPriceIds) ? topUpItemPriceIds.length === 0 : topUpItemPriceIds === "";
  if (!account.chargebeeCustomerId || noTopUps) return credits;
  const unpaid = await chargebee.unpaidTopUpCredits({
    customerId: account.chargebeeCustomerId,
    subscriptionId: account.chargebeeSubscriptionId,
    unitId,
    itemPriceId: topUpItemPriceIds,
  });
  return subtractFloorZero(credits, unpaid);
}
