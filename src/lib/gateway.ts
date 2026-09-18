/**
 * The LiteLLM team budget for a prepaid tenant — the gate that actually stops
 * spend once the credits are gone.
 *
 * The cap is:
 *
 *     max_budget = spend baseline + USD value of (credits granted − credits expired)
 *
 * and the team's rolling `budget_duration` is cleared. Both halves matter:
 *
 *   - The plan's `30d` window resets spend on LiteLLM's own schedule, not on
 *     the Chargebee term. Left in place, a tenant could spend a month's credits,
 *     get reset on the 1st, and spend them again before the term ended. With no
 *     duration, team spend is cumulative and the cap is too.
 *   - Spend before the subscription (free-plan usage) is not the customer's
 *     credits. The baseline is the team's spend at the moment billing took the
 *     team over, so the credits start counting from there.
 *
 * Granted and expired are both running totals from the ledger, so a renewal
 * (expire leftover, grant new term) and a top-up (grant more) each move the cap
 * by exactly the right amount without resetting anything.
 *
 * Ownership is marked on the team itself: `metadata.billing_managed` tells
 * enginos-platform's provisioning and plan reconciler to leave the budget
 * alone. Clearing it on cancellation hands the team back to the plan.
 *
 * NOTE: a team budget only caps calls made with that team's virtual key.
 * crewpe-agent-core authenticates with the master key, so its calls are not
 * counted against the team and are not capped by this.
 */

import { getConfig } from "./config";
import { prisma as defaultPrisma } from "./db";
import { balanceOf } from "./ledger";
import { creditsToUsd } from "./rate";

/** Must match `BILLING_MANAGED_METADATA_KEY` in enginos-platform. */
export const BILLING_MANAGED = "billing_managed";
export const SPEND_BASELINE = "billing_spend_baseline";
/** Why billing blocked the team; must match `BLOCK_REASON` in litellm/billing_guard.py. */
export const BLOCK_REASON = "billing_block_reason";

export type BlockReason = "activating" | "exhausted";

export interface GatewayTeam {
  spend: number;
  maxBudget: number | null;
  budgetDuration: string | null;
  /** A blocked team's keys are refused outright, whatever the budget says. */
  blocked: boolean;
  metadata: Record<string, unknown>;
}

export interface GatewayClient {
  team(teamId: string): Promise<GatewayTeam | null>;
  updateTeam(body: Record<string, unknown>): Promise<void>;
}

export function createGatewayClient({
  baseUrl,
  masterKey,
  timeoutMs = 10_000,
  fetchImpl = globalThis.fetch,
}: {
  baseUrl: string;
  masterKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): GatewayClient {
  const base = baseUrl.replace(/\/+$/, "");

  async function call(method: "GET" | "POST", path: string, body?: unknown) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${masterKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, any>;
    return { status: response.status, ok: response.ok, payload };
  }

  return {
    async team(teamId) {
      const { status, ok, payload } = await call("GET", `/team/info?team_id=${encodeURIComponent(teamId)}`);
      if (status === 404) return null;
      if (!ok) throw new Error(`LiteLLM /team/info failed (${status})`);
      const info = payload.team_info ?? {};
      return {
        spend: Number(info.spend ?? 0),
        maxBudget: info.max_budget ?? null,
        budgetDuration: info.budget_duration ?? null,
        blocked: info.blocked === true,
        metadata: info.metadata ?? {},
      };
    },

    async updateTeam(body) {
      const { status, ok } = await call("POST", "/team/update", body);
      if (!ok) throw new Error(`LiteLLM /team/update failed (${status})`);
    },
  };
}

/** Rounded so a float round trip through LiteLLM does not look like a change. */
function usd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function createGatewayBudget(deps: {
  gateway: GatewayClient;
  usdPerCredit: string;
  prisma?: typeof defaultPrisma;
  /** The tenant's LiteLLM team id. Defaults to the platform's `org_llm_gateways` row. */
  teamIdFor?: (tenantId: string) => Promise<string | null>;
}) {
  const prisma = deps.prisma ?? defaultPrisma;

  const teamIdFor =
    deps.teamIdFor ??
    (async (tenantId: string) => {
      // Read raw: the table belongs to enginos-platform (see account.ts).
      const rows = await prisma.$queryRaw<Array<{ litellm_team_id: string | null }>>`
        SELECT litellm_team_id FROM org_llm_gateways WHERE tenant_id = ${tenantId}::uuid LIMIT 1
      `;
      return rows[0]?.litellm_team_id ?? null;
    });

  async function teamOf(tenantId: string) {
    const teamId = await teamIdFor(tenantId);
    if (!teamId) throw new Error(`Tenant ${tenantId} has no LiteLLM team`);
    const team = await deps.gateway.team(teamId);
    if (!team) throw new Error(`LiteLLM team ${teamId} does not exist`);
    return { teamId, team };
  }

  /**
   * Set the team's cap from the ledger, and unblock the team if a failed push
   * had blocked it. Idempotent — a no-op when the gateway already holds the
   * cap — so a retry is always safe.
   *
   * The cap and the unblock go in ONE update, so the team never opens under a
   * cap nobody computed.
   */
  async function push(
    tenantId: string,
    { unblock = true }: { unblock?: boolean } = {},
  ): Promise<{ teamId: string; maxBudget: number; changed: boolean }> {
    const { teamId, team } = await teamOf(tenantId);

    const managed = team.metadata[BILLING_MANAGED] === true;
    const stored = Number(team.metadata[SPEND_BASELINE]);
    const baseline = managed && Number.isFinite(stored) ? stored : usd(team.spend);

    const balance = await balanceOf(tenantId, prisma);
    const spendable = Number(balance.allocated) - Number(balance.expired);
    const maxBudget = usd(baseline + Number(creditsToUsd(Math.max(spendable, 0), deps.usdPerCredit)));

    const capHeld =
      managed && team.maxBudget != null && usd(team.maxBudget) === maxBudget && team.budgetDuration == null;
    const opening = unblock && team.blocked;

    if (!capHeld || opening) {
      // `/team/update` replaces metadata wholesale — merge, never replace. An
      // opening team also drops the reason it was blocked for.
      const { [BLOCK_REASON]: _reason, ...unblocked } = team.metadata;
      await deps.gateway.updateTeam({
        team_id: teamId,
        max_budget: maxBudget,
        // Explicit null: LiteLLM applies only the fields sent, and a null
        // duration also clears `budget_reset_at`, so spend stops resetting.
        budget_duration: null,
        metadata: { ...(opening ? unblocked : team.metadata), [BILLING_MANAGED]: true, [SPEND_BASELINE]: baseline },
        ...(opening ? { blocked: false } : {}),
      });
    }

    return { teamId, maxBudget, changed: !capHeld || opening };
  }

  /**
   * Refuse every request on the tenant's team, recording why for the guard's
   * message: `activating` (a push failed; the customer has paid but the gateway
   * does not hold it yet) or `exhausted` (the Chargebee credits are used up).
   *
   * Via /team/update, NOT /team/block: MEASURED on 1.98, /team/block writes the
   * DB but leaves the cached team, so a team used in the last minute kept
   * serving after being blocked. /team/update refreshes the cache.
   */
  async function block(tenantId: string, reason: BlockReason = "activating"): Promise<void> {
    const { teamId, team } = await teamOf(tenantId);
    await deps.gateway.updateTeam({
      team_id: teamId,
      blocked: true,
      metadata: { ...team.metadata, [BLOCK_REASON]: reason },
    });
  }

  /**
   * Hand the team back to its plan. The cap itself is left for the platform's
   * reconciler, which now sees it as drift and restores the plan budget.
   */
  async function release(tenantId: string): Promise<{ released: boolean }> {
    const { teamId, team } = await teamOf(tenantId);
    if (team.metadata[BILLING_MANAGED] !== true) return { released: false };

    const { [BILLING_MANAGED]: _managed, [SPEND_BASELINE]: _baseline, ...metadata } = team.metadata;
    await deps.gateway.updateTeam({ team_id: teamId, metadata });
    return { released: true };
  }

  return { push, block, release };
}

/** The configured gateway budget, or null when no master key is set. */
export function gatewayBudgetFromConfig() {
  const config = getConfig();
  if (!config.litellm.masterKey) return null;
  return createGatewayBudget({
    gateway: createGatewayClient(config.litellm),
    usdPerCredit: config.usdPerCredit,
  });
}

let warnedUnconfigured = false;

/** Account hooks for the configured gateway; none — with one warning — when unconfigured. */
export function gatewayBudgetHooks(): {
  pushBudget?: (tenantId: string, opts?: { unblock?: boolean }) => Promise<void>;
  blockBudget?: (tenantId: string, reason?: BlockReason) => Promise<void>;
  releaseBudget?: (tenantId: string) => Promise<void>;
} {
  const budget = gatewayBudgetFromConfig();
  if (!budget) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        { metric: "billing.budget.gateway_unconfigured" },
        "LITELLM_MASTER_KEY is not set; LiteLLM team budgets will not be pushed",
      );
    }
    return {};
  }
  return {
    pushBudget: async (tenantId, opts) => void (await budget.push(tenantId, opts)),
    blockBudget: (tenantId, reason) => budget.block(tenantId, reason),
    releaseBudget: async (tenantId) => void (await budget.release(tenantId)),
  };
}
