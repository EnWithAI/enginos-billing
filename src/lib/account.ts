/**
 * Account lifecycle: customer creation, grant mirroring, budget push.
 *
 * The grant itself is NOT created here. The item price carries a Credit Grant
 * configuration and Chargebee issues the credits automatically when the
 * subscription is created — measured, not assumed. `/ledger_operations/allocate`
 * is for ad-hoc grants (bonuses, service-disruption compensation), requires a
 * mandatory `expires_at`, and has no documented client-supplied id, so its
 * idempotency would have to be ours. We read what Chargebee granted and mirror
 * it.
 *
 * "Mirror" is doing real work: the local ledger is the operational record of why
 * a balance is what it is, and Chargebee is the commercial record of what the
 * customer owns. They are reconciled, never merged.
 */

import { ACCOUNT, BATCH, ENTRY, prisma as defaultPrisma } from "./db";
import type { BlockReason } from "./gateway";
import { appendEntry } from "./ledger";
import { creditsToUsd, isBillable } from "./rate";
import { add, decimal } from "./decimal";
import type { ChargebeeClient } from "./chargebee";

/**
 * The idempotency key for one term's grant: `sub:<subscription id>:<term start>`.
 *
 * Every path that grants a term MUST use this. MEASURED end to end: the webhook
 * keyed its grant on the Chargebee event id while the post-checkout sync keyed
 * the same term on this, so the two — which both fire after every checkout —
 * recorded the grant twice: 4,000 credits and a $4 cap for 2,000 bought.
 */
export function termGrantRef(subscriptionId: string, termStartSeconds?: number | null): string {
  return `sub:${subscriptionId}:${termStartSeconds ?? 0}`;
}

export interface AccountDeps {
  prisma?: typeof defaultPrisma;
  chargebee: ChargebeeClient;
  usdPerCredit: string;
  /**
   * Sets the tenant's LiteLLM team cap from the ledger (see gateway.ts). When
   * present, an account is only `active` once this has succeeded. Absent = no
   * gateway configured: accounts go straight to `active`, unenforced.
   */
  pushBudget?: (tenantId: string, opts?: { unblock?: boolean }) => Promise<void>;
  /** Blocks the tenant's LiteLLM team outright: a failed push, or Chargebee credits used up. */
  blockBudget?: (tenantId: string, reason?: BlockReason) => Promise<void>;
  /** Hands the tenant's LiteLLM team back to its plan budget when the subscription ends. */
  releaseBudget?: (tenantId: string) => Promise<void>;
  clock?: () => number;
  logger?: { log?(o: unknown, m?: string): void; warn?(o: unknown, m?: string): void; error?(o: unknown, m?: string): void };
}

/**
 * Mirrors enginos-platform's `realmToRoutingSlug`.
 *
 * Duplicated rather than imported — the two services share a database but not a
 * codebase, and the platform has a conformance spec pinning this exact
 * transform. It is lossy (`org-acme.com` and `org.acme-com` both collapse to
 * `org_acme_com`), which is why the platform carries a unique constraint on the
 * result.
 */
export function realmToRoutingSlug(realm: string): string {
  return realm.replace(/[^a-zA-Z0-9_]/g, "_");
}

export function createAccounts(deps: AccountDeps) {
  const prisma = deps.prisma ?? defaultPrisma;
  const clock = deps.clock ?? (() => Date.now());
  const log = deps.logger ?? console;

  /**
   * Create the billing_account row for a tenant that has never been billed.
   *
   * Billing is NOT wired into tenant provisioning — the platform knows nothing
   * about this service. So the row has to be created on first use, and the only
   * facts we need come from tables the platform owns.
   *
   * Read with a raw query on purpose: `tenants` and `org_llm_gateways` belong to
   * enginos-platform. Modelling them in our schema would let `prisma migrate`
   * propose changes to tables we have no business touching.
   *
   * The slug prefers the gateway row but falls back to deriving it from the
   * realm, because `provisionOrgGateway` is fail-open — a tenant can exist and
   * serve traffic with no gateway row at all.
   */
  async function tenantFacts(tenantId: string) {
    const rows = await prisma.$queryRaw<
      Array<{ tenant_id: string; realm_name: string; routing_slug: string | null; org_name: string }>
    >`
      SELECT t.tenant_id::text, t.realm_name, t.org_name, g.routing_slug
        FROM tenants t
        LEFT JOIN org_llm_gateways g ON g.tenant_id = t.tenant_id
       WHERE t.tenant_id = ${tenantId}::uuid
         AND t.deleted_at IS NULL
       LIMIT 1
    `;

    const tenant = rows[0];
    if (!tenant) return null;

    return {
      tenantId: tenant.tenant_id,
      routingSlug: tenant.routing_slug ?? realmToRoutingSlug(tenant.realm_name),
      orgName: tenant.org_name,
    };
  }

  async function bootstrapFromTenant(tenantId: string) {
    const facts = await tenantFacts(tenantId);
    if (!facts) return null;
    return ensureCustomer(facts);
  }

  /**
   * Create the local row for a tenant that has merely LOOKED at billing, without
   * touching Chargebee.
   *
   * The billing page used to render a synthesised `unlinked` shape for a tenant
   * with no row, which meant the page worked but nothing was recorded: there was
   * no way to tell an org that had never opened billing from one that had opened
   * it and walked away, and `sync_from` — the instant before which usage is never
   * billed — was not pinned until first checkout.
   *
   * Deliberately NOT ensureCustomer: creating a Chargebee customer for everyone
   * who opens a page puts records in a third-party system for orgs that may never
   * subscribe. The customer is still created lazily at checkout, where it is
   * actually needed, and `ensureCustomer` upserts the same row so the two paths
   * converge.
   *
   * Returns null when the tenant does not exist in the platform's tables, which
   * the caller renders as the unlinked shape rather than an error.
   */
  async function ensureLocalAccount(tenantId: string) {
    const existing = await prisma.billingAccount.findUnique({ where: { tenantId } });
    if (existing) return existing;

    const facts = await tenantFacts(tenantId);
    if (!facts) return null;

    return prisma.billingAccount.upsert({
      where: { tenantId: facts.tenantId },
      create: {
        tenantId: facts.tenantId,
        routingSlug: facts.routingSlug,
        status: ACCOUNT.UNLINKED,
        // Pinned to NOW, never to the tenant's creation date. ClickHouse holds
        // 90 days of spans, and billing all of them the moment someone opens the
        // page would invoice a quarter's usage at once.
        syncFrom: new Date(clock()),
      },
      // A concurrent request may have created it between the read above and
      // here; the upsert makes that a no-op rather than a unique violation.
      update: {},
    });
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
    const account = await prisma.billingAccount.upsert({
      where: { tenantId: args.tenantId },
      create: {
        tenantId: args.tenantId,
        routingSlug: args.routingSlug,
        billingEmail: args.billingEmail ?? null,
        status: ACCOUNT.UNLINKED,
        // Never bill usage from before the account existed.
        syncFrom: new Date(clock()),
      },
      update: { routingSlug: args.routingSlug, billingEmail: args.billingEmail ?? undefined },
    });

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

      return await prisma.billingAccount.update({
        where: { tenantId: args.tenantId },
        data: { chargebeeCustomerId: customer.id },
      });
    } catch (err) {
      log.error?.(
        { metric: "billing.customer.create_failed", tenantId: args.tenantId, err: (err as Error).message },
        "Chargebee customer creation failed; account left unlinked for reconciliation",
      );
      return account;
    }
  }

  /**
   * Link a subscription and mirror its grant. Idempotent on `sourceRef`.
   *
   * `sourceRef` is the Chargebee event id, so a redelivered webhook cannot grant
   * the credits a second time — the unique index refuses the entry. That is the
   * guarantee; the webhook claim is only the first of two.
   *
   * Recomputes the grant whole rather than adding to it, so a correction made in
   * Chargebee converges here instead of compounding.
   */
  async function syncSubscription(args: {
    tenantId: string;
    subscriptionId: string;
    itemPriceId?: string | null;
    termStart?: Date | null;
    termEnd?: Date | null;
    /** Chargebee event id — the idempotency key for the grant entry. */
    sourceRef: string;
    status?: string;
  }) {
    const balance = await deps.chargebee.balance(args.subscriptionId);
    const unitId = balance?.unitId ?? null;
    const granted = unitId
      ? await deps.chargebee.grantedCredits(args.subscriptionId, unitId)
      : { credits: "0", blocks: 0 };

    const budgetUsd = creditsToUsd(granted.credits, deps.usdPerCredit);

    const account = await prisma.billingAccount.update({
      where: { tenantId: args.tenantId },
      data: {
        chargebeeSubscriptionId: args.subscriptionId,
        chargebeeItemPriceId: args.itemPriceId ?? undefined,
        ledgerUnitId: unitId,
        grantedCredits: granted.credits,
        budgetUsd,
        currentTermStart: args.termStart ?? undefined,
        currentTermEnd: args.termEnd ?? undefined,
        // Not active until the gateway holds the budget — see activate().
        status: deps.pushBudget ? ACCOUNT.ACTIVATING : (args.status ?? ACCOUNT.ACTIVE),
        cachedBalanceCredits: balance?.usable ?? undefined,
        cachedBalanceAt: balance ? new Date(clock()) : undefined,
      },
    });

    if (Number(granted.credits) > 0) {
      const { created } = await appendEntry(
        {
          tenantId: args.tenantId,
          entryType: ENTRY.GRANT,
          deltaCredits: granted.credits,
          sourceRef: args.sourceRef,
          occurredAt: args.termStart ?? new Date(clock()),
        },
        prisma,
      );

      if (!created) {
        log.log?.(
          { metric: "billing.grant.replayed", tenantId: args.tenantId, sourceRef: args.sourceRef },
          "Grant already recorded for this event; nothing to do",
        );
      }
    }

    // The gateway budget is the enforcement gate, and it is driven by the GRANT,
    // never by the ledger balance: the sync lags by a lag buffer plus a cron
    // interval, so a balance-derived budget would let a tenant overspend for
    // that whole window before the gate noticed.
    // Always through activate(), with or without a gateway: it also confirms the
    // Chargebee balance and reopens a capture held for lack of credits, which a
    // new grant must do either way.
    return activate(args.tenantId, args.status ?? ACCOUNT.ACTIVE);
  }

  /**
   * Make the gateway hold what the ledger says, and only then mark the account
   * `target` (normally active).
   *
   * Fail closed. If the push does not land, the customer has paid but the
   * gateway enforces a budget nobody computed — possibly the free plan's, higher
   * than what they bought. So the account is held `activating` (the page shows
   * no credits) and its LiteLLM team is blocked until a retry lands. The
   * credits are already in the ledger; nothing is lost, only paused.
   *
   * Nor does it open a team whose Chargebee credits are used up: the cap is set
   * but the team stays blocked and the account `exhausted` until credits arrive.
   */
  async function activate(tenantId: string, target: string = ACCOUNT.ACTIVE) {
    const exhausted = await chargebeeExhausted(tenantId);

    try {
      // No gateway configured means nothing to hold for: active immediately.
      if (deps.pushBudget) await deps.pushBudget(tenantId, { unblock: !exhausted });
    } catch (err) {
      log.error?.(
        { metric: "billing.budget.push_failed", tenantId, err: (err as Error).message },
        "Could not set the LiteLLM budget; account held as activating and its team blocked until a retry lands",
      );
      const held = await prisma.billingAccount.update({
        where: { tenantId },
        data: { status: ACCOUNT.ACTIVATING },
      });
      await block(tenantId, "activating");
      return held;
    }

    if (exhausted) {
      await block(tenantId, "exhausted");
      return prisma.billingAccount.update({ where: { tenantId }, data: { status: ACCOUNT.EXHAUSTED } });
    }

    const account = await prisma.billingAccount.update({ where: { tenantId }, data: { status: target } });
    await requeueHeldUsage(tenantId);
    return account;
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
        { metric: "billing.budget.block_failed", tenantId, reason, err: (err as Error).message },
        "Could not block the LiteLLM team; it keeps its previous budget until a retry lands",
      );
    }
  }

  /**
   * Is the Chargebee balance used up? A failed read is NOT evidence of that —
   * blocking a paying customer on a transient Chargebee error would be worse
   * than the minute until the next capture tells us for certain.
   */
  async function chargebeeExhausted(tenantId: string): Promise<boolean> {
    const account = await prisma.billingAccount.findUnique({ where: { tenantId } });
    if (!account?.chargebeeSubscriptionId) return false;
    try {
      const balance = await deps.chargebee.balance(account.chargebeeSubscriptionId);
      return balance != null && !isBillable(balance.usable);
    } catch {
      return false;
    }
  }

  /**
   * Put back the capture Chargebee refused for lack of credits.
   *
   * That batch was marked failed, which holds the tenant's billing cursor
   * behind it: nothing newer is read until it settles. With credits back it is
   * reopened as pending, so the next tick captures it — under the same id,
   * looked up first, so it can never be charged twice — and the cursor moves.
   */
  async function requeueHeldUsage(tenantId: string) {
    const held = await prisma.usageSyncBatch.findFirst({
      where: { tenantId, status: BATCH.FAILED, lastError: { startsWith: "insufficient credits" } },
      orderBy: { windowStart: "asc" },
    });
    if (!held) return;
    if (await prisma.usageSyncBatch.findFirst({ where: { tenantId, status: BATCH.PENDING } })) return;

    await prisma.usageSyncBatch.update({
      where: { id: held.id },
      data: { status: BATCH.PENDING, attempts: 0, lastError: null },
    });
    log.log?.({ metric: "billing.sync.requeued", tenantId, batchId: held.id }, "Held usage capture reopened");
  }

  /**
   * Retry every account held in `activating`. The worker runs this each minute;
   * with nothing held it is one indexed query and no gateway call.
   */
  async function activatePending() {
    if (!deps.pushBudget) return { pending: 0, activated: 0 };

    const held = await prisma.billingAccount.findMany({
      where: { status: ACCOUNT.ACTIVATING },
      select: { tenantId: true },
    });

    let activated = 0;
    for (const { tenantId } of held) {
      const account = await activate(tenantId);
      if (account.status === ACCOUNT.ACTIVE) activated += 1;
    }

    if (activated > 0) {
      log.log?.({ metric: "billing.budget.activated", activated, pending: held.length }, "Held accounts activated");
    }
    return { pending: held.length, activated };
  }

  /**
   * Renewal: expire what is left, then grant the new term.
   *
   * The expiry entry is written explicitly rather than letting the balance
   * simply restart, so "where did my 300 credits go" is answerable a year later.
   * A ledger that silently omits the expiry shows the right number for the wrong
   * reason.
   */
  async function renew(args: {
    tenantId: string;
    subscriptionId: string;
    sourceRef: string;
    termStart?: Date | null;
    termEnd?: Date | null;
  }) {
    const { balanceOf } = await import("./ledger");
    const before = await balanceOf(args.tenantId, prisma);

    // A repair sync may already have granted the NEW term under the same key.
    // Those credits are not leftovers, so they must not be expired with them.
    const newTermGrant = await prisma.creditLedgerEntry.findFirst({
      where: { tenantId: args.tenantId, sourceRef: args.sourceRef, entryType: ENTRY.GRANT },
    });
    const leftover = Number(before.current) - Number(newTermGrant?.deltaCredits ?? 0);

    if (leftover > 0) {
      await appendEntry(
        {
          tenantId: args.tenantId,
          entryType: ENTRY.EXPIRY,
          deltaCredits: `-${decimal(leftover)}`,
          sourceRef: `${args.sourceRef}:expiry`,
          occurredAt: args.termStart ?? new Date(clock()),
        },
        prisma,
      );
    }

    return syncSubscription({ ...args, status: ACCOUNT.ACTIVE });
  }

  async function cancel(tenantId: string) {
    const account = await prisma.billingAccount.update({
      where: { tenantId },
      data: { status: ACCOUNT.CANCELLED },
    });

    // Without this the team keeps the prepaid cap and the platform keeps its
    // hands off it — forever, since no further grant will come to move it.
    if (deps.releaseBudget) {
      try {
        await deps.releaseBudget(tenantId);
      } catch (err) {
        log.error?.(
          { metric: "billing.budget.release_failed", tenantId, err: (err as Error).message },
          "Could not hand the gateway budget back to the plan; the team keeps its prepaid cap",
        );
      }
    }

    return account;
  }

  /**
   * Pull current subscription state from Chargebee and apply it.
   *
   * Runs the same code the webhook runs, just triggered by us instead of by
   * Chargebee. Called right after a successful checkout so the customer sees
   * their credits immediately, and safe to call at any time as a repair.
   *
   * The grant is keyed on `sub:<id>:<term_start>` rather than an event id, so
   * each TERM grants exactly once no matter how often this is called — and a
   * renewal, which has a new term start, still grants as it should.
   */
  async function syncFromChargebee(tenantId: string) {
    const account = await prisma.billingAccount.findUnique({ where: { tenantId } });
    if (!account?.chargebeeCustomerId) return null;

    const subscriptions = await deps.chargebee.activeSubscriptions(account.chargebeeCustomerId);
    const subscription = subscriptions[0];
    if (!subscription) return null;

    const termStart = subscription.current_term_start
      ? new Date(subscription.current_term_start * 1000)
      : null;

    return syncSubscription({
      tenantId,
      subscriptionId: subscription.id,
      itemPriceId: subscription.subscription_items?.[0]?.item_price_id ?? null,
      termStart,
      termEnd: subscription.current_term_end
        ? new Date(subscription.current_term_end * 1000)
        : null,
      sourceRef: termGrantRef(subscription.id, subscription.current_term_start),
    });
  }

  /**
   * Grant top-up credits for every PAID pack invoice not yet applied.
   *
   * Payment first, credits second — and the proof of payment is the invoice, so
   * we never hand out credits for an abandoned checkout.
   *
   * Idempotency is the invoice id, used as the ledger entry's `source_ref`. One
   * paid invoice grants exactly once however often this runs. That matters more
   * here than elsewhere because /allocate has NO client-supplied id: if we
   * allocated first and wrote second, a crash in between would hand out free
   * credits on the retry. So the ledger entry is written in the same step, and
   * a pre-existing entry short-circuits before Chargebee is called at all.
   */
  async function applyPaidTopUps(tenantId: string, itemPriceId: string, creditsPerPack: string) {
    const account = await prisma.billingAccount.findUnique({ where: { tenantId } });
    if (!account?.chargebeeCustomerId || !account.chargebeeSubscriptionId || !account.ledgerUnitId) {
      return { applied: 0, credits: "0" };
    }

    const invoices = await deps.chargebee.paidInvoicesFor(account.chargebeeCustomerId, itemPriceId);

    let applied = 0;
    let credits = "0";

    for (const invoice of invoices) {
      const sourceRef = `invoice:${invoice.id}`;

      // Check BEFORE calling Chargebee. Allocate cannot be made idempotent on
      // its own, so the only safe order is: refuse early if we already did it.
      const existing = await prisma.creditLedgerEntry.findFirst({
        where: { tenantId, sourceRef },
      });
      if (existing) continue;

      const expiresAt = account.currentTermEnd
        ? Math.floor(account.currentTermEnd.getTime() / 1000)
        : Math.floor(clock() / 1000) + 30 * 24 * 60 * 60;

      const result = await deps.chargebee.allocate({
        subscriptionId: account.chargebeeSubscriptionId,
        unitId: account.ledgerUnitId,
        amount: creditsPerPack,
        expiresAt,
        idempotencyKey: sourceRef,
      });

      const { created } = await appendEntry(
        {
          tenantId,
          entryType: ENTRY.GRANT,
          deltaCredits: creditsPerPack,
          sourceRef,
          chargebeeOperationId: result.operationId,
          occurredAt: new Date(clock()),
        },
        prisma,
      );

      if (created) {
        applied += 1;
        credits = add(credits, creditsPerPack);
      }
    }

    if (applied > 0) {
      // The gateway ceiling has to move too, or the customer has credits they
      // cannot spend.
      const { balanceOf } = await import("./ledger");
      const balance = await balanceOf(tenantId, prisma);
      const budgetUsd = creditsToUsd(balance.allocated, deps.usdPerCredit);

      await prisma.billingAccount.update({
        where: { tenantId },
        data: { grantedCredits: balance.allocated, budgetUsd },
      });

      // Same rule as a subscription: if the gateway cannot be told, the account
      // is held and its team blocked until the retry lands. New credits end an
      // `exhausted` state too — activate() confirms against Chargebee first.
      await activate(tenantId, account.status === ACCOUNT.CANCELLED ? ACCOUNT.CANCELLED : ACCOUNT.ACTIVE);
    }

    return { applied, credits };
  }

  return {
    activatePending,
    ensureCustomer,
    ensureLocalAccount,
    bootstrapFromTenant,
    syncSubscription,
    syncFromChargebee,
    applyPaidTopUps,
    renew,
    cancel,
  };
}
