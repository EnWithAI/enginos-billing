/**
 * Moving an org from one subscription to another while syncs and usage
 * passes are running — the two races a currency switch would otherwise lose,
 * reproduced end to end, and the plumbing the per-currency configuration
 * needs in the services.
 *
 *   A STALE SYNC. A sync reads the account and Chargebee's subscriptions,
 *   chooses, reads a balance, and only then links. MEASURED in a simulation:
 *   one that read [B, A] while A was active chose A, and linked it AFTER a
 *   second sync had linked B once A was cancelled — the account `active` on a
 *   cancelled subscription. The link is now a compare-and-set on what the
 *   chooser saw: the stale one writes nothing, and does nothing else.
 *
 *   A STALE PASS. A usage pass reads the account once and opens windows from
 *   that read for minutes. MEASURED in a simulation: a pass that read A opened
 *   and captured windows pinned to A after the relink to B. The window's
 *   compare-and-set now compares its pins: the stale pass backs off, and the
 *   next one bills B.
 */

import { describe, expect, it, vi } from "vitest";

import { paidGrantedCredits } from "@/container/budget-hooks";
import type { ChargebeeClient } from "@/integrations/chargebee";
import { ACCOUNT } from "@/models/account-status";
import { currencyCatalog, type CurrencyRules } from "@/models/currency";
import { createBillingAccountRepository } from "@/repositories/billing-account.repository";
import { createAccountService } from "@/services/account.service";
import { createCheckoutService } from "@/services/checkout.service";
import { createWebhookService } from "@/services/webhook.service";
import { AppError } from "@/shared/errors";

import { Gate } from "./failure-matrix-crash-and-concurrency.helpers";
import {
  DAY_S,
  PLAN_B,
  T0_S,
  UNIT,
  gatewayAgreesWithDb,
  lifecycleRig,
  webhook,
} from "./failure-matrix-lifecycle-webhooks-litellm.helpers";
import { MINUTE, T0, TENANT, makeFakePrisma, quietLogger } from "./harness";

const RULES: CurrencyRules = { defaultCurrency: "USD", byCountry: { IN: "INR" } };
const topUp = (itemPriceId: string, credits = "") => ({ itemPriceId, presetAmounts: [50, 100], minAmount: null, maxAmount: null, credits });
const BOTH = currencyCatalog(RULES, {
  USD: { freeItemPriceId: "free-usd", topUp: topUp("api_token-USD", "50") },
  INR: { freeItemPriceId: "free-inr", topUp: topUp("api_token-INR") },
});

/** A balance read that runs `meanwhile` once — after reading `subscriptionId` — before it answers. */
function slowBalance(r: ReturnType<typeof lifecycleRig>, subscriptionId: string, meanwhile: () => Promise<void>) {
  const client = r.cb.client as unknown as Record<string, (...args: any[]) => Promise<any>>;
  const balance = client.balance!;
  let fired = false;
  client.balance = async (id: string, unitId?: string | null) => {
    const out = await balance(id, unitId);
    if (!fired && id === subscriptionId) {
      fired = true;
      await meanwhile();
    }
    return out;
  };
}

describe("a stale sync cannot re-link the subscription another sync has moved the org off", () => {
  it("chose A before A was cancelled, links after B was: matches nothing, and does nothing else", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });
    r.at(1);
    // B, in the new currency, with the org's credits carried to it.
    const subB = r.cb.subscribe("sub_2", { credits: 0, plan: PLAN_B, start: T0_S + 60 });
    await r.cb.client.allocate({ subscriptionId: "sub_2", unitId: UNIT, amount: "1000", expiresAt: T0_S + 3650 * DAY_S, idempotencyKey: "carry:1" });

    // Sync #1 (B's subscription_created) reads [B, A] and keeps A, the
    // account's own. While it reads A's balance, A is cancelled and sync #2
    // (A's subscription_cancelled) reads [B] and links it.
    let afterSync2: Record<string, unknown> = {};
    let gatewayWritesAfterSync2 = 0;
    slowBalance(r, "sub_1", async () => {
      r.cb.cancel("sub_1");
      await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
      afterSync2 = { ...r.account() };
      gatewayWritesAfterSync2 = r.gateway.updates.length;
    });
    await r.deliver(webhook("subscription_created", subB));

    expect(afterSync2).toMatchObject({ chargebeeSubscriptionId: "sub_2", status: ACCOUNT.ACTIVE });
    // Sync #1's link of A matched nothing…
    expect(r.account()).toEqual(afterSync2);
    expect(r.warns).toContainEqual(
      expect.objectContaining({ metric: "billing.subscription.link_raced", subscriptionId: "sub_1", expected: "sub_1", linkedNow: "sub_2" }),
    );
    // …and it did nothing else: no cap rebuilt from A's grant, no status written.
    expect(r.gateway.updates).toHaveLength(gatewayWritesAfterSync2);
    expect(gatewayAgreesWithDb(r)).toMatchObject({ ok: true });
  });

  it("a resubscribing sync that loses the race moves no cursor: billing that resumed on the winner's subscription is not skipped", async () => {
    let now = T0 + 10 * MINUTE;
    const prisma = makeFakePrisma(
      { chargebeeCustomerId: TENANT, chargebeeSubscriptionId: "sub_1", ledgerUnitId: "token-test", status: ACCOUNT.CANCELLED },
      T0,
    );
    const gate = new Gate();
    const warns: Array<Record<string, unknown>> = [];
    const accounts = createAccountService({
      prisma,
      chargebee: {
        balance: async (subscriptionId: string) => {
          if (subscriptionId === "sub_2") await gate.pass();
          return { unitId: "token-test", unitName: "token-test", usable: "1000", onHold: "0" };
        },
        grantBlocks: async () => ({ blocks: [], complete: true }),
      } as unknown as ChargebeeClient,
      usdPerCredit: "0.001",
      clock: () => now,
      logger: { ...quietLogger, warn: (o: unknown) => void warns.push(o as Record<string, unknown>) },
    });

    // W1 resubscribes the cancelled org to sub_2, and stalls reading its balance.
    const w1 = accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_2", expectedSubscriptionId: "sub_1" });
    await gate.reached;
    // W2 resubscribes it to sub_3 meanwhile: billing restarts at W2's now, and a window is billed.
    await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_3", expectedSubscriptionId: "sub_1" });
    expect(prisma._cursor).toBe(T0 + 10 * MINUTE);
    prisma._accounts.get(TENANT)!.lastProcessedIngestedAt = new Date(T0 + 11 * MINUTE);

    now = T0 + 15 * MINUTE;
    gate.open();
    const after = await w1;

    expect(after).toMatchObject({ chargebeeSubscriptionId: "sub_3", status: ACCOUNT.ACTIVE });
    expect(prisma._cursor).toBe(T0 + 11 * MINUTE); // not jumped to W1's 15 minutes
    expect(warns.filter((w) => w.metric === "billing.cursor.restarted")).toHaveLength(1);
    expect(warns).toContainEqual(expect.objectContaining({ metric: "billing.subscription.link_raced", subscriptionId: "sub_2" }));
  });

  it("a sync of a switching account writes nothing to it, and nothing to its team", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });
    r.prisma._accounts.get(TENANT)!.status = ACCOUNT.SWITCHING;
    const before = { ...r.account() };
    const writes = r.gateway.updates.length;

    await r.deliver(webhook("subscription_changed", r.cb.sub("sub_1")));

    expect(r.account()).toEqual(before);
    expect(r.gateway.updates).toHaveLength(writes);
  });
});

describe("a stale usage pass opens no window pinned where the account no longer bills", () => {
  it("the relink commits while the pass reads its window: nothing opened or sent on A; the next pass bills it on B", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });
    r.llmCall("a:1", T0 + 10_000, 0.1);
    r.llmCall("a:2", T0 + 70_000, 0.1);
    r.at(1);
    const subB = r.cb.subscribe("sub_2", { credits: 0, plan: PLAN_B, start: T0_S + 60 });
    await r.deliver(webhook("subscription_created", subB)); // both active: the account stays on A
    await r.cb.client.allocate({ subscriptionId: "sub_2", unitId: UNIT, amount: "900", expiresAt: T0_S + 3650 * DAY_S, idempotencyKey: "carry:1" });

    // The pass reads the account (on A), then its first window — and while it
    // reads, A is cancelled and the account relinked to B.
    const read = r.usage.readWindow.bind(r.usage);
    let relinked = false;
    r.usage.readWindow = async (slug, range) => {
      const out = await read(slug, range);
      if (!relinked) {
        relinked = true;
        r.cb.cancel("sub_1");
        await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
      }
      return out;
    };

    r.at(3);
    await r.tick();

    expect(r.account().chargebeeSubscriptionId).toBe("sub_2");
    expect(r.prisma._log).toEqual([]);
    expect(r.cb.sent).toEqual([]);
    expect(r.metrics()).toContain("billing.sync.raced");
    expect(r.cursorMin()).toBe(0);

    r.at(4);
    await r.tick();

    const billed = r.prisma._log.map((s: { chargebeeSubscriptionId: string; status: string }) => [s.chargebeeSubscriptionId, s.status]);
    expect(billed).toEqual([
      ["sub_2", "SUCCESS"],
      ["sub_2", "SUCCESS"],
    ]);
    expect(r.cb.sent.map((a) => a.subscriptionId)).toEqual(["sub_2", "sub_2"]);
    expect(r.cb.ledger.taken).toBe(200); // both calls, once each
    expect(r.cursorMin()).toBe(3);
  });
});

describe("linking stores the subscription's currency", () => {
  function service(subscriptions: Array<Record<string, unknown>>, account: Record<string, unknown> = {}) {
    const prisma = makeFakePrisma({ chargebeeCustomerId: TENANT, chargebeeSubscriptionId: null, ledgerUnitId: null, status: "unlinked", ...account } as never);
    const accounts = createAccountService({
      prisma,
      chargebee: {
        activeSubscriptions: async () => subscriptions,
        balance: async () => ({ unitId: "token-test", unitName: "token-test", usable: "1000", onHold: "0" }),
        grantBlocks: async () => ({ blocks: [], complete: true }),
      } as unknown as ChargebeeClient,
      usdPerCredit: "0.001",
      logger: quietLogger,
    });
    return { accounts, prisma };
  }

  it("from Chargebee's currency_code, on every sync", async () => {
    const { accounts, prisma } = service([{ id: "sub_1", currency_code: "USD", subscription_items: [{ item_price_id: "free-usd" }] }]);

    await accounts.syncFromChargebee(TENANT);

    expect(prisma._accounts.get(TENANT)).toMatchObject({ chargebeeSubscriptionId: "sub_1", currency: "USD" });
  });

  it("keeps the stored currency when the subscription record carries none", async () => {
    const { accounts, prisma } = service([{ id: "sub_1" }], { chargebeeSubscriptionId: "sub_1", ledgerUnitId: "token-test", status: "active", currency: "INR" });

    await accounts.syncFromChargebee(TENANT);

    expect(prisma._accounts.get(TENANT)!.currency).toBe("INR");
  });
});

describe("an activation refused over a currency switch hands nothing back", () => {
  it("the switch starts while an activation's push is out: the account stays switching, its team keeps its cap", async () => {
    const prisma = makeFakePrisma({ chargebeeCustomerId: TENANT, chargebeeSubscriptionId: "sub_1", ledgerUnitId: "token-test", status: ACCOUNT.ACTIVE } as never);
    const releaseBudget = vi.fn(async () => {});
    const blockBudget = vi.fn(async () => {});
    const accounts = createAccountService({
      prisma,
      chargebee: { balance: async () => ({ unitId: "token-test", unitName: "token-test", usable: "500", onHold: "0" }) } as unknown as ChargebeeClient,
      usdPerCredit: "0.001",
      pushBudget: async () => {
        prisma._accounts.get(TENANT)!.status = ACCOUNT.SWITCHING; // the currency switch's start, landing meanwhile
      },
      budgetBlocked: async () => true,
      blockBudget,
      releaseBudget,
      logger: quietLogger,
    });

    await accounts.reopenBlockedActive();

    expect(prisma._accounts.get(TENANT)!.status).toBe(ACCOUNT.SWITCHING);
    expect(releaseBudget).not.toHaveBeenCalled();
    expect(blockBudget).not.toHaveBeenCalled();
  });
});

describe("every currency's top-up, wherever packs are looked for", () => {
  const paymentSucceeded = (invoiceId: string, entityIds: string[]) => ({
    id: `ev_${invoiceId}`,
    event_type: "payment_succeeded",
    content: { customer: { id: TENANT }, invoice: { id: invoiceId, line_items: entityIds.map((entity_id) => ({ entity_id })) } },
  });

  function webhooks(applyPaidTopUps: ReturnType<typeof vi.fn>) {
    return createWebhookService({
      accountService: { applyPaidTopUps } as never,
      accounts: { findTenantIdByCustomerId: async () => TENANT } as never,
      topUps: [
        { itemPriceId: "api_token-USD", creditsPerUnit: "50" },
        { itemPriceId: "api_token-INR", creditsPerUnit: "" },
      ],
      chargebeeGrants: true,
      logger: quietLogger,
    });
  }

  it("payment_succeeded records a pack bought in any currency, with that currency's credits per unit", async () => {
    const applyPaidTopUps = vi.fn(async (..._args: unknown[]) => ({ applied: 1, credits: "50" }));

    await webhooks(applyPaidTopUps).handle(paymentSucceeded("inv_1", ["api_token-INR"]));
    expect(applyPaidTopUps.mock.calls).toEqual([[TENANT, "api_token-INR", "", { chargebeeGrants: true }]]);

    applyPaidTopUps.mockClear();
    await webhooks(applyPaidTopUps).handle(paymentSucceeded("inv_2", ["api_token-USD", "api_token-INR"]));
    expect(applyPaidTopUps.mock.calls.map((c) => c[1])).toEqual(["api_token-USD", "api_token-INR"]);
  });

  it("payment_succeeded for anything else records nothing; a grant not yet visible is failed for redelivery", async () => {
    const applyPaidTopUps = vi.fn(async () => ({ applied: 0, credits: "0", pending: ["inv_3"] }));

    await webhooks(applyPaidTopUps).handle(paymentSucceeded("inv_9", ["plan-USD"]));
    expect(applyPaidTopUps).not.toHaveBeenCalled();

    await expect(webhooks(applyPaidTopUps).handle(paymentSucceeded("inv_3", ["api_token-USD"]))).rejects.toThrow(/not visible yet/);
  });

  function checkout(catalog = BOTH, chargebee: Record<string, unknown> = {}, applyPaidTopUps = vi.fn()) {
    // A US org on a USD subscription, address confirmed — no pack is sold before.
    const prisma = makeFakePrisma({
      chargebeeCustomerId: TENANT,
      chargebeeSubscriptionId: "sub_1",
      ledgerUnitId: "token-test",
      status: "active",
      billingCountry: "US",
      currency: "USD",
    } as never);
    return createCheckoutService({
      chargebee: chargebee as unknown as ChargebeeClient,
      accountService: { applyPaidTopUps } as never,
      accounts: createBillingAccountRepository(prisma),
      itemPriceIds: [],
      defaultItemPriceId: "paid-monthly",
      catalog,
      topUpChargebeeGrants: true,
      logger: quietLogger,
    });
  }

  it("checkout's apply records every currency's packs, totalled", async () => {
    const applyPaidTopUps = vi.fn(async (_t: string, itemPriceId: string) =>
      itemPriceId === "api_token-USD" ? { applied: 1, credits: "50", pending: ["inv_7"] } : { applied: 2, credits: "100.5" },
    );

    expect(await checkout(BOTH, {}, applyPaidTopUps).applyTopUps(TENANT)).toEqual({ applied: 3, credits: "150.5", pending: ["inv_7"] });
    expect(applyPaidTopUps.mock.calls).toEqual([
      [TENANT, "api_token-USD", "50", { chargebeeGrants: true }],
      [TENANT, "api_token-INR", "", { chargebeeGrants: true }],
    ]);
  });

  it("with no top-up configured, apply records nothing, and a top-up is refused before Chargebee is asked anything", async () => {
    const none = currencyCatalog(RULES, {});
    const applyPaidTopUps = vi.fn();
    const unpaidInvoicesFor = vi.fn(async () => []);

    expect(await checkout(none, {}, applyPaidTopUps).applyTopUps(TENANT)).toEqual({ applied: 0, credits: "0" });
    expect(applyPaidTopUps).not.toHaveBeenCalled();

    const err = await checkout(none, { unpaidInvoicesFor }).startTopUp(TENANT, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect([(err as AppError).kind, (err as AppError).code]).toEqual(["conflict", "topup-not-offered"]);
    expect(unpaidInvoicesFor).not.toHaveBeenCalled();
  });

  it("one unpaid pack at a time, in ANY currency", async () => {
    const unpaidInvoicesFor = vi.fn(async () => [{ id: "inv_old" }]);

    const err = await checkout(BOTH, { unpaidInvoicesFor }).startTopUp(TENANT, 1).catch((e: unknown) => e);

    expect((err as AppError).code).toBe("topup-unpaid");
    expect(unpaidInvoicesFor).toHaveBeenCalledWith(TENANT, ["api_token-USD", "api_token-INR"]);
  });

  it("the gateway cap holds back unpaid packs of every currency — and asks nothing with no top-up configured", async () => {
    const account = { chargebeeCustomerId: TENANT, chargebeeSubscriptionId: "sub_1", ledgerUnitId: "token-test" };
    const unpaidTopUpCredits = vi.fn(async () => "100");
    const chargebee = { grantedCredits: async () => ({ credits: "1000", blocks: 1 }), unpaidTopUpCredits };

    expect(await paidGrantedCredits(chargebee, account as never, ["api_token-USD", "api_token-INR"])).toBe("900");
    expect(unpaidTopUpCredits).toHaveBeenCalledWith(expect.objectContaining({ itemPriceId: ["api_token-USD", "api_token-INR"] }));

    unpaidTopUpCredits.mockClear();
    expect(await paidGrantedCredits(chargebee, account as never, [])).toBe("1000");
    expect(unpaidTopUpCredits).not.toHaveBeenCalled();
  });
});
