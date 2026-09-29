/**
 * Rig for the lifecycle / webhook / LiteLLM part of the failure matrix
 * (failure-matrix-lifecycle.test.ts).
 *
 * It wires the REAL services together — createAccountService,
 * createGatewayBudget (through budgetHooksFor, exactly as container/budget-hooks.ts
 * does), createWebhookService and createUsageSyncService — over the harness's
 * FakePrisma / FakeChargebee / FakeUsageSource, plus two fakes of our own:
 *
 *   FakeGateway     a LiteLLM team, applying /team/update the way LiteLLM does
 *                   (only the fields sent), with an admission rule modelled on
 *                   LiteLLM 1.98's team budget check, and fault switches.
 *   ChargebeeWorld  the subscription / grant-block / balance / invoice side of
 *                   Chargebee, sharing ONE ledger (the harness FakeChargebee)
 *                   with the usage sync, so a capture, an allocate and a renewal
 *                   all move the same balance.
 *
 * Nothing here re-implements product logic; the fakes only model the external
 * systems.
 */

import type { CaptureArgs } from "@/integrations/chargebee";
import { isLiveGrantBlock } from "@/integrations/chargebee/ledger";
import type { GatewayClient, GatewayTeam } from "@/integrations/litellm/client";
import { createBillingAccountRepository } from "@/repositories/billing-account.repository";
import { createAccountService } from "@/services/account.service";
import {
  BASELINE_TERM,
  BILLING_MANAGED,
  BLOCK_REASON,
  SPEND_BASELINE,
  budgetHooksFor,
  createGatewayBudget,
} from "@/services/gateway-budget.service";
import { createUsageSyncService } from "@/services/usage-sync.service";
import { createWebhookService, type ChargebeeEvent } from "@/services/webhook.service";

import { FakeChargebee, FakeUsageSource, MINUTE, RATE, SLUG, T0, TENANT, makeFakePrisma } from "./harness";

export { BASELINE_TERM, BILLING_MANAGED, BLOCK_REASON, SPEND_BASELINE, MINUTE, RATE, SLUG, T0, TENANT };

export const TEAM = "team_org_acme_com";
export const UNIT = "token-test";
export const PLAN = "plan-monthly";
export const PLAN_B = "plan-monthly-large";
export const PACK = "token-pack";
export const DAY_S = 86_400;
export const T0_S = Math.floor(T0 / 1000);
/** The platform's free-plan budget, which its reconciler restores on an unmanaged team. */
export const PLAN_BUDGET = 5;

// ── LiteLLM ────────────────────────────────────────────────────────────────

/** A LiteLLM team as /team/info and /team/update see it. */
export class FakeGateway implements GatewayClient {
  team_: GatewayTeam = { spend: 0, maxBudget: PLAN_BUDGET, budgetDuration: "30d", blocked: false, metadata: { plan: "free" } };
  updates: Array<Record<string, unknown>> = [];
  /** Admin API unreachable: /team/info and /team/update both fail. */
  down = false;
  /** Only budget writes (a body carrying max_budget) fail. */
  pushFails = false;
  /** Only block writes (blocked: true) fail. */
  blockFails = false;
  /** Only release writes — no cap and no `blocked: true` — fail. */
  releaseFails = false;
  /** Fail the next N budget writes, then recover. */
  failNextCapWrites = 0;
  /**
   * When set, a block write (blocked: true) waits for this promise AFTER its
   * read-modify-write read has happened — a slow /team/update. `blockHeld`
   * resolves when one is parked.
   */
  holdBlockWrites: Promise<void> | null = null;
  private onBlockHeld: (() => void) | null = null;
  blockHeld: Promise<void> = new Promise((resolve) => (this.onBlockHeld = resolve));

  async team(teamId: string) {
    if (this.down) throw new Error("LiteLLM /team/info failed (503)");
    return teamId === TEAM ? { ...this.team_, metadata: { ...this.team_.metadata } } : null;
  }

  async updateTeam(body: Record<string, unknown>) {
    if (this.down) throw new Error("LiteLLM /team/update failed (503)");
    const isCap = "max_budget" in body;
    const isBlock = body.blocked === true;
    if (isCap && this.pushFails) throw new Error("LiteLLM /team/update failed (503)");
    if (isCap && this.failNextCapWrites > 0) {
      this.failNextCapWrites -= 1;
      throw new Error("LiteLLM /team/update failed (502)");
    }
    if (isBlock && this.blockFails) throw new Error("LiteLLM /team/update failed (503)");
    if (!isCap && !isBlock && this.releaseFails) throw new Error("LiteLLM /team/update failed (503)");
    if (isBlock && this.holdBlockWrites) {
      const gate = this.holdBlockWrites;
      this.holdBlockWrites = null;
      this.onBlockHeld?.();
      await gate;
    }
    this.updates.push(structuredClone(body));
    if ("max_budget" in body) this.team_.maxBudget = body.max_budget as number;
    if ("budget_duration" in body) this.team_.budgetDuration = body.budget_duration as string | null;
    if ("metadata" in body) this.team_.metadata = body.metadata as Record<string, unknown>;
    if ("blocked" in body) this.team_.blocked = body.blocked as boolean;
  }

  /**
   * Would LiteLLM 1.98 admit one more call on this team's key?
   *
   * Blocked teams refuse. Otherwise the team counter admits while ANY headroom
   * remains: budget_reservation.py:124-131 resizes the reservation down to what
   * is left and only raises BudgetExceededError when nothing is left, and
   * auth_checks.py:4285 refuses when spend > max_budget.
   */
  admits(): boolean {
    if (this.team_.blocked) return false;
    if (this.team_.maxBudget == null) return true;
    return this.team_.maxBudget - this.team_.spend > 1e-12;
  }

  /** USD LiteLLM would still let the team spend. */
  headroomUsd(): number {
    return round6((this.team_.maxBudget ?? Infinity) - this.team_.spend);
  }

  /** enginos-platform's plan reconciler: an unmanaged team gets its plan budget back. */
  platformReconcile() {
    if (this.team_.metadata[BILLING_MANAGED] !== true) {
      this.team_.maxBudget = PLAN_BUDGET;
      this.team_.budgetDuration = "30d";
    }
  }
}

// ── Chargebee ──────────────────────────────────────────────────────────────

export interface FakeSubscription {
  id: string;
  customer_id: string;
  status: string;
  created_at: number;
  current_term_start: number;
  current_term_end: number;
  subscription_items: Array<{ item_price_id: string }>;
}

interface GrantBlock {
  id: string;
  subscription_id: string;
  unit_id: string;
  granted_amount: number;
  status: string;
  expires_at?: number;
  /**
   * plan       the plan item price's Credit Grant
   * topup      made by /ledger_operations/allocate — names no invoice
   * catalogue  a top-up pack whose OWN item price carries a Credit Grant —
   *            names the invoice line that bought it, as the live site does
   */
  kind: "plan" | "topup" | "catalogue";
  created_at_ms: number;
  /** billing_metadata.line_items[0] and item_price_id; absent on an allocation. */
  invoice?: { id: string; lineItemId: string };
  itemPriceId?: string;
  /** metadata.done_by: the API key's name on an allocation. */
  doneBy?: string;
}

/**
 * Chargebee's subscription, grant-block and invoice state, over ONE ledger
 * (the harness FakeChargebee) that the usage sync captures from.
 *
 * The balance is the ledger's single number: a renewal sets it to the new
 * term's grant (the old block's leftover expires), an allocate adds to it, a
 * capture subtracts from it — and a capture larger than it is refused as
 * ERROR_INSUFFICIENT_BALANCE, as on a capped credit unit.
 */
export class ChargebeeWorld {
  ledger = new FakeChargebee(0);
  /** Every capture as the usage sync sent it — subscription and unit included. */
  sent: CaptureArgs[] = [];
  subscriptions: FakeSubscription[] = [];
  blocks: GrantBlock[] = [];
  /** Allocations that GRANTED credits — a replay under an idempotency key is not one. */
  allocations: Array<{ subscriptionId: string; unitId: string; amount: string; expiresAt: number; idempotencyKey?: string; metadata?: Record<string, string>; atMs?: number }> = [];
  /** Every allocate request that reached Chargebee, granted or replayed. */
  allocateCalls: Array<{ subscriptionId: string; unitId: string; amount: string; expiresAt: number; idempotencyKey?: string }> = [];
  /**
   * `chargebee-idempotency-key`, as MEASURED on the live site: within 30
   * minutes the same key and the same request answer with the original result
   * and grant nothing; the same key with a DIFFERENT request is refused; after
   * 30 minutes the key is new again.
   */
  idempotency = new Map<string, { body: string; result: { operationId: string; balanceAfter: string }; atMs: number }>();
  /**
   * Faults for the next allocate calls, in order:
   *   lose-response   the grant lands, the answer never arrives
   *   unreachable     nothing reaches Chargebee
   *   refuse          a 400: nothing granted
   */
  allocateFaults: Array<"lose-response" | "unreachable" | "refuse"> = [];
  /** GET /grant_blocks stops before the last page. */
  grantBlocksIncomplete = false;
  /** Balances of units other than the plan's (a pack granted into the wrong unit). */
  otherUnits = new Map<string, number>();
  paidInvoices: Array<{ id: string; paid_at?: number; line_items?: Array<{ id: string; entity_id: string; quantity?: unknown }> }> = [];
  /**
   * The service is pointed at a site that is not ours (a wrong CHARGEBEE_SITE
   * or key): it lists no subscriptions and knows no id — 404 for everything.
   */
  wrongSite = false;
  private seq = 0;

  constructor(private readonly now: () => number) {}

  subscribe(id: string, opts: { plan?: string; start?: number; end?: number; credits?: number } = {}): FakeSubscription {
    const start = opts.start ?? T0_S;
    const sub: FakeSubscription = {
      id,
      customer_id: TENANT,
      status: "active",
      created_at: Math.floor(this.now() / 1000) + this.seq++,
      current_term_start: start,
      current_term_end: opts.end ?? start + 30 * DAY_S,
      subscription_items: [{ item_price_id: opts.plan ?? PLAN }],
    };
    this.subscriptions.push(sub);
    this.grantPlan(id, opts.credits ?? 1000);
    return sub;
  }

  sub(id: string): FakeSubscription {
    const sub = this.subscriptions.find((s) => s.id === id);
    if (!sub) throw new Error(`no subscription ${id}`);
    return sub;
  }

  /** The item price's Credit Grant: a new live plan block. */
  grantPlan(subscriptionId: string, credits: number) {
    const n = ++this.seq;
    this.blocks.push({
      id: `gb_${n}`,
      subscription_id: subscriptionId,
      unit_id: UNIT,
      granted_amount: credits,
      status: "available",
      kind: "plan",
      created_at_ms: this.now(),
      invoice: { id: `inv_plan_${n}`, lineItemId: `li_plan_${n}` },
      itemPriceId: PLAN,
    });
    this.ledger.balance += credits;
  }

  /**
   * A pack bought while its item price carries its OWN Credit Grant (C57d):
   * the invoice is paid and Chargebee grants the credits itself — into `unit`,
   * which on the live site was `token` rather than the plan's `token-test`.
   */
  payPackWithGrant(invoiceId: string, opts: { subscriptionId?: string; unit?: string; credits?: number; itemPriceId?: string } = {}) {
    const lineItemId = `li_${invoiceId}`;
    const unit = opts.unit ?? UNIT;
    const credits = opts.credits ?? 1000;
    this.paidInvoices.push({ id: invoiceId, paid_at: Math.floor(this.now() / 1000), line_items: [{ id: lineItemId, entity_id: opts.itemPriceId ?? PACK }] });
    this.blocks.push({
      id: `gb_${++this.seq}`,
      subscription_id: opts.subscriptionId ?? "sub_1",
      unit_id: unit,
      granted_amount: credits,
      status: "available",
      kind: "catalogue",
      created_at_ms: this.now(),
      invoice: { id: invoiceId, lineItemId },
      itemPriceId: opts.itemPriceId ?? PACK,
    });
    if (unit === UNIT) this.ledger.balance += credits;
    else this.otherUnits.set(unit, (this.otherUnits.get(unit) ?? 0) + credits);
  }

  /**
   * A pack paid for the ordinary way: an invoice with its pack line, and no
   * grant of its own. `quantity` omitted leaves the line without one, as the
   * rig always has; anything else is written onto the line as given.
   */
  payPack(invoiceId: string, quantity?: unknown) {
    const line = { id: `li_${invoiceId}`, entity_id: PACK, ...(quantity === undefined ? {} : { quantity }) };
    this.paidInvoices.push({ id: invoiceId, paid_at: Math.floor(this.now() / 1000), line_items: [line] });
  }

  /** Term rollover: the old plan block expires (its leftover with it), a new one is issued. */
  renew(id: string, opts: { start: number; end?: number; credits?: number; plan?: string }) {
    const sub = this.sub(id);
    sub.current_term_start = opts.start;
    sub.current_term_end = opts.end ?? opts.start + 30 * DAY_S;
    if (opts.plan) sub.subscription_items = [{ item_price_id: opts.plan }];
    for (const b of this.blocks) if (b.subscription_id === id && b.kind === "plan" && b.status === "available") b.status = "expired";
    this.ledger.balance = 0;
    this.grantPlan(id, opts.credits ?? 1000);
  }

  /** Every grant block of the subscription passes its expiry: nothing left to spend. */
  expireGrants(id: string) {
    for (const b of this.blocks) if (b.subscription_id === id) b.status = "expired";
    this.ledger.balance = 0;
  }

  cancel(id: string) {
    this.sub(id).status = "cancelled";
  }

  /** Credits currently live on a subscription in the billed unit (what grantedCredits(sub, unit) sums). */
  liveCredits(subscriptionId: string, unitId: string = UNIT): number {
    return this.blocks
      .filter((b) => b.subscription_id === subscriptionId && b.unit_id === unitId && isLiveGrantBlock(b, this.now()))
      .reduce((s, b) => s + b.granted_amount, 0);
  }

  /** Credits actually taken from the ledger for captures sent against this subscription. */
  takenFor(subscriptionId: string): number {
    const subOf = new Map(this.sent.map((a) => [a.id, a.subscriptionId]));
    let total = 0;
    for (const [opId, amount] of this.ledger.applied) if (subOf.get(opId) === subscriptionId) total += Number(amount);
    return total;
  }

  /** What the account service and the budget hooks call. */
  readonly client = {
    createCustomer: async ({ id }: { id: string }) => ({ id }),
    /** One unit's balance; without a unit, the oldest — the plan's — as the real client picks it. */
    balance: async (subscriptionId: string, unitId?: string | null) => {
      if (!this.subscriptions.some((s) => s.id === subscriptionId)) return null;
      const unitCount = 1 + this.otherUnits.size;
      if (!unitId || unitId === UNIT) return { unitId: UNIT, unitName: UNIT, usable: String(this.ledger.balance), onHold: "0", unitCount };
      const other = this.otherUnits.get(unitId);
      return other == null ? null : { unitId, unitName: unitId, usable: String(other), onHold: "0", unitCount };
    },
    grantedCredits: async (subscriptionId: string, unitId?: string) => {
      const live = this.blocks.filter(
        (b) => b.subscription_id === subscriptionId && (!unitId || b.unit_id === unitId) && isLiveGrantBlock(b, this.now()),
      );
      return { credits: String(live.reduce((s, b) => s + b.granted_amount, 0)), blocks: live.length };
    },
    /** GET /subscriptions/{id}: any status, or null once it is gone. */
    subscription: async (id: string) => {
      if (this.wrongSite) return null;
      const sub = this.subscriptions.find((s) => s.id === id);
      return sub ? structuredClone(sub) : null;
    },
    /** GET /customers/{id}: our one customer, unless the site is the wrong one. */
    customer: async (id: string) => (!this.wrongSite && id === TENANT ? { id } : null),
    subscriptionIdsOf: async (customerId: string) =>
      this.subscriptions.filter((s) => s.customer_id === customerId).map((s) => s.id),
    activeSubscriptions: async (customerId: string) =>
      this.wrongSite
        ? []
        : this.subscriptions
            .filter((s) => s.customer_id === customerId && ["active", "in_trial", "non_renewing"].includes(s.status))
            .map((s) => structuredClone(s))
            .sort((a, b) => b.created_at - a.created_at),
    /** As the live site answers: operations carry NO metadata — what allocate was sent is not returned. */
    ledgerOperations: async (subscriptionId: string) =>
      this.allocations
        .filter((a) => a.subscriptionId === subscriptionId)
        .map((_a, i) => ({ id: `alloc_${i}`, type: "allocation", subscription_id: subscriptionId })),
    /** GET /ledger_operations/{id}: an allocation this fake made, in the client's shape — no metadata, as live. */
    ledgerOperation: async (id: string) => {
      const n = /^alloc_(\d+)$/.exec(id);
      const a = n ? this.allocations[Number(n[1]) - 1] : undefined;
      return a
        ? { id, type: "allocation", subscriptionId: a.subscriptionId, unitId: a.unitId, amount: a.amount, createdAtMs: a.atMs ?? null }
        : null;
    },
    /** GET /grant_blocks, in the client's shape: a catalogue grant names its invoice line, an allocation names nothing. */
    grantBlocks: async (subscriptionId: string) => ({
      complete: !this.grantBlocksIncomplete,
      blocks: this.blocks
        .filter((b) => b.subscription_id === subscriptionId)
        .map((b) => ({
          id: b.id,
          subscriptionId: b.subscription_id,
          unitId: b.unit_id,
          grantedAmount: String(b.granted_amount),
          status: b.status,
          source: b.kind === "plan" ? "subscription_created" : b.kind === "catalogue" ? "top_up" : "promotional_grants",
          createdAtMs: b.created_at_ms,
          invoices: b.invoice ? [{ invoiceId: b.invoice.id, lineItemId: b.invoice.lineItemId }] : [],
          itemPriceId: b.itemPriceId ?? null,
          doneBy: b.doneBy ?? null,
        })),
    }),
    paidInvoicesFor: async () => this.paidInvoices.map((i) => ({ ...i })),
    allocate: async (args: {
      subscriptionId: string;
      unitId: string;
      amount: string;
      expiresAt: number;
      idempotencyKey?: string;
      metadata?: Record<string, string>;
    }) => {
      this.allocateCalls.push({ ...args });
      const fault = this.allocateFaults.shift();
      if (fault === "unreachable") {
        throw Object.assign(new Error("Chargebee /ledger_operations/allocate unreachable: timeout"), { retryable: true });
      }
      if (fault === "refuse") {
        throw Object.assign(new Error("unit_id : invalid value"), { status: 400, apiErrorCode: "invalid_request", retryable: false });
      }

      const body = JSON.stringify([args.subscriptionId, args.unitId, args.amount, args.expiresAt]);
      const seen = args.idempotencyKey ? this.idempotency.get(args.idempotencyKey) : undefined;
      if (seen && this.now() - seen.atMs < 30 * MINUTE) {
        if (seen.body !== body) {
          throw Object.assign(
            new Error(
              "The idempotency key provided has already been used for a different request. Please use a new idempotency key or ensure the endpoint matches the original request signature.",
            ),
            { status: 400, apiErrorCode: "invalid_request", retryable: false },
          );
        }
        if (fault === "lose-response") throw Object.assign(new Error("Chargebee /ledger_operations/allocate unreachable: timeout"), { retryable: true });
        return { ...seen.result };
      }

      this.allocations.push({ ...args, atMs: this.now() });
      this.blocks.push({
        id: `gb_${++this.seq}`,
        subscription_id: args.subscriptionId,
        unit_id: args.unitId,
        granted_amount: Number(args.amount),
        status: "available",
        expires_at: args.expiresAt,
        kind: "topup",
        created_at_ms: this.now(),
        doneBy: "full_access_key_v1",
      });
      if (args.expiresAt * 1000 > this.now()) this.ledger.balance += Number(args.amount);
      const result = { operationId: `alloc_${this.allocations.length}`, balanceAfter: String(this.ledger.balance) };
      if (args.idempotencyKey) this.idempotency.set(args.idempotencyKey, { body, result, atMs: this.now() });
      if (fault === "lose-response") throw Object.assign(new Error("Chargebee /ledger_operations/allocate unreachable: timeout"), { retryable: true });
      return result;
    },
  };

  /** What the usage sync calls. Records the full capture args, then delegates to the harness ledger. */
  readonly sync = {
    capture: (args: CaptureArgs) => {
      this.sent.push({ ...args });
      return this.ledger.capture(args);
    },
    captureIdempotent: (args: CaptureArgs) => {
      this.sent.push({ ...args });
      return this.ledger.captureIdempotent(args);
    },
  };
}

/** A webhook body as Chargebee would send it, snapshotting the subscription NOW — a later delivery of it is stale. */
export function webhook(eventType: string, sub: FakeSubscription, id = `ev_${eventType}_${sub.id}_${sub.current_term_start}`): ChargebeeEvent {
  return { id, event_type: eventType, content: { subscription: structuredClone(sub) } };
}

// ── the rig ────────────────────────────────────────────────────────────────

export function lifecycleRig() {
  let now = T0;
  const prisma = makeFakePrisma({
    chargebeeSubscriptionId: null,
    ledgerUnitId: null,
    chargebeeCustomerId: TENANT,
    status: "unlinked",
  });
  const gateway = new FakeGateway();
  const cb = new ChargebeeWorld(() => now);
  const usage = new FakeUsageSource();
  const errors: Array<Record<string, unknown>> = [];
  const warns: Array<Record<string, unknown>> = [];
  const logger = {
    log() {},
    warn: (o: unknown) => void warns.push(o as Record<string, unknown>),
    error: (o: unknown) => void errors.push(o as Record<string, unknown>),
  };

  const repo = createBillingAccountRepository(prisma as never);

  // Exactly container/budget-hooks.ts, with the fakes in place of the clients.
  const budget = createGatewayBudget({
    gateway,
    usdPerCredit: RATE,
    logger,
    teamIdFor: async () => TEAM,
    grantedCreditsFor: async (tenantId) => {
      const account = await repo.findByTenantId(tenantId);
      if (!account?.chargebeeSubscriptionId) return "0";
      const { credits } = await cb.client.grantedCredits(account.chargebeeSubscriptionId, account.ledgerUnitId ?? undefined);
      return credits;
    },
  });
  const hooks = budgetHooksFor(budget);

  const accounts = createAccountService({
    prisma: prisma as never,
    chargebee: cb.client as never,
    usdPerCredit: RATE,
    billingItemPriceIds: [PLAN, PLAN_B],
    clock: () => now,
    logger,
    ...hooks,
  });
  const webhooks = createWebhookService({
    accountService: accounts,
    accounts: repo,
    topUp: { itemPriceId: PACK, creditsPerUnit: "1000" },
    logger,
  });
  const usageSync = createUsageSyncService({
    prisma: prisma as never,
    usage,
    chargebee: cb.sync,
    usdPerCredit: RATE,
    lagMs: MINUTE,
    windowMs: MINUTE,
    clock: () => now,
    logger,
    blockBudget: hooks.blockBudget,
    releaseBudget: hooks.releaseBudget,
  });

  const rig = {
    prisma,
    gateway,
    cb,
    usage,
    budget,
    accounts,
    webhooks,
    usageSync,
    errors,
    warns,
    /** Move every clock to T0 + m minutes. */
    at(m: number) {
      now = T0 + m * MINUTE;
      usage.nowMs = now;
      prisma._now = now;
      return rig;
    },
    now: () => now,
    account: () => prisma._accounts.get(TENANT)!,
    deliver: (event: ChargebeeEvent) => webhooks.handle(event),
    /** One worker tick exactly as hatchet-worker.ts runs it: activations, the usage sync, then the gate check. */
    async tick() {
      const activation = await accounts.activatePending();
      const summary = await usageSync.runOnce();
      const gates = await accounts.reopenBlockedActive({ deadline: now + 4 * MINUTE });
      return { activation, gates, summary };
    },
    /**
     * One LLM call through the tenant's team key: admitted only if LiteLLM
     * would admit it; if so the team's spend moves and the span lands in
     * ClickHouse at `ingestedAtMs`.
     */
    llmCall(key: string, ingestedAtMs: number, usd: number): boolean {
      if (!gateway.admits()) return false;
      gateway.team_.spend = round6(gateway.team_.spend + usd);
      usage.add(key, ingestedAtMs, usd);
      return true;
    },
    cursorMin: () => (prisma._cursor == null ? null : (prisma._cursor - T0) / MINUTE),
    billedRanges: () =>
      prisma._log
        .filter((s: { status: string }) => s.status === "SUCCESS")
        .map((s: { fromIngestedAt: Date; toIngestedAt: Date }) => [
          (s.fromIngestedAt.getTime() - T0) / MINUTE,
          (s.toIngestedAt.getTime() - T0) / MINUTE,
        ]),
    metrics: () => [...errors, ...warns].map((e) => e.metric),
    /** Subscribe `id` in Chargebee and deliver its subscription_created. */
    async subscribe(id = "sub_1", opts: { plan?: string; start?: number; end?: number; credits?: number } = {}) {
      const sub = cb.subscribe(id, opts);
      await webhooks.handle(webhook("subscription_created", sub));
      return sub;
    },
  };
  return rig;
}

export type LifecycleRig = ReturnType<typeof lifecycleRig>;

/**
 * Does the LiteLLM team say what the billing DB says?
 *
 *   active      open, billing-managed, no rolling reset, cap = baseline + live grant
 *   exhausted   blocked, reason exhausted
 *   activating  blocked
 *   cancelled   handed back: not billing-managed, and not left blocked by billing
 */
export function gatewayAgreesWithDb(r: LifecycleRig): { ok: boolean; why: string } {
  const a = r.account();
  const t = r.gateway.team_;
  const managed = t.metadata[BILLING_MANAGED] === true;
  switch (a.status) {
    case "active": {
      const baseline = Number(t.metadata[SPEND_BASELINE]);
      const live = a.chargebeeSubscriptionId ? r.cb.liveCredits(a.chargebeeSubscriptionId) : 0;
      const expected = round6(baseline + live * Number(RATE));
      const ok = !t.blocked && managed && t.budgetDuration == null && t.maxBudget === expected;
      return { ok, why: `active: blocked=${t.blocked} managed=${managed} duration=${t.budgetDuration} max=${t.maxBudget} expected=${expected}` };
    }
    case "exhausted":
      return { ok: t.blocked && t.metadata[BLOCK_REASON] === "exhausted", why: `exhausted: blocked=${t.blocked} reason=${String(t.metadata[BLOCK_REASON])}` };
    case "activating":
      return { ok: t.blocked, why: `activating: blocked=${t.blocked}` };
    case "cancelled": {
      // Billing's own block must go with the ownership, or the customer loses
      // the free plan too: the platform's reconciler never sends `blocked`.
      const reason = t.metadata[BLOCK_REASON];
      const ok = !managed && !t.blocked && reason === undefined;
      return { ok, why: `cancelled: managed=${managed} blocked=${t.blocked} reason=${String(reason)}` };
    }
    default:
      return { ok: false, why: `unexpected status ${a.status}` };
  }
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
