/**
 * The LiteLLM budget hooks for this process's configuration.
 *
 * Its own module so a test can replace the gateway without touching the rest
 * of the composition root.
 */

import { getConfig } from "../config/config";
import { createChargebee } from "../integrations/chargebee";
import { createGatewayClient } from "../integrations/litellm/client";
import { createBillingAccountRepository } from "../repositories/billing-account.repository";
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

  return budgetHooksFor(
    createGatewayBudget({
      gateway: createGatewayClient(config.litellm),
      usdPerCredit: config.usdPerCredit,
      teamIdFor: (tenantId) => platform.litellmTeamId(tenantId),
      grantedCreditsFor: async (tenantId) => {
        const account = await accounts.findByTenantId(tenantId);
        if (!account?.chargebeeSubscriptionId) return "0";
        // Throws on a Chargebee outage, and should: activate() catches it,
        // holds the account `activating` and blocks the team. A cap of zero
        // would look deliberate and silently cut off a paying customer.
        const { credits } = await chargebee.grantedCredits(
          account.chargebeeSubscriptionId,
          account.ledgerUnitId ?? undefined,
        );
        return credits;
      },
    }),
  );
}
