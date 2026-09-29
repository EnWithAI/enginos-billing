/**
 * Account lifecycle: customer creation, subscription linking, budget push.
 *
 * What this file does NOT do any more is keep a record of the money. There is
 * no grant entry, no expiry entry, no balance and no cached credit figure: the
 * grant is created by Chargebee from the item price's Credit Grant
 * configuration, expired by Chargebee at renewal, and read back from Chargebee
 * whenever anyone needs to know. What is written here is the mapping — which
 * Chargebee customer and subscription a tenant is — and the operational status
 * that decides what the gateway enforces.
 *
 * `/ledger_operations/allocate` is still called for one thing only: a top-up
 * pack, which is an ad-hoc grant Chargebee does not issue by itself. And the
 * one record of money kept here is the top-up guard (`topup_grant`): which
 * paid invoices have been granted. Chargebee keeps nothing that ties an
 * allocation to its invoice, so this is the only place that can know.
 */

import type { PrismaClient } from "../db/prisma";
import { isDefiniteRefusal, type ChargebeeClient, type ChargebeeError, type GrantBlock } from "../integrations/chargebee";
import { ACCOUNT, type BlockReason } from "../models/account-status";
import { add, compare, multiply, subtractFloorZero } from "../models/decimal";
import { isBillable } from "../models/rate";
import { realmToRoutingSlug } from "../models/routing-slug";
import { chooseBillingSubscription, itemPriceIdOf } from "../models/subscription";
import { createBillingAccountRepository, type BillingAccountRepository } from "../repositories/billing-account.repository";
import { createPlatformRepository, type PlatformRepository } from "../repositories/platform.repository";
import {
  TOPUP,
  TOPUP_SOURCE,
  createTopUpGrantRepository,
  type TopUpAttempt,
  type TopUpGrant,
  type TopUpGrantRepository,
} from "../repositories/topup-grant.repository";
import { errorMessage } from "../shared/errors";
import type { Logger } from "../shared/logger";

/**
 * How long a SENDING top-up belongs to the caller that claimed it: the longest
 * one allocate can take (three 20-second attempts with backoff), with margin.
 * Only a crashed sender's row waits this out.
 */
export const TOPUP_CLAIM_LEASE_MS = 2 * 60_000;

/**
 * How long a retry may re-send under the SAME `chargebee-idempotency-key`.
 * Chargebee replays a key for 30 minutes; five are kept back for the clocks.
 */
export const TOPUP_KEY_REPLAY_MS = 25 * 60_000;

/** Slack between our clock and Chargebee's `created_at` when matching an allocation to its grant block. */
const TOPUP_EVIDENCE_SKEW_MS = 2 * 60_000;

/**
 * How close an allocation's operation time and its grant block's `created_at`
 * are. MEASURED: the same second (op 2082089061337649922 and block
 * B0FYuUVW8TAKdE2, both 1790248715); a few seconds of margin.
 */
const TOPUP_OPERATION_BLOCK_MS = 5_000;

/**
 * How far in the future a top-up's `expires_at` must be when it is stored. A
 * stored request is re-sent unchanged for TOPUP_KEY_REPLAY_MS, so this is
 * longer: every send of it is still a grant the customer can spend, and one
 * Chargebee does not refuse for an expiry in the past.
 */
export const TOPUP_MIN_EXPIRY_LEAD_MS = 60 * 60_000;

/** The expiry used when no term end can be trusted: 30 days out. */
const TOPUP_FALLBACK_EXPIRY_MS = 30 * 24 * 60 * 60_000;

export interface AccountDeps {
  /** Builds the repositories when they are not given. Tests pass a fake here. */
  prisma?: PrismaClient;
  accounts?: BillingAccountRepository;
  platform?: PlatformRepository;
  topUps?: TopUpGrantRepository;
  chargebee: ChargebeeClient;
  usdPerCredit: string;
  /**
   * The plans we sell usage billing against (`ITEM_PRICE_IDS`). Used to tell a
   * usage subscription from anything else a customer happens to hold — see
   * models/subscription.ts.
   */
  billingItemPriceIds?: string[];
  /**
   * Sets the tenant's LiteLLM team cap from Chargebee's grant blocks (see
   * gateway-budget.service.ts). When present, an account is only `active` once this has
   * succeeded. Absent = no gateway configured: accounts go straight to
   * `active`, unenforced. `termStart` is the subscription's current term, so
   * the cap can tell a renewal from a re-read of the same term.
   */
  pushBudget?: (
    tenantId: string,
    opts?: { unblock?: boolean; termStart?: Date | null; usableCredits?: string | null },
  ) => Promise<void>;
  /** Blocks the tenant's LiteLLM team outright: a failed push, or Chargebee credits used up. */
  blockBudget?: (tenantId: string, reason?: BlockReason) => Promise<void>;
  /** Hands the tenant's LiteLLM team back to its plan budget when the subscription ends. */
  releaseBudget?: (tenantId: string) => Promise<void>;
  /**
   * The top-up charge. Its credits count only once its invoice is paid, so a
   * declined top-up's — which Chargebee grants with the invoice — are held
   * back from the usable balance. Absent: nothing is held back.
   */
  topUpItemPriceId?: string;
  /** Is the tenant's LiteLLM team blocked BY BILLING right now? Read by the minute's gate check. */
  budgetBlocked?: (tenantId: string) => Promise<boolean>;
  clock?: () => number;
  logger?: Logger;
}

export function createAccountService(deps: AccountDeps) {
  const accounts = deps.accounts ?? createBillingAccountRepository(deps.prisma);
  const platform = deps.platform ?? createPlatformRepository(deps.prisma);
  const topUps = deps.topUps ?? createTopUpGrantRepository(deps.prisma);
  const clock = deps.clock ?? (() => Date.now());
  const log = deps.logger ?? console;

  /**
   * Create the billing_account row for a tenant that has never been billed.
   *
   * Billing is NOT wired into tenant provisioning — the platform knows nothing
   * about this service. So the row has to be created on first use, and the only
   * facts we need come from tables the platform owns.
   *
   * The platform's tables are read through platform.repository.ts, never
   * modelled in our schema.
   *
   * The slug prefers the gateway row but falls back to deriving it from the
   * realm, because `provisionOrgGateway` is fail-open — a tenant can exist and
   * serve traffic with no gateway row at all.
   */
  async function tenantFacts(tenantId: string) {
    const tenant = await platform.tenantFacts(tenantId);
    if (!tenant) return null;
    return {
      tenantId: tenant.tenantId,
      routingSlug: tenant.gatewaySlug ?? realmToRoutingSlug(tenant.realmName),
      orgName: tenant.orgName,
    };
  }

  async function bootstrapFromTenant(tenantId: string, billingEmail?: string) {
    const facts = await tenantFacts(tenantId);
    if (!facts) return null;
    return ensureCustomer({ ...facts, billingEmail });
  }

  /**
   * Create the local row for a tenant that has merely LOOKED at billing, without
   * touching Chargebee.
   *
   * Deliberately NOT ensureCustomer: opening a page is a read, and must not be
   * what puts a record in a third-party system. The customer is created at
   * onboarding (checkout.provisionFreePlan, which enginos-platform calls once
   * per new org) and, for an org that onboarding never reached, at checkout;
   * `ensureCustomer` upserts the same row so the paths converge.
   *
   * It lays down NO billing origin. Billing starts when the customer
   * subscribes, not when they look at the page — see ensureBillingCursor().
   *
   * Returns null when the tenant does not exist in the platform's tables, which
   * the caller renders as the unlinked shape rather than an error.
   */
  async function ensureLocalAccount(tenantId: string) {
    const existing = await accounts.findByTenantId(tenantId);
    if (existing) return existing;

    const facts = await tenantFacts(tenantId);
    if (!facts) return null;

    return accounts.createUnlinked(facts.tenantId, facts.routingSlug);
  }

  /**
   * Called from tenant provisioning. Writes the local row FIRST, then attempts
   * Chargebee.
   *
   * That order is deliberate and the opposite of the prototype's. Provisioning
   * must not block on Chargebee — every step after the database is created is
   * already fire-and-forget — but unlike the LLM gateway, a tenant with no
   * billing customer can never be charged, so the failure must be *recorded*
   * rather than swallowed. An `unlinked` row is a work item a reconciler can
   * find; a missing row is invisible.
   */
  async function ensureCustomer(args: {
    tenantId: string;
    routingSlug: string;
    orgName?: string;
    billingEmail?: string;
  }) {
    const account = await accounts.upsertCustomer(args);

    if (account.chargebeeCustomerId) return account;

    try {
      // The tenant UUID IS the Chargebee customer id. Supplying it rather than
      // letting Chargebee generate one makes creation idempotent: a retry
      // collides on Chargebee's side instead of creating a second customer.
      const customer = await deps.chargebee.createCustomer({
        id: args.tenantId,
        email: args.billingEmail,
        company: args.orgName,
      });

      return await accounts.setCustomerId(args.tenantId, customer.id);
    } catch (err) {
      log.error?.(
        { metric: "billing.customer.create_failed", tenantId: args.tenantId, err: errorMessage(err) },
        "Chargebee customer creation failed; account left unlinked for reconciliation",
      );
      return account;
    }
  }

  /**
   * Set the tenant's billing cursor — the point billing starts from.
   *
   * THE ACTIVATION POINT. It sits at now, so the worker bills from the moment
   * the customer subscribed and never backwards: ClickHouse holds 90 days of
   * spans for every tenant, and a cursor that started at zero would invoice a
   * quarter of free-plan usage on the first tick. This replaces the old
   * `billing_account.sync_from` column, which existed for exactly this and was
   * then also used as a filter on the LLM span's own Timestamp — which is what
   * made a late-arriving span unbillable.
   *
   * CREATE-ONLY, and that is the whole of its correctness. A renewal, a plan
   * change, a repair sync and a replayed webhook all reach this, and any of
   * them resetting the cursor to now() would silently skip every span ingested
   * since the last window — usage the customer had already incurred, gone with
   * no error anywhere. The `IS NULL` in the update is what makes running it
   * twice a no-op; a test pins it. The one deliberate forward move is a
   * resubscription after a CANCELLATION (syncSubscription), where the spans
   * since the last window were incurred with no subscription to pay for them.
   */
  async function ensureBillingCursor(tenantId: string) {
    await accounts.layCursorIfMissing(tenantId, new Date(clock()));
  }

  /**
   * Link a subscription and make the gateway hold what the customer bought.
   *
   * Idempotent by construction: everything written here is read from Chargebee
   * and applied whole, so running it twice — the webhook and the post-checkout
   * pull both fire after every checkout — converges instead of compounding.
   * That used to require an idempotency key on a grant entry, because a second
   * run would otherwise write a second grant. With no grant to write, there is
   * nothing to key.
   */
  async function syncSubscription(args: {
    tenantId: string;
    subscriptionId: string;
    itemPriceId?: string | null;
    termStart?: Date | null;
    termEnd?: Date | null;
    status?: string;
  }) {
    const before = await accounts.findByTenantId(args.tenantId);

    // The unit usage is captured from. KEPT whenever the account is already
    // linked to this subscription: a second unit appearing on it — a top-up
    // whose item carries its own Credit Grant into another unit — must never
    // move billing onto that unit, and which balance Chargebee happens to list
    // first is no reason to (C57b). Chosen only on a first link or a move to a
    // different subscription, and then as the subscription's OLDEST unit (the
    // plan's grant creates it with the subscription) — said out loud when
    // there was more than one to choose from.
    const keptUnit = before?.chargebeeSubscriptionId === args.subscriptionId ? before.ledgerUnitId : null;
    const balance = await deps.chargebee.balance(args.subscriptionId, keptUnit);
    if (keptUnit && !balance) await reportMissingUnit(args.tenantId, args.subscriptionId, keptUnit);
    const ledgerUnitId = keptUnit ?? balance?.unitId ?? null;
    if (!keptUnit && balance && (balance.unitCount ?? 1) > 1) {
      log.warn?.(
        {
          metric: "billing.subscription.multiple_units",
          tenantId: args.tenantId,
          subscriptionId: args.subscriptionId,
          chosen: balance.unitId,
          units: balance.unitCount,
        },
        "The subscription holds more than one credit unit; billing uses its oldest (the plan's). Check the catalogue if that is wrong",
      );
    }

    // Coming back from a cancellation, billing starts NOW — the one case where
    // the cursor moves forward without a window being billed.
    //
    // While the account was cancelled the usage sync left its cursor where the
    // cancellation found it, and everything ingested since is free-plan usage
    // that no subscription paid for. Carried on from there, the first tick
    // after the resubscribe would bill all of it against the NEW grant, while
    // the LiteLLM cap (re-baselined at the team's current spend) would not
    // count it: the customer charged for usage they never bought, and the two
    // systems disagreeing by exactly that amount. Done BEFORE the link, while
    // the account still reads cancelled, so no sync can bill from the old
    // cursor in between. A sync row still owed from before the cancellation is
    // untouched: it is recovered as ever, against the subscription pinned on it.
    if (before?.status === ACCOUNT.CANCELLED) {
      const at = new Date(clock());
      if (await accounts.restartCursorAt(args.tenantId, at)) {
        log.warn?.(
          {
            metric: "billing.cursor.restarted",
            tenantId: args.tenantId,
            from: before.lastProcessedIngestedAt?.toISOString() ?? null,
            at: at.toISOString(),
          },
          "Resubscribed after a cancellation; billing restarts now and the cancelled period is not billed",
        );
      }
    }

    const account = await accounts.linkSubscription(args.tenantId, {
        chargebeeSubscriptionId: args.subscriptionId,
        chargebeeItemPriceId: args.itemPriceId ?? undefined,
        ledgerUnitId,
        currentTermStart: args.termStart ?? undefined,
        currentTermEnd: args.termEnd ?? undefined,
        // Not active until the gateway holds the budget — see activate().
        status: deps.pushBudget ? ACCOUNT.ACTIVATING : (args.status ?? ACCOUNT.ACTIVE),
    });

    // Before activate(), so the tenant cannot become billable without a cursor.
    await ensureBillingCursor(account.tenantId);

    // The gateway budget is the enforcement gate, and it is driven by the GRANT,
    // never by the remaining balance: the usage sync lags by an ingestion buffer
    // plus a cron interval, so a balance-derived budget would let a tenant
    // overspend for that whole window before the gate noticed.
    return activate(args.tenantId, args.status ?? ACCOUNT.ACTIVE);
  }

  /**
   * The account's stored unit is not on its subscription — a stale
   * `ledger_unit_id`, or a catalogue change. It is KEPT: moving billing onto
   * whichever unit the subscription has is exactly the silent relink C57b
   * removed. But captures against it will be refused and its balance reads as
   * unknown, so it is said out loud, with the units that do exist. None at all
   * is the ordinary no-ledger case and says nothing here. A diagnostic: a
   * failed read changes nothing.
   */
  async function reportMissingUnit(tenantId: string, subscriptionId: string, unitId: string) {
    let units: string[];
    try {
      units = await deps.chargebee.ledgerUnits(subscriptionId);
    } catch {
      return;
    }
    if (units.length === 0 || units.includes(unitId)) return;
    log.error?.(
      { metric: "billing.subscription.unit_missing", tenantId, subscriptionId, ledgerUnitId: unitId, units },
      "The account's credit unit is not on its subscription. It is kept (billing never moves itself onto another unit); captures against it will be refused. Correct ledger_unit_id by hand",
    );
  }

  /**
   * Make the gateway hold what Chargebee granted, and only then mark the
   * account `target` (normally active).
   *
   * Fail closed. If the push does not land, the customer has paid but the
   * gateway enforces a budget nobody computed — possibly the free plan's, higher
   * than what they bought. So the account is held `activating` (the page shows
   * no credits) and its LiteLLM team is blocked until a retry lands. The
   * credits are in Chargebee; nothing is lost, only paused.
   *
   * Nor does it open a team whose Chargebee credits are used up: the cap is set
   * but the team stays blocked and the account `exhausted` until credits arrive.
   *
   * NEVER OVER A CANCELLATION. An activation is not serialised with cancel(),
   * and every writer that reaches this — the minute's retries, a top-up, a
   * webhook racing the post-checkout pull — can have read the account just
   * before a cancellation landed. So nothing is pushed to an account already
   * cancelled, every status write refuses to replace `cancelled`, and every
   * gateway write is followed by a look at the status: if a cancellation got in
   * meanwhile, the team is handed back again. cancel() writes its status BEFORE
   * its own release, so whichever of the two runs last sees the other.
   */
  async function activate(tenantId: string, target: string = ACCOUNT.ACTIVE) {
    const account = await accounts.findByTenantId(tenantId);
    if (!account) throw new Error(`No billing account for tenant ${tenantId}`);
    if (account.status === ACCOUNT.CANCELLED) return account;

    const usable = await usableCredits(account);
    const exhausted = usable != null && !isBillable(usable);

    try {
      // No gateway configured means nothing to hold for: active immediately.
      if (deps.pushBudget) {
        await deps.pushBudget(tenantId, {
          unblock: !exhausted,
          termStart: account.currentTermStart ?? null,
          usableCredits: usable,
        });
      }
    } catch (err) {
      log.error?.(
        { metric: "billing.budget.push_failed", tenantId, err: errorMessage(err) },
        "Could not set the LiteLLM budget; account held as activating and its team blocked until a retry lands",
      );
      const held = await accounts.setStatusUnlessCancelled(tenantId, ACCOUNT.ACTIVATING);
      if (!held.changed) return handBack(tenantId, held.account);
      await block(tenantId, "activating");
      return (await handBackIfCancelled(tenantId)) ?? held.account;
    }

    if (exhausted) {
      const marked = await accounts.setStatusUnlessCancelled(tenantId, ACCOUNT.EXHAUSTED);
      if (!marked.changed) return handBack(tenantId, marked.account);
      await block(tenantId, "exhausted");
      return (await handBackIfCancelled(tenantId)) ?? marked.account;
    }

    // Nothing to requeue: usage the last capture could not pay for is still in
    // ClickHouse, in front of a cursor that never moved past it, and the next
    // tick offers it again.
    const opened = await accounts.setStatusUnlessCancelled(tenantId, target);
    // Refused only because a cancellation got in — and the push above may
    // have re-managed the team it had just handed back.
    return opened.changed ? opened.account : handBack(tenantId, opened.account);
  }

  /** Best effort: a failed block is logged, and the next grant or retry tries again. */
  async function block(tenantId: string, reason: BlockReason) {
    if (!deps.blockBudget) return;
    try {
      await deps.blockBudget(tenantId, reason);
    } catch (err) {
      // For `activating` this is usually the same outage that failed the push;
      // the minute retry tries both again. Until then the team keeps its budget.
      log.error?.(
        { metric: "billing.budget.block_failed", tenantId, reason, err: errorMessage(err) },
        "Could not block the LiteLLM team; it keeps its previous budget until a retry lands",
      );
    }
  }

  /**
   * A cancellation landed while an activation was writing to the gateway:
   * hand the team back again, so the write that lost the race does not leave
   * a cancelled customer billing-managed or blocked. Best effort — a failure
   * is logged, and the daily resync re-runs cancel() for an ended
   * subscription.
   */
  async function handBack<T>(tenantId: string, account: T): Promise<T> {
    log.warn?.(
      { metric: "billing.account.cancelled_during_activation", tenantId },
      "The account was cancelled while it was being activated; handing the team back to its plan",
    );
    if (deps.releaseBudget) {
      try {
        await deps.releaseBudget(tenantId);
      } catch (err) {
        log.error?.(
          { metric: "billing.budget.release_failed", tenantId, err: errorMessage(err) },
          "Could not hand the gateway budget back to the plan; the daily resync retries it",
        );
      }
    }
    return account;
  }

  /** Re-read the account after a gateway write; hand the team back if it is now cancelled. */
  async function handBackIfCancelled(tenantId: string) {
    const now = await accounts.findByTenantId(tenantId);
    if (now?.status !== ACCOUNT.CANCELLED) return null;
    return handBack(tenantId, now);
  }

  /**
   * Chargebee's usable balance, in credits — null when there is no ledger or
   * it cannot be read. A failed read is NOT evidence of exhaustion: blocking a
   * paying customer on a transient Chargebee error would be worse than the
   * minute until the next capture tells us for certain.
   */
  async function usableCredits(account: {
    tenantId: string;
    chargebeeCustomerId?: string | null;
    chargebeeSubscriptionId: string | null;
    ledgerUnitId: string | null;
  }): Promise<string | null> {
    if (!account.chargebeeSubscriptionId) return null;
    const tenantId = account.tenantId;
    try {
      // The ACCOUNT'S unit — the one captures draw from. Another unit's
      // balance (a top-up granted into the wrong unit) says nothing about
      // whether this account can pay, and reading "the first balance" opened
      // exhausted accounts on exactly that (C57b).
      const balance = await deps.chargebee.balance(account.chargebeeSubscriptionId, account.ledgerUnitId);
      if (balance?.usable == null) return null;
      // A declined top-up's credits are in Chargebee's balance but not paid for.
      if (!deps.topUpItemPriceId || !account.chargebeeCustomerId) return balance.usable;
      const unpaid = await deps.chargebee.unpaidTopUpCredits({
        customerId: account.chargebeeCustomerId,
        subscriptionId: account.chargebeeSubscriptionId,
        unitId: account.ledgerUnitId ?? undefined,
        itemPriceId: deps.topUpItemPriceId,
      });
      return subtractFloorZero(balance.usable, unpaid);
    } catch (err) {
      log.warn?.(
        { metric: "billing.balance.unreadable", tenantId, err: errorMessage(err) },
        "Could not read the Chargebee balance; treating the account as not exhausted",
      );
      return null;
    }
  }

  /**
   * Retry every account held in `activating`. The worker runs this each minute;
   * with nothing held it is one indexed query and no gateway call.
   */
  async function activatePending() {
    if (!deps.pushBudget) return { pending: 0, activated: 0 };

    const held = await accounts.listActivatingTenantIds();

    let activated = 0;
    for (const tenantId of held) {
      const account = await activate(tenantId);
      if (account.status === ACCOUNT.ACTIVE) activated += 1;
    }

    if (activated > 0) {
      log.log?.({ metric: "billing.budget.activated", activated, pending: held.length }, "Held accounts activated");
    }
    return { pending: held.length, activated };
  }

  /**
   * Re-open every ACTIVE account whose LiteLLM team BILLING blocked. The
   * worker runs this each minute, after the usage sync.
   *
   * `active` with the team blocked is never right — an exhausted account reads
   * `exhausted`, a held one `activating` — but two writers that race can leave
   * it: the webhook's activation and the post-checkout pull both run after
   * every checkout, and when one's push fails, its block can land after the
   * other has opened the team and marked the account active. A top-up's
   * activation can cross a refused capture's block the same way. Nothing else
   * looks at an active account again, so the paying customer was refused every
   * call until the daily resync.
   *
   * Only a block billing made (its reason is on the team) is reopened; a team
   * someone blocked by hand in LiteLLM is left as it is.
   *
   * One team read per active account, in sequence, so it is bounded by
   * `deadline` (epoch ms on this service's clock): a hung LiteLLM costs the
   * sweep that long and no more, and the accounts not reached are checked next
   * minute. activate() re-checks Chargebee before opening anything, so an
   * account that really has run out becomes `exhausted` here rather than
   * reopened.
   */
  async function reopenBlockedActive({ deadline }: { deadline?: number } = {}) {
    if (!deps.pushBudget || !deps.budgetBlocked) return { checked: 0, reopened: 0 };

    const active = await accounts.listActiveTenantIds();
    let checked = 0;
    let reopened = 0;
    for (const tenantId of active) {
      if (deadline != null && clock() >= deadline) {
        log.warn?.(
          { metric: "billing.budget.gate_check_deadline", checked, remaining: active.length - checked },
          "Gate check ran out of time; the remaining active accounts are checked next minute",
        );
        break;
      }
      checked += 1;
      try {
        if (!(await deps.budgetBlocked(tenantId))) continue;
        log.warn?.(
          { metric: "billing.budget.active_but_blocked", tenantId },
          "Account is active but its LiteLLM team is blocked; re-applying the budget",
        );
        const account = await activate(tenantId);
        if (account.status === ACCOUNT.ACTIVE) reopened += 1;
      } catch (err) {
        log.error?.(
          { metric: "billing.budget.gate_check_failed", tenantId, err: errorMessage(err) },
          "Could not check the LiteLLM team of an active account; the next minute tries again",
        );
      }
    }
    return { checked, reopened };
  }

  /**
   * Renewal. Identical to linking the subscription, because the only thing that
   * changes is what Chargebee's grant blocks say.
   *
   * It used to expire the old term's leftover in a local ledger, so that "unused
   * credits do not carry over" held. That expiry is Chargebee's: it marks the
   * old block expired at the term boundary, and `grantedCredits()` excludes
   * blocks that are no longer live. The LiteLLM baseline moves up to the
   * team's spend when the term does (gateway-budget.service.ts), so the new
   * headroom is the new term's credits and nothing else — neither last term's
   * leftover nor last term's spend. Kept as its own name because a renewal is
   * worth seeing in the logs.
   */
  async function renew(args: {
    tenantId: string;
    subscriptionId: string;
    itemPriceId?: string | null;
    termStart?: Date | null;
    termEnd?: Date | null;
  }) {
    log.log?.(
      { metric: "billing.subscription.renewed", tenantId: args.tenantId, termStart: args.termStart?.toISOString() },
      "Subscription renewed; re-reading grant blocks and resetting the gateway cap",
    );
    return syncSubscription({ ...args, status: ACCOUNT.ACTIVE });
  }

  /**
   * The subscription ended: stop billing and hand the team back to its plan.
   *
   * Idempotent, and meant to be run again: the status write is a no-op the
   * second time and release() does nothing to a team that is not
   * billing-managed. A FAILED RELEASE THROWS, after the status is written.
   * Swallowing it left the team on its prepaid cap for ever — billing_managed
   * keeps the platform's reconciler off it, and nothing retried — and every
   * call it then served was never billed (the account is cancelled). Thrown,
   * the webhook answers 500 and Chargebee redelivers it; the daily resync
   * re-runs this for every account whose subscription has ended.
   */
  async function cancel(tenantId: string) {
    const account = await accounts.setStatus(tenantId, ACCOUNT.CANCELLED);

    // Without this the team keeps the prepaid cap and the platform keeps its
    // hands off it — forever, since no further grant will come to move it.
    if (deps.releaseBudget) {
      try {
        await deps.releaseBudget(tenantId);
      } catch (err) {
        log.error?.(
          { metric: "billing.budget.release_failed", tenantId, err: errorMessage(err) },
          "Could not hand the gateway budget back to the plan; the team keeps its prepaid cap until a retry lands",
        );
        throw err;
      }
    }

    return account;
  }

  /**
   * Pull current subscription state from Chargebee and apply it.
   *
   * THE way subscription state changes here. Every subscription webhook is
   * only a trigger for this (webhook.service.ts), and it is also called right
   * after a successful checkout so the customer sees their credits immediately,
   * by the daily reconcile sweep, and safe to call at any time as a repair.
   * Because it applies what Chargebee says NOW, an event delivered late, twice
   * or out of order converges on the same state instead of rewinding it.
   *
   * A rolled-over term goes through renew() only so the log says so; both paths
   * now do the same thing, which is to re-read Chargebee and apply it whole.
   * When no subscription is active and the linked one has ENDED, the account
   * is cancelled — the pull path for a cancellation whose webhook never came.
   */
  async function syncFromChargebee(tenantId: string) {
    const account = await accounts.findByTenantId(tenantId);
    if (!account?.chargebeeCustomerId) return null;

    const subscriptions = await deps.chargebee.activeSubscriptions(account.chargebeeCustomerId);

    // §15: the BUSINESS layer decides which subscription receives usage, not an
    // array index and not the database. See models/subscription.ts for the rules.
    const choice = chooseBillingSubscription(subscriptions, {
      currentId: account.chargebeeSubscriptionId,
      billingItemPriceIds: deps.billingItemPriceIds ?? [],
    });
    const subscription = choice.subscription;
    if (!subscription) return cancelIfEnded(account);

    if (choice.alternatives > 0) {
      // Rare, and therefore rarely noticed when it goes wrong: a customer with
      // two active subscriptions has one of them collecting all the usage, and
      // which one must be visible somewhere other than this function.
      log.warn?.(
        {
          metric: "billing.subscription.multiple_active",
          tenantId,
          chosen: subscription.id,
          reason: choice.reason,
          alternatives: choice.alternatives,
        },
        "Customer has more than one active subscription; usage is billed to the one named here",
      );
    }

    const termStart = subscription.current_term_start
      ? new Date(subscription.current_term_start * 1000)
      : null;

    const args = {
      tenantId,
      subscriptionId: subscription.id,
      itemPriceId: itemPriceIdOf(subscription),
      termStart,
      termEnd: subscription.current_term_end ? new Date(subscription.current_term_end * 1000) : null,
    };

    // Strictly forward: a term start that matches, or somehow predates, what we
    // hold is not a renewal.
    const rolledOver =
      termStart != null &&
      account.currentTermStart != null &&
      termStart.getTime() > account.currentTermStart.getTime();

    return rolledOver ? renew(args) : syncSubscription(args);
  }

  /**
   * No subscription is active. Cancel the account only if the one it is linked
   * to has definitely ENDED — Chargebee returns it as `cancelled`, or it is
   * gone from a site where the customer still exists.
   *
   * Anything else leaves it alone: an account never linked has nothing to end,
   * and a `paused` or `future` subscription is not a cancellation. Chargebee's
   * list asks only for active, in-trial and non-renewing subscriptions, so the
   * linked one is read by id to tell those apart. Re-run on an account that is
   * already cancelled, it retries a release that failed (see cancel()).
   *
   * "Not found" is NOT taken as "ended" on its own. A wrong CHARGEBEE_SITE, or
   * a key for another site, lists no active subscriptions and answers 404 for
   * every id — and taking that at its word cancelled and released every linked
   * account in one daily resync, and the relink restarted each cursor at the
   * relink, so nothing used in between was ever billed. A 404 counts as a
   * deleted subscription only once the customer itself is found on the site;
   * otherwise it is logged and nothing changes.
   */
  async function cancelIfEnded(account: {
    tenantId: string;
    chargebeeCustomerId: string | null;
    chargebeeSubscriptionId: string | null;
  }) {
    if (!account.chargebeeSubscriptionId) return null;
    const linked = await deps.chargebee.subscription(account.chargebeeSubscriptionId);
    if (linked) return linked.status === "cancelled" ? cancel(account.tenantId) : null;

    const customer = account.chargebeeCustomerId ? await deps.chargebee.customer(account.chargebeeCustomerId) : null;
    if (!customer) {
      log.error?.(
        {
          metric: "billing.subscription.gone",
          tenantId: account.tenantId,
          subscriptionId: account.chargebeeSubscriptionId,
          customerId: account.chargebeeCustomerId,
        },
        "Chargebee knows neither the linked subscription nor its customer; check CHARGEBEE_SITE and the API key. The account is left as it is",
      );
      return null;
    }
    return cancel(account.tenantId);
  }

  /**
   * Re-read every customer's subscriptions from Chargebee — the daily repair
   * for a webhook that never arrived.
   *
   * EVERY customer, not only linked ones: a customer whose subscription_created
   * was lost and whose one post-checkout pull never ran (the tab was closed)
   * has paid and was never linked, and nothing else would ever find them. A
   * Chargebee customer exists only once checkout has started, so the extra
   * reads are bounded by checkouts, not by tenants.
   *
   * Idempotent end to end: each tenant is `syncFromChargebee`, which applies
   * what Chargebee says, so a subscription the webhook already handled
   * converges on the same state. One unreachable subscription must not stop
   * the sweep, so each tenant's failure is caught, logged and counted.
   */
  async function resyncAll() {
    const tenantIds = await accounts.listCustomerTenantIds();

    let repaired = 0;
    const errors: Array<{ tenantId: string; error: string }> = [];

    for (const tenantId of tenantIds) {
      try {
        if (await syncFromChargebee(tenantId)) repaired += 1;
      } catch (err) {
        errors.push({ tenantId, error: errorMessage(err) });
        log.error?.(
          { metric: "billing.subscription_reconcile.tenant_error", tenantId, err: errorMessage(err) },
          "Could not re-read subscription from Chargebee; other tenants continue",
        );
      }
    }

    return { scanned: tenantIds.length, repaired, errors };
  }

  /**
   * Grant top-up credits for every PAID pack invoice not yet applied — each
   * exactly once.
   *
   * Payment first, credits second — and the proof of payment is the invoice, so
   * we never hand out credits for an abandoned checkout.
   *
   * THE GUARD IS A LOCAL RECORD, `topup_grant` (C57a). It used to be a scan of
   * the subscription's ledger for an allocation carrying `metadata.invoice_id`,
   * but Chargebee never returns that metadata — MEASURED, list and retrieve —
   * so the scan matched nothing and only the 30-minute idempotency key stood
   * between a repeated `apply` and a second grant. Now, per invoice:
   *
   *   APPLIED row          granted; nothing is sent, nothing is read. A repeat
   *                        `apply` answers {applied: 0} from the database alone.
   *   Chargebee granted it the pack's item price carries its OWN Credit Grant,
   *                        and a grant block names this invoice's pack line:
   *                        recorded as a catalogue grant, and NOTHING is
   *                        allocated — that would be a second grant (C57d).
   *   no row               CLAIMED (SENDING, with the whole request) and
   *                        committed, then allocated, then APPLIED with the
   *                        operation id.
   *   SENDING, in lease    another caller is sending it; left alone.
   *   PENDING / expired    the allocate may have landed. Within Chargebee's
   *   SENDING              replay window it is re-sent EXACTLY — same key, same
   *                        body — and Chargebee answers with the original grant
   *                        if there was one. Past the window the key is dead,
   *                        so the subscription's grant blocks are searched for
   *                        the allocation first: found → APPLIED; the list cut
   *                        short, or a block we cannot attribute → held, and
   *                        logged for a person; certainly absent → sent again
   *                        under a new key (with a freshly computed
   *                        `expires_at`) — but ONLY from PENDING. A row still
   *                        SENDING past the window may belong to a sender that
   *                        paused rather than crashed, and would send the old
   *                        key after we sent a new one: held for a person.
   *
   * A crash at any point leaves a row, so a paid invoice can be delayed by a
   * crash but never granted twice and never forgotten. An allocate whose
   * outcome is unknown (a timeout, a 5xx) fails the request at once, as before
   * — the customer retries, and the retry completes the same row. One Chargebee
   * REFUSED (a definite 4xx) fails it too, but only after the packs behind it
   * have been applied: one bad invoice must not hold up every later one. It
   * stays PENDING and is tried again on every apply, so it completes by itself
   * once the cause is fixed.
   *
   * `chargebeeGrants`: the pack's charge carries its own Credit Grant, so
   * Chargebee grants every paid pack and billing only records it. An invoice
   * whose grant block is not visible yet is NOT allocated — Chargebee issues
   * the block about a second after payment, and allocating in that second
   * would be a second grant. It is left with no row and returned in
   * `pending`, so the next apply looks again.
   */
  async function applyPaidTopUps(
    tenantId: string,
    itemPriceId: string,
    creditsPerUnit: string,
    { chargebeeGrants = false }: { chargebeeGrants?: boolean } = {},
  ): Promise<{ applied: number; credits: string; pending?: string[] }> {
    const NONE = { applied: 0, credits: "0" };
    const account = await accounts.findByTenantId(tenantId);
    if (!account?.chargebeeCustomerId || !account.chargebeeSubscriptionId || !account.ledgerUnitId) return NONE;
    const customerId = account.chargebeeCustomerId;
    const linked = { subscriptionId: account.chargebeeSubscriptionId, unitId: account.ledgerUnitId };

    const invoices = (await deps.chargebee.paidInvoicesFor(customerId, itemPriceId)).sort(
      (a, b) => Number(a.paid_at ?? a.date ?? 0) - Number(b.paid_at ?? b.date ?? 0),
    );
    if (invoices.length === 0) return NONE;

    const records = await topUps.forInvoices(tenantId, invoices.map((invoice) => String(invoice.id)));
    const owed = invoices.filter((invoice) => records.get(String(invoice.id))?.status !== TOPUP.APPLIED);
    if (owed.length === 0) return NONE;

    // What Chargebee holds: every grant block on every subscription the
    // customer has had — a pack granted by its own Credit Grant lands on the
    // subscription it was charged to, which after a resubscription is no
    // longer the linked one. Read once; nothing below appends to it that a
    // later invoice in this loop needs to see.
    const ledger = new Map<string, { blocks: GrantBlock[]; complete: boolean }>();
    for (const subscriptionId of new Set([linked.subscriptionId, ...(await deps.chargebee.subscriptionIdsOf(customerId))])) {
      ledger.set(subscriptionId, await deps.chargebee.grantBlocks(subscriptionId));
    }

    let applied = 0;
    let credits = "0";
    const pending: string[] = [];
    let refused: unknown = null;
    try {
      for (let i = 0; i < owed.length; i += 1) {
        const invoice = owed[i]!;
        // A cancelled account keeps its subscription id, but there is nothing
        // live to add credits to: the usage sync no longer bills it, so credits
        // allocated here would sit on an ended subscription. Checkout refuses
        // before payment (checkout.service.ts); this refuses to grant — checked
        // before EVERY invoice, because a cancellation can land mid-loop. A
        // pack that was paid for anyway is money taken for nothing, so it is
        // an error with the invoices named, for a refund (or for allocating by
        // hand if the customer subscribes again).
        const now = await accounts.findByTenantId(tenantId);
        if (now?.status === ACCOUNT.CANCELLED) {
          log.error?.(
            {
              metric: "billing.topup.refused_cancelled",
              tenantId,
              invoiceIds: owed.slice(i).map((inv) => String(inv.id)),
              creditsPerUnit,
            },
            "Paid top-up not applied: the subscription has ended. Refund these invoices, or allocate them by hand",
          );
          break;
        }

        const record = records.get(String(invoice.id));
        let granted: { credits: string } | null | typeof GRANT_NOT_VISIBLE;
        try {
          granted = record
            ? await resumeTopUp(record, ledger)
            : await firstTopUp(tenantId, invoice, itemPriceId, creditsPerUnit, linked, account.currentTermEnd, ledger, chargebeeGrants);
        } catch (err) {
          // Unknown outcome — a timeout, a 5xx, Chargebee unreachable: stop
          // here, the rest would meet the same. A definite refusal of THIS
          // pack's request: Chargebee is answering, so the packs behind it
          // are still applied, and this one fails the request at the end.
          if (!isDefiniteRefusal(err as ChargebeeError)) throw err;
          refused ??= err;
          log.error?.(
            { metric: "billing.topup.allocate_refused", tenantId, invoiceId: String(invoice.id), err: errorMessage(err) },
            "Chargebee refused this paid top-up's allocate. The packs after it are still applied; this one is tried again on every apply, and needs a person if the cause is not transient",
          );
          continue;
        }
        if (granted === GRANT_NOT_VISIBLE) {
          pending.push(String(invoice.id));
        } else if (granted) {
          applied += 1;
          credits = add(credits, granted.credits);
        }
      }
      if (refused) throw refused;
    } finally {
      // Also when an allocate failed part-way: packs already granted in this
      // call must still reach the gateway ceiling.
      if (applied > 0) await afterTopUp(tenantId, linked.subscriptionId, applied, credits);
    }

    return { applied, credits, ...(pending.length > 0 ? { pending } : {}) };
  }

  /** An invoice with no row yet: Chargebee's own grant, or claim → allocate → APPLIED. */
  async function firstTopUp(
    tenantId: string,
    invoice: Record<string, any>,
    itemPriceId: string,
    creditsPerUnit: string,
    linked: { subscriptionId: string; unitId: string },
    termEnd: Date | null,
    ledger: Map<string, { blocks: GrantBlock[]; complete: boolean }>,
    chargebeeGrants: boolean,
  ): Promise<{ credits: string } | null | typeof GRANT_NOT_VISIBLE> {
    const invoiceId = String(invoice.id);

    const catalogue = catalogueGrantFor(invoice, itemPriceId, ledger);
    if (catalogue.length > 0) return recordCatalogueGrant(tenantId, invoiceId, linked.unitId, catalogue);

    // Chargebee grants this pack itself. No block naming it yet means not yet,
    // never "allocate instead": that would be a second grant once Chargebee's
    // lands. No row is written, so the next apply looks again.
    if (chargebeeGrants) {
      log.warn?.(
        { metric: "billing.topup.grant_not_visible", tenantId, invoiceId, itemPriceId },
        "Paid top-up has no Chargebee grant block yet; nothing allocated, looked for again on the next apply",
      );
      return GRANT_NOT_VISIBLE;
    }

    // What was PAID FOR, read off the invoice — never the quantity the request
    // that opened the checkout asked for. Decided once, here, and stored on the
    // claim below: every retry re-sends the stored amount.
    const units = topUpUnits(invoice, itemPriceId);
    if (units === null) {
      log.error?.(
        { metric: "billing.topup.quantity_unreadable", tenantId, invoiceId, itemPriceId },
        "Paid top-up not applied: its invoice line carries no whole-number quantity. Nothing sent; grant it by hand",
      );
      return null;
    }

    const expiresAt = await topUpExpiry(tenantId, invoiceId, linked.subscriptionId, termEnd);
    const claimed = await topUps.claim({
      tenantId,
      invoiceId,
      chargebeeSubscriptionId: linked.subscriptionId,
      ledgerUnitId: linked.unitId,
      credits: multiply(creditsPerUnit, units),
      // Stored, and re-sent from here on every retry under this key: a replay
      // under the same key must be the same request, and `expires_at` from
      // the clock is not.
      expiresAt,
      idempotencyKey: `invoice:${invoiceId}`,
      at: new Date(clock()),
    });
    if (!claimed) {
      // Another caller claimed it between our read and our insert; it is theirs.
      const current = await topUps.findByInvoice(tenantId, invoiceId);
      return current && current.status !== TOPUP.APPLIED ? resumeTopUp(current, ledger) : null;
    }
    return sendTopUp(claimed, { id: claimed.id, attemptCount: claimed.attemptCount });
  }

  /**
   * The `expires_at` a top-up is stored and sent with: the end of the current
   * term, so pack credits reset with the plan's — but never one that is not
   * safely in the future (TOPUP_MIN_EXPIRY_LEAD_MS).
   *
   * The term end mirrored on the account can be stale: a renewal webhook that
   * never arrived, and the daily resync not yet run. Sent as it was, Chargebee
   * either refused the allocate — every apply after it failing on the same row
   * — or granted a block that had already expired: paid for, never spendable.
   * So a term end that is missing or too close is re-read from Chargebee, and
   * if Chargebee's is no better, the pack gets 30 days. Said out loud either
   * way. Computed once per idempotency key: a key's request never changes.
   */
  async function topUpExpiry(tenantId: string, invoiceId: string, subscriptionId: string, termEnd: Date | null): Promise<Date> {
    const now = clock();
    const safe = (ms: number | null): ms is number => ms != null && ms > now + TOPUP_MIN_EXPIRY_LEAD_MS;
    const toSecond = (ms: number) => new Date(Math.floor(ms / 1000) * 1000);
    if (termEnd && safe(termEnd.getTime())) return toSecond(termEnd.getTime());

    const subscription = await deps.chargebee.subscription(subscriptionId);
    const liveEnd = typeof subscription?.current_term_end === "number" ? subscription.current_term_end * 1000 : null;
    const chosen = safe(liveEnd) ? liveEnd : now + TOPUP_FALLBACK_EXPIRY_MS;
    log.warn?.(
      {
        metric: "billing.topup.expiry_adjusted",
        tenantId,
        invoiceId,
        subscriptionId,
        storedTermEnd: termEnd?.toISOString() ?? null,
        chargebeeTermEnd: liveEnd == null ? null : new Date(liveEnd).toISOString(),
        expiresAt: new Date(chosen).toISOString(),
      },
      safe(liveEnd)
        ? "The account's term end was missing or stale; the top-up expires at the term end Chargebee reports"
        : "Neither the account nor Chargebee gave a term end safely in the future; the top-up expires in 30 days",
    );
    return toSecond(chosen);
  }

  /** A row that is not APPLIED: someone else's send, a replay, or a search for the allocation. */
  async function resumeTopUp(
    record: TopUpGrant,
    ledger: Map<string, { blocks: GrantBlock[]; complete: boolean }>,
  ): Promise<{ credits: string } | null> {
    if (record.status === TOPUP.APPLIED || record.source !== TOPUP_SOURCE.ALLOCATION) return null;
    const now = clock();

    if (record.status === TOPUP.SENDING && now < record.updatedAt.getTime() + TOPUP_CLAIM_LEASE_MS) {
      log.warn?.(
        { metric: "billing.topup.in_progress", tenantId: record.tenantId, invoiceId: record.invoiceId, attempts: record.attemptCount },
        "Another caller is allocating this top-up right now; leaving it to them",
      );
      return null;
    }

    // Chargebee still replays this key: the SAME request is safe whether or
    // not the first one landed — it answers with the original grant if it did.
    if (record.keyIssuedAt && now < record.keyIssuedAt.getTime() + TOPUP_KEY_REPLAY_MS) {
      const attempt = await topUps.takeAttempt(record, new Date(now));
      return attempt ? sendTopUp(record, attempt) : null;
    }

    // The key is dead: re-sending it would be a new grant. Look first.
    const found = await findAllocation(record, ledger);
    if (found.kind === "found") {
      const operationAt = found.block.createdAtMs == null ? null : new Date(found.block.createdAtMs);
      if (!(await topUps.markAppliedFromEvidence(record, `grant_block:${found.block.id}`, new Date(now), operationAt))) return null;
      log.warn?.(
        {
          metric: "billing.topup.resolved_from_ledger",
          tenantId: record.tenantId,
          invoiceId: record.invoiceId,
          grantBlockId: found.block.id,
          credits: record.credits,
        },
        "A top-up whose answer was lost had in fact been granted; recorded from its grant block, nothing sent",
      );
      return { credits: record.credits };
    }
    if (found.kind === "unknown" || record.status !== TOPUP.PENDING) {
      // Unknown: the block list was cut short, or another row's grant could
      // not be placed — absence proves nothing. Still SENDING: the sender may
      // have PAUSED (a GC stall, a suspended laptop, a frozen container)
      // rather than crashed, between its claim and its send. A new key now
      // would be a second grant the moment it wakes and sends the old one,
      // which Chargebee no longer de-duplicates. Only a PENDING row — whose
      // sender recorded its own failure and will not send again — is re-sent.
      const reason = found.kind === "unknown" ? found.reason : "still_sending_past_key_window";
      log.error?.(
        {
          metric: "billing.topup.unresolved",
          tenantId: record.tenantId,
          invoiceId: record.invoiceId,
          reason,
          status: record.status,
          subscriptionId: record.chargebeeSubscriptionId,
          unitId: record.ledgerUnitId,
          credits: record.credits,
          claimedAt: record.createdAt.toISOString(),
        },
        reason === "still_sending_past_key_window"
          ? "A top-up claim was never completed and its idempotency key has expired; nothing sent. Once no process can still be sending it and its grant is not among the subscription's grant blocks, set the topup_grant row to PENDING and the next apply sends it"
          : "Cannot tell whether this paid top-up was granted; nothing sent. Check the subscription's grant blocks and mark the topup_grant row",
      );
      return null;
    }

    // Certainly never landed, and nobody holds it: send it again under a new
    // key. A new key may carry a new body, so `expires_at` is computed afresh
    // — the one first stored may have gone stale while the row waited.
    const account = await accounts.findByTenantId(record.tenantId);
    const termEnd = account?.chargebeeSubscriptionId === record.chargebeeSubscriptionId ? account.currentTermEnd : null;
    const expiresAt = await topUpExpiry(record.tenantId, record.invoiceId, record.chargebeeSubscriptionId, termEnd);
    const idempotencyKey = `invoice:${record.invoiceId}:${record.attemptCount + 1}`;
    const attempt = await topUps.takeAttempt(record, new Date(now), { idempotencyKey, expiresAt });
    return attempt ? sendTopUp(record, attempt) : null;
  }

  /**
   * The allocate, under the attempt — exactly the request the row stores.
   *
   * The row is read again first, and nothing is sent unless it is still ours
   * (SENDING, under this attempt) and its key is still inside Chargebee's
   * replay window. A sender held up between its claim and here for longer
   * than that window must not send: Chargebee would no longer recognise the
   * key, and an earlier attempt under it may have landed. It marks the row
   * PENDING instead, and the next apply searches before it sends. What is
   * left is the moment between this read and the request leaving.
   */
  async function sendTopUp(record: TopUpGrant, attempt: TopUpAttempt): Promise<{ credits: string } | null> {
    const current = await topUps.findByInvoice(record.tenantId, record.invoiceId);
    if (!current || current.status !== TOPUP.SENDING || current.attemptCount !== attempt.attemptCount) {
      log.warn?.(
        { metric: "billing.topup.claim_lost", tenantId: record.tenantId, invoiceId: record.invoiceId, attempts: attempt.attemptCount },
        "Another caller took this top-up over before our allocate left; nothing sent",
      );
      return null;
    }
    if (!current.keyIssuedAt || !current.expiresAt || !current.idempotencyKey || clock() >= current.keyIssuedAt.getTime() + TOPUP_KEY_REPLAY_MS) {
      await topUps.markUnresolved(attempt, "not sent: held past the idempotency key's replay window", new Date(clock()));
      log.error?.(
        { metric: "billing.topup.send_too_late", tenantId: record.tenantId, invoiceId: record.invoiceId, attempts: attempt.attemptCount },
        "A top-up claim reached its send after its idempotency key had expired; nothing sent. The next apply looks for the grant before sending",
      );
      return null;
    }

    let operationId: string;
    let operationAt: Date | null;
    try {
      const result = await deps.chargebee.allocate({
        subscriptionId: current.chargebeeSubscriptionId,
        unitId: current.ledgerUnitId,
        amount: current.credits,
        expiresAt: Math.floor(current.expiresAt.getTime() / 1000),
        idempotencyKey: current.idempotencyKey,
        metadata: { invoice_id: current.invoiceId, tenant_id: current.tenantId },
      });
      operationId = result.operationId;
      operationAt = result.createdAtMs == null ? null : new Date(result.createdAtMs);
    } catch (err) {
      // It may have landed. The row stays, PENDING, and the next apply
      // re-sends the same request under the same key.
      await topUps.markUnresolved(attempt, errorMessage(err), new Date(clock()));
      log.error?.(
        {
          metric: "billing.topup.allocate_failed",
          tenantId: record.tenantId,
          invoiceId: record.invoiceId,
          attempts: attempt.attemptCount,
          err: errorMessage(err),
        },
        "Top-up allocation failed or its answer was lost; the next apply completes it without granting twice",
      );
      throw err;
    }

    if (!(await topUps.markApplied(attempt, `ledger_operation:${operationId}`, new Date(clock()), operationAt))) {
      log.warn?.(
        { metric: "billing.topup.claim_lost", tenantId: record.tenantId, invoiceId: record.invoiceId, operationId },
        "Another caller took this top-up over while our allocate was out; it records the grant",
      );
      return null;
    }
    return { credits: current.credits };
  }

  /**
   * Did an allocation for this row land? Read from the grant blocks, because
   * the operation's own metadata is never returned.
   *
   * A candidate is a block `allocate` made (no invoice, no item price, not
   * made by a person) on the row's subscription and unit, for exactly its
   * credits, created while the row was being sent.
   *
   * Blocks other rows own are taken out FIRST, each one exactly:
   *   - a row resolved from the blocks names its block (`grant_block:<id>`);
   *   - a row granted by operation id owns the block made the same second as
   *     its operation (`operation_at`, or read back by id when not stored).
   * It used to be done by count — one candidate less for every row whose send
   * merely OVERLAPPED this one's — and a row applied by a late replay
   * overlaps for a long time while its block sits well before this range:
   * this row's own block was cancelled out and the pack granted again.
   *
   * "unknown" when the list was cut short, or another row's grant cannot be
   * placed: absence then proves nothing, and nothing is sent.
   */
  async function findAllocation(
    record: TopUpGrant,
    ledger: Map<string, { blocks: GrantBlock[]; complete: boolean }>,
  ): Promise<{ kind: "found"; block: GrantBlock } | { kind: "absent" } | { kind: "unknown"; reason: string }> {
    const listed = ledger.get(record.chargebeeSubscriptionId) ?? (await deps.chargebee.grantBlocks(record.chargebeeSubscriptionId));
    if (!listed.complete) return { kind: "unknown", reason: "grant_blocks_incomplete" };

    const from = record.createdAt.getTime() - TOPUP_EVIDENCE_SKEW_MS;
    const to = record.updatedAt.getTime() + TOPUP_EVIDENCE_SKEW_MS;
    const others = (await topUps.appliedAllocations(record.tenantId, record.chargebeeSubscriptionId, record.ledgerUnitId)).filter(
      (other) => other.id !== record.id && compare(other.credits, record.credits) === 0,
    );

    // Every block that could be an allocation of this size into this unit.
    const pool = listed.blocks.filter(
      (b) =>
        isAllocationBlock(b) &&
        b.unitId === record.ledgerUnitId &&
        compare(b.grantedAmount, record.credits) === 0 &&
        b.createdAtMs != null,
    );
    const owned = new Set(
      others.map((o) => o.chargebeeRef ?? "").filter((ref) => ref.startsWith("grant_block:")).map((ref) => ref.slice(12)),
    );
    for (const other of others) {
      if ((other.chargebeeRef ?? "").startsWith("grant_block:")) continue;
      // An operation lands between its row's claim and its APPLIED, so a row
      // whose span misses this range cannot own a block inside it.
      const spanEnd = (other.appliedAt ?? other.updatedAt).getTime();
      if (other.createdAt.getTime() > to + TOPUP_OPERATION_BLOCK_MS || spanEnd < from - TOPUP_OPERATION_BLOCK_MS) continue;

      const at = await operationTime(other);
      if (at == null) return { kind: "unknown", reason: "other_grant_unplaced" };
      const own = pool
        .filter((b) => !owned.has(b.id) && Math.abs(b.createdAtMs! - at) <= TOPUP_OPERATION_BLOCK_MS)
        .sort((a, b) => Math.abs(a.createdAtMs! - at) - Math.abs(b.createdAtMs! - at))[0];
      if (own) owned.add(own.id);
    }

    const candidate = pool.find((b) => !owned.has(b.id) && b.createdAtMs! >= from && b.createdAtMs! <= to);
    return candidate ? { kind: "found", block: candidate } : { kind: "absent" };
  }

  /**
   * When another row's allocation was made: stored with it, or — for a row
   * applied before that was recorded — read back from Chargebee by operation
   * id, and stored. Null when Chargebee cannot say.
   */
  async function operationTime(row: TopUpGrant): Promise<number | null> {
    if (row.operationAt) return row.operationAt.getTime();
    const ref = row.chargebeeRef ?? "";
    if (!ref.startsWith("ledger_operation:")) return null;
    const op = await deps.chargebee.ledgerOperation(ref.slice("ledger_operation:".length));
    if (!op || op.createdAtMs == null) return null;
    await topUps.recordOperationAt(row.id, new Date(op.createdAtMs));
    return op.createdAtMs;
  }

  /** Chargebee granted this pack itself. Record it; allocate nothing. */
  async function recordCatalogueGrant(
    tenantId: string,
    invoiceId: string,
    accountUnitId: string,
    blocks: GrantBlock[],
  ): Promise<{ credits: string } | null> {
    const credits = add("0", ...blocks.map((b) => b.grantedAmount));
    const recorded = await topUps.recordCatalogueGrant({
      tenantId,
      invoiceId,
      chargebeeSubscriptionId: blocks[0]!.subscriptionId,
      ledgerUnitId: blocks[0]!.unitId,
      credits,
      grantBlockId: blocks[0]!.id,
      at: new Date(clock()),
    });
    if (!recorded) return null;

    const wrongUnit = blocks.filter((b) => b.unitId !== accountUnitId);
    if (wrongUnit.length > 0) {
      // The credits exist, in a unit the usage sync never draws from and the
      // gateway cap never counts. Allocating into the right unit as well would
      // be a second grant for one payment, so nothing is done here but say so.
      log.error?.(
        {
          metric: "billing.topup.catalogue_grant_wrong_unit",
          tenantId,
          invoiceId,
          grantBlockIds: blocks.map((b) => b.id),
          grantedUnits: [...new Set(blocks.map((b) => b.unitId))],
          accountUnit: accountUnitId,
          credits,
        },
        "The top-up's item price carries its own Chargebee Credit Grant, into a unit billing does not use. Nothing allocated (it would be a second grant). Remove the grant from the pack in the Chargebee catalogue; move these credits by hand",
      );
      return null;
    }
    log.warn?.(
      { metric: "billing.topup.catalogue_grant", tenantId, invoiceId, grantBlockIds: blocks.map((b) => b.id), credits },
      "Chargebee granted this top-up itself (its item price carries a Credit Grant); recorded, nothing allocated",
    );
    return { credits };
  }

  /** The gateway ceiling has to move too, or the customer has credits they cannot spend. */
  async function afterTopUp(tenantId: string, subscriptionId: string, applied: number, credits: string) {
    log.log?.({ metric: "billing.topup.applied", tenantId, invoices: applied, credits }, "Top-up credits allocated in Chargebee");
    // New credits also end an `exhausted` state — activate() confirms against
    // Chargebee first, and does nothing to an account a cancellation reached
    // in the meantime.
    const after = await activate(tenantId, ACCOUNT.ACTIVE);
    if (after.status === ACCOUNT.CANCELLED) {
      log.error?.(
        { metric: "billing.topup.allocated_to_cancelled", tenantId, subscriptionId, credits },
        "The subscription ended while a paid top-up was being allocated; the credits are on the ended subscription",
      );
    }
  }

  return {
    activatePending,
    reopenBlockedActive,
    ensureCustomer,
    ensureLocalAccount,
    ensureBillingCursor,
    bootstrapFromTenant,
    syncSubscription,
    syncFromChargebee,
    resyncAll,
    applyPaidTopUps,
    renew,
    cancel,
  };
}

export type AccountService = ReturnType<typeof createAccountService>;

/** A paid pack whose Chargebee grant block has not appeared yet (applyPaidTopUps `chargebeeGrants`). */
const GRANT_NOT_VISIBLE = Symbol("grant-not-visible");

/**
 * The grant blocks Chargebee issued for THIS invoice's pack line — the pack's
 * item price carries its own Credit Grant (C57d).
 *
 * Matched on the pack's LINE ITEM id, not the invoice number alone: one
 * invoice can carry a plan line too, and the plan's grant block names the same
 * invoice. The invoice number is used only when the block names no line item,
 * and then only for a block issued by this pack's item price.
 */
export function catalogueGrantFor(
  invoice: Record<string, any>,
  itemPriceId: string,
  ledger: Map<string, { blocks: GrantBlock[] }>,
): GrantBlock[] {
  const invoiceId = String(invoice.id);
  const packLines = new Set(
    ((invoice.line_items ?? []) as Array<Record<string, any>>)
      .filter((li) => li?.entity_id === itemPriceId && li.id != null)
      .map((li) => String(li.id)),
  );
  const found: GrantBlock[] = [];
  for (const { blocks } of ledger.values()) {
    for (const block of blocks) {
      const names = block.invoices.some((ref) =>
        ref.lineItemId != null ? packLines.has(ref.lineItemId) : ref.invoiceId === invoiceId && block.itemPriceId === itemPriceId,
      );
      if (names) found.push(block);
    }
  }
  return found;
}

/**
 * A block made by `/ledger_operations/allocate`: no invoice, no item price, and
 * not made by a person (a grant by hand records the person's email as
 * `done_by`; an allocation records the API key's name).
 */
function isAllocationBlock(block: GrantBlock): boolean {
  return block.invoices.length === 0 && block.itemPriceId == null && !(block.doneBy ?? "").includes("@");
}

/**
 * Units of the top-up charge a paid invoice bought: the sum of its lines for
 * that item price.
 *
 * A line with no `quantity` is one unit — every top-up was, before the
 * customer could choose. One that carries a quantity that is not a positive
 * whole number is not guessed at: null, so the invoice is held for a person
 * rather than granted a made-up amount.
 */
export function topUpUnits(invoice: Record<string, any>, itemPriceId: string): number | null {
  let units = 0;
  for (const line of (invoice.line_items ?? []) as Array<Record<string, any>>) {
    if (line?.entity_id !== itemPriceId) continue;
    const quantity = line.quantity === undefined ? 1 : line.quantity;
    if (!Number.isInteger(quantity) || quantity <= 0) return null;
    units += quantity;
  }
  return units > 0 ? units : null;
}
