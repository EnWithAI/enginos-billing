/**
 * The LiteLLM team budget for a prepaid tenant — the gate that actually stops
 * spend once the credits are gone.
 *
 * The cap is:
 *
 *     max_budget = spend baseline + USD value of the tenant's LIVE Chargebee grant blocks
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
 *   - Spend in an EARLIER TERM is not this term's credits either. The baseline
 *     moves up when the term does, so a renewal opens with the new grant.
 *     Kept fixed, it did not: the expired block drops out of the live sum but
 *     what it paid for stays in the cumulative spend, so a customer who used
 *     term 1 up renewed into "active" with 1000 fresh credits in Chargebee and
 *     a team LiteLLM refused outright. It moves to the team's spend LESS what
 *     Chargebee has already captured from the new term's blocks, so the
 *     headroom equals the usable balance however late the renewal is pushed.
 *     The term the baseline belongs to is recorded beside it, which is what
 *     makes a second delivery of the same renewal a no-op instead of a second
 *     move.
 *
 * The grant total comes from Chargebee's `/grant_blocks`, excluding blocks it
 * no longer counts as live — which is what makes a renewal (old block expires,
 * new block issued) and a top-up (another block) each move the cap by exactly
 * the right amount. It used to be `SUM(credit_ledger)` over a local table whose
 * `expiry` entries had to be written by hand at every renewal; Chargebee
 * already knows, and asking it removes the second source of truth.
 *
 * Ownership is marked on the team itself: `metadata.billing_managed` tells
 * enginos-platform's provisioning and plan reconciler to leave the budget
 * alone. Clearing it on cancellation hands the team back to the plan, and
 * lifts any block billing put on it.
 *
 * NOTE: a team budget only caps calls made with that team's virtual key.
 * crewpe-agent-core authenticates with the master key, so its calls are not
 * counted against the team and are not capped by this.
 */

import type { GatewayClient } from "../integrations/litellm/client";
import type { BlockReason } from "../models/account-status";
import { creditsToUsd } from "../models/rate";
import type { Logger } from "../shared/logger";

/** Must match `BILLING_MANAGED_METADATA_KEY` in enginos-platform. */
export const BILLING_MANAGED = "billing_managed";
export const SPEND_BASELINE = "billing_spend_baseline";
/** The subscription term (its start, ISO 8601) the spend baseline was taken for. */
export const BASELINE_TERM = "billing_baseline_term";
/** Why billing blocked the team, so whoever reads the team can tell `activating` from `exhausted`. */
export const BLOCK_REASON = "billing_block_reason";

/** How the account service reaches the gateway. Absent hooks mean no gateway is configured. */
export interface BudgetHooks {
  pushBudget?: (tenantId: string, opts?: PushOptions) => Promise<void>;
  blockBudget?: (tenantId: string, reason?: BlockReason) => Promise<void>;
  releaseBudget?: (tenantId: string) => Promise<void>;
  /** Is the team blocked BY BILLING (its block reason is on the team)? A block made by hand is not ours to lift. */
  budgetBlocked?: (tenantId: string) => Promise<boolean>;
}

export interface PushOptions {
  /** Open the team as well as setting the cap. False for an exhausted account. */
  unblock?: boolean;
  /**
   * The subscription's current term start. When it is LATER than the term the
   * baseline was taken for, the baseline moves up for the new term (see
   * `usableCredits`). Omitted, the baseline is left exactly as it is.
   */
  termStart?: Date | null;
  /**
   * Chargebee's usable balance, in credits, read by the caller just before
   * the push. Used only on a RENEWAL, to set the new term's baseline so the
   * team's headroom equals that balance — see push(). Omitted or null (the
   * read failed, or there is no ledger), a renewal baselines at the team's
   * current spend instead.
   */
  usableCredits?: string | null;
  /**
   * Set ONLY by the push that moves the cap onto a currency switch's new
   * subscription (account.service activateAfterSwitch): the credits that
   * subscription's own plan granted on creation (`currency_switch.own_grant`),
   * which the switch's mirror netted out of its balance but which still count
   * in its granted total. The cap does not move — see push(). Absent: an
   * ordinary push.
   */
  switchAdjustCredits?: string;
}

/**
 * A currency switch's push would not guess, and wrote nothing: thrown so the
 * switch waits and tries again (activateAfterSwitch leaves the account
 * `switching`).
 *
 *   no_term      the new subscription's term start is not known, and without
 *                it a repeat of the push could not tell it had already moved
 *                the baseline — it would move it twice
 *   no_balance   the team has no stored baseline to carry over, and no
 *                balance was read to rebuild one from
 */
export class SwitchPushRefused extends Error {
  constructor(
    tenantId: string,
    readonly reason: "no_term" | "no_balance",
  ) {
    super(
      reason === "no_term"
        ? `Tenant ${tenantId}: the currency switch's new subscription has no term start to adopt`
        : `Tenant ${tenantId}'s team has no stored spend baseline, and the currency switch read no balance to rebuild it from`,
    );
    this.name = "SwitchPushRefused";
  }
}

/** Rounded so a float round trip through LiteLLM does not look like a change. */
function usd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function createGatewayBudget(deps: {
  gateway: GatewayClient;
  usdPerCredit: string;
  /**
   * Credits the tenant currently holds, from Chargebee. The ONLY source of this
   * number: there is no local copy to fall back on, and a push that cannot read
   * it must fail rather than guess, or a customer's cap would be set from
   * nothing.
   */
  grantedCreditsFor: (tenantId: string) => Promise<string>;
  /** The tenant's LiteLLM team id — the platform's `org_llm_gateways` row in production. */
  teamIdFor: (tenantId: string) => Promise<string | null>;
  logger?: Logger;
}) {
  const log = deps.logger ?? console;

  async function teamOf(tenantId: string) {
    const teamId = await deps.teamIdFor(tenantId);
    if (!teamId) throw new Error(`Tenant ${tenantId} has no LiteLLM team`);
    const team = await deps.gateway.team(teamId);
    if (!team) throw new Error(`LiteLLM team ${teamId} does not exist`);
    return { teamId, team };
  }

  /**
   * Set the team's cap from Chargebee's grant blocks, and unblock the team if a
   * failed push had blocked it. Idempotent — a no-op when the gateway already holds the
   * cap — so a retry is always safe.
   *
   * The cap and the unblock go in ONE update, so the team never opens under a
   * cap nobody computed.
   */
  async function push(
    tenantId: string,
    { unblock = true, termStart = null, usableCredits = null, switchAdjustCredits }: PushOptions = {},
  ): Promise<{ teamId: string; maxBudget: number; changed: boolean }> {
    const { teamId, team } = await teamOf(tenantId);

    const managed = team.metadata[BILLING_MANAGED] === true;
    const stored = Number(team.metadata[SPEND_BASELINE]);
    const heldTerm = typeof team.metadata[BASELINE_TERM] === "string" ? (team.metadata[BASELINE_TERM] as string) : null;

    // Forward only. A term start EARLIER than the one recorded is a stale read,
    // never a reason to hand back credits already spent.
    const term = termStart ? termStart.toISOString() : null;
    const renewed = managed && term != null && heldTerm != null && Date.parse(term) > Date.parse(heldTerm);
    let nextTerm = term != null && (heldTerm == null || Date.parse(term) > Date.parse(heldTerm)) ? term : heldTerm;

    const spendable = Math.max(Number(await deps.grantedCreditsFor(tenantId)), 0);

    let baseline: number;
    if (switchAdjustCredits !== undefined) {
      // A CURRENCY SWITCH, and the cap must not move. The org's credits were
      // copied block for block onto a new subscription and its consumption
      // mirrored there, so the new subscription's paid grant is the old one's
      // PLUS whatever its own plan granted on creation — which the switch
      // netted out of the balance but which still counts in the grant. So the
      // stored baseline drops by exactly that, and max_budget after is
      // max_budget before. Never the renewal branch: the new subscription's
      // term start is later than the one held, and read as a renewal with a
      // balance the switch may not have, the baseline jumped to the team's
      // spend and the cap by every credit already used (MEASURED in a
      // simulation: $20 to $32). Its term is ADOPTED instead, so no later
      // activation sees a renewal either — and a repeat of this push (the
      // switch re-run after a crash) finds it adopted, and moves nothing twice.
      if (term == null) throw new SwitchPushRefused(tenantId, "no_term");
      nextTerm = term;
      if (managed && Number.isFinite(stored)) {
        baseline = heldTerm === term ? stored : usd(stored - Number(creditsToUsd(switchAdjustCredits, deps.usdPerCredit)));
      } else if (usableCredits != null && Number.isFinite(Number(usableCredits))) {
        // No cap to carry over (a team billing has not managed, or one from
        // before baselines were stored): built as a renewal is, against the
        // balance the switch read — never against the bare spend.
        const consumed = Math.max(spendable - Number(usableCredits), 0);
        baseline = usd(team.spend - Number(creditsToUsd(consumed, deps.usdPerCredit)));
      } else {
        throw new SwitchPushRefused(tenantId, "no_balance");
      }
    } else if (managed && Number.isFinite(stored) && !renewed) {
      baseline = stored;
    } else if (renewed && usableCredits != null && Number.isFinite(Number(usableCredits))) {
      // A renewal baselines against CHARGEBEE, not against the spend at the
      // moment of this push. The push can come well after the term boundary —
      // seconds after a webhook, up to a day after a lost one that the daily
      // resync repairs — and every call served in between is in `team.spend`
      // AND is captured from the new grant. Baselined at the current spend,
      // those calls were counted once by Chargebee and zero times by the cap,
      // and LiteLLM let the customer spend them a second time. Taking out what
      // the live blocks have already given up (granted − usable) makes the
      // headroom equal Chargebee's usable balance. Only usage not yet captured
      // (the sync's lag, minutes) can still differ.
      const consumed = Math.max(spendable - Number(usableCredits), 0);
      baseline = usd(team.spend - Number(creditsToUsd(consumed, deps.usdPerCredit)));
    } else {
      baseline = usd(team.spend);
    }

    const maxBudget = usd(baseline + Number(creditsToUsd(spendable, deps.usdPerCredit)));

    const capHeld =
      managed &&
      team.maxBudget != null &&
      usd(team.maxBudget) === maxBudget &&
      team.budgetDuration == null &&
      heldTerm === nextTerm;
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
        metadata: {
          ...(unblock ? unblocked : team.metadata),
          [BILLING_MANAGED]: true,
          [SPEND_BASELINE]: baseline,
          ...(nextTerm != null ? { [BASELINE_TERM]: nextTerm } : {}),
        },
        // Whenever this push is meant to open the team, say so — not only when
        // the read above SAW it blocked. That read can be stale: a concurrent
        // activation that failed may block the team between it and this write,
        // and a write that left `blocked` out would leave that block standing
        // under an account marked active.
        ...(unblock ? { blocked: false } : {}),
      });
    }

    return { teamId, maxBudget, changed: !capHeld || opening };
  }

  /**
   * Refuse every request on the tenant's team, recording why in its metadata: `activating` (a push failed; the customer has paid but the gateway
   * does not hold it yet) or `exhausted` (the Chargebee credits are used up).
   *
   * Via /team/update, NOT /team/block: MEASURED on 1.98, /team/block writes the
   * DB but leaves the cached team, so a team used in the last minute kept
   * serving after being blocked. /team/update refreshes the cache.
   *
   * A team already blocked for this reason is left alone: the usage sync
   * re-asserts an exhausted team's block every tick, and that costs one read.
   */
  async function block(tenantId: string, reason: BlockReason = "activating"): Promise<void> {
    const { teamId, team } = await teamOf(tenantId);
    if (team.blocked && team.metadata[BLOCK_REASON] === reason) return;
    await deps.gateway.updateTeam({
      team_id: teamId,
      blocked: true,
      metadata: { ...team.metadata, [BLOCK_REASON]: reason },
    });
  }

  /**
   * Hand the team back to its plan. The cap itself is left for the platform's
   * reconciler, which now sees it as drift and restores the plan budget.
   *
   * It also lifts BILLING'S OWN BLOCK. A team blocked when the cancellation
   * arrives — exhausted, or held activating — used to keep `blocked: true`
   * with ownership gone: the platform's reconciler never sends `blocked`, so
   * nothing would ever open it again and the customer lost the free plan as
   * well. The block is lifted only when billing's reason is on the team; a
   * team blocked by hand carries no reason and stays blocked.
   *
   * A tenant with no team, or a team LiteLLM does not have, has nothing to
   * hand back — provisioning is fail-open, so that is a real state, not a
   * failure. It answers `released: false` rather than throwing: a throw here
   * fails the cancellation webhook with a 500 on every redelivery and the
   * daily resync with a tenant error, for ever, over a team that is not there.
   * A LiteLLM that cannot be reached still throws, so that is retried.
   */
  async function release(tenantId: string): Promise<{ released: boolean }> {
    const teamId = await deps.teamIdFor(tenantId);
    const team = teamId ? await deps.gateway.team(teamId) : null;
    if (!teamId || !team) {
      log.warn?.(
        { metric: "billing.budget.release_no_team", tenantId, teamId },
        "No LiteLLM team to hand back; nothing to release",
      );
      return { released: false };
    }

    const managed = team.metadata[BILLING_MANAGED] === true;
    const blockedByBilling = team.metadata[BLOCK_REASON] != null;
    if (!managed && !blockedByBilling) return { released: false };

    const {
      [BILLING_MANAGED]: _managed,
      [SPEND_BASELINE]: _baseline,
      [BASELINE_TERM]: _term,
      [BLOCK_REASON]: _reason,
      ...metadata
    } = team.metadata;
    await deps.gateway.updateTeam({
      team_id: teamId,
      metadata,
      // Sent whenever billing's reason is on the team, not only when this read
      // saw the team blocked: the read can be stale, exactly as in push().
      ...(blockedByBilling ? { blocked: false } : {}),
    });
    return { released: true };
  }

  /**
   * Is the team refusing every request because BILLING blocked it?
   *
   * A team blocked with no billing reason on it was blocked by someone else
   * (by hand in LiteLLM, say), and is not billing's to reopen.
   */
  async function isBlocked(tenantId: string): Promise<boolean> {
    const { team } = await teamOf(tenantId);
    return team.blocked && team.metadata[BLOCK_REASON] != null;
  }

  return { push, block, release, isBlocked };
}

export type GatewayBudgetService = ReturnType<typeof createGatewayBudget>;

/** Adapts the budget service to the hooks the account service calls. */
export function budgetHooksFor(budget: GatewayBudgetService): BudgetHooks {
  return {
    pushBudget: async (tenantId, opts) => void (await budget.push(tenantId, opts)),
    blockBudget: (tenantId, reason) => budget.block(tenantId, reason),
    releaseBudget: async (tenantId) => void (await budget.release(tenantId)),
    budgetBlocked: (tenantId) => budget.isBlocked(tenantId),
  };
}
