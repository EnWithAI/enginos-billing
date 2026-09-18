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

import { ACCOUNT, ENTRY, prisma as defaultPrisma } from "./db";
import { appendEntry } from "./ledger";
import { creditsToUsd } from "./rate";
import { add } from "./decimal";
import type { ChargebeeClient } from "./chargebee";

export interface AccountDeps {
  prisma?: typeof defaultPrisma;
  chargebee: ChargebeeClient;
  usdPerCredit: string;
  /** Pushes a team budget to LiteLLM. Injected so billing owns no gateway client. */
  pushBudget?: (routingSlug: string, budgetUsd: string, termEnd: Date | null) => Promise<void>;
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
        status: args.status ?? ACCOUNT.ACTIVE,
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
    if (deps.pushBudget) {
      try {
        await deps.pushBudget(account.routingSlug, budgetUsd, args.termEnd ?? null);
      } catch (err) {
        log.error?.(
          { metric: "billing.budget.push_failed", tenantId: args.tenantId, err: (err as Error).message },
          "Could not push max_budget to the gateway; enforcement may be stale",
        );
      }
    }

    return account;
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

    if (Number(before.current) > 0) {
      await appendEntry(
        {
          tenantId: args.tenantId,
          entryType: ENTRY.EXPIRY,
          deltaCredits: `-${before.current}`,
          sourceRef: `${args.sourceRef}:expiry`,
          occurredAt: args.termStart ?? new Date(clock()),
        },
        prisma,
      );
    }

    return syncSubscription({ ...args, status: ACCOUNT.ACTIVE });
  }

  async function cancel(tenantId: string) {
    return prisma.billingAccount.update({
      where: { tenantId },
      data: { status: ACCOUNT.CANCELLED },
    });
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
      sourceRef: `sub:${subscription.id}:${subscription.current_term_start ?? 0}`,
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
      const updated = await prisma.billingAccount.findUnique({ where: { tenantId } });
      const { balanceOf } = await import("./ledger");
      const balance = await balanceOf(tenantId, prisma);
      const budgetUsd = creditsToUsd(balance.allocated, deps.usdPerCredit);

      await prisma.billingAccount.update({
        where: { tenantId },
        data: { grantedCredits: balance.allocated, budgetUsd },
      });

      if (deps.pushBudget && updated) {
        try {
          await deps.pushBudget(updated.routingSlug, budgetUsd, updated.currentTermEnd);
        } catch (err) {
          log.error?.(
            { metric: "billing.topup.budget_push_failed", tenantId, err: (err as Error).message },
            "Top-up applied but the gateway ceiling was not raised",
          );
        }
      }
    }

    return { applied, credits };
  }

  return {
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
