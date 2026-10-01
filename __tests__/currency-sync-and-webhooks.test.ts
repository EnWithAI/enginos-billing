/**
 * What runs beside a currency switch, and what records packs in any currency.
 *
 *   THE USAGE SYNC reads nothing new and sends nothing while the account is
 *   `switching` — the fast path in front of the repository's own refusals —
 *   and stops after a recovery if a switch started during it.
 *
 *   A PAID PACK while the credits are moving is not allocated — it would land
 *   on the subscription being emptied — and nothing is activated; a pack
 *   Chargebee granted itself is still recorded (the switch's rescan carries
 *   its block). One granted on a subscription the org has left is recorded,
 *   and raised for a person.
 *
 *   WEBHOOKS record a pack paid in USD as in INR; and a pack's grant block
 *   still missing ten minutes after payment is an error, not a warning
 *   repeated for ever (A19). (`customer_changed` syncs the billing address:
 *   billing-address.test.ts.)
 */

import { describe, expect, it } from "vitest";

import { ACCOUNT } from "@/models/account-status";
import { createBillingAccountRepository } from "@/repositories/billing-account.repository";
import { createUsageSyncService, OUTCOME } from "@/services/usage-sync.service";
import { createWebhookService } from "@/services/webhook.service";

import {
  PACK,
  UNIT,
  USD_FREE,
  lifecycleRig,
  webhook,
  type LifecycleRig,
} from "./failure-matrix-lifecycle-webhooks-litellm.helpers";
import { FakeChargebee, FakeUsageSource, MINUTE, RATE, SLUG, T0, TENANT, makeFakePrisma, quietLogger } from "./harness";

describe("the usage sync while a currency switch moves the credits", () => {
  function syncing(account: Record<string, unknown>) {
    const prisma = makeFakePrisma({ status: ACCOUNT.SWITCHING, ...account }, T0);
    const usage = new FakeUsageSource();
    usage.add("call:1", T0 + 10_000, 0.5);
    usage.nowMs = T0 + 5 * MINUTE;
    const chargebee = new FakeChargebee(1000);
    const warns: Array<Record<string, unknown>> = [];
    const sync = createUsageSyncService({
      prisma: prisma as never,
      usage,
      chargebee,
      usdPerCredit: RATE,
      lagMs: MINUTE,
      clock: () => usage.nowMs,
      logger: { ...quietLogger, warn: (o: unknown) => void warns.push(o as Record<string, unknown>) },
    });
    return { prisma, usage, chargebee, sync, warns };
  }

  it("reads no window and sends no capture: the usage waits in front of a cursor that does not move", async () => {
    const r = syncing({});

    expect(await r.sync.runTenant(SLUG)).toEqual({ tenantSlug: SLUG, outcome: OUTCOME.NOT_BILLABLE, reason: "currency switch in progress" });

    expect(r.usage.reads).toEqual([]);
    expect(r.chargebee.captures).toEqual([]);
    expect(r.prisma._log).toEqual([]);
    expect(r.prisma._cursor).toBe(T0);
  });

  it("leaves a held window where it is — it could not be sent — without a refused claim warned about every minute", async () => {
    const r = syncing({});
    await r.prisma.chargebeeSync.create({
      data: {
        tenantId: TENANT,
        chargebeeSubscriptionId: "sub_1",
        ledgerUnitId: "token",
        fromIngestedAt: new Date(T0),
        toIngestedAt: new Date(T0 + MINUTE),
        eventCount: 1,
        amount: "500",
        billedUsd: "0.5",
        status: "PENDING",
        error: null,
        settledAt: null,
        hatchetRunId: null,
      },
    });

    expect((await r.sync.runTenant(SLUG)).outcome).toBe(OUTCOME.NOT_BILLABLE);

    expect(r.prisma._stuck).toMatchObject({ status: "PENDING", attemptCount: 0 });
    expect(r.chargebee.captures).toEqual([]);
    expect(r.warns.map((w) => w.metric)).not.toContain("billing.sync.raced");
  });

  it("a switch that starts while a held window is recovered: that window is settled, and nothing new is read", async () => {
    const r = syncing({ status: ACCOUNT.ACTIVE });
    await r.prisma.chargebeeSync.create({
      data: {
        tenantId: TENANT,
        chargebeeSubscriptionId: "sub_1",
        ledgerUnitId: "token",
        fromIngestedAt: new Date(T0),
        toIngestedAt: new Date(T0 + MINUTE),
        eventCount: 1,
        amount: "500",
        billedUsd: "0.5",
        status: "PENDING",
        error: null,
        settledAt: null,
        hatchetRunId: null,
      },
    });
    // The switch starts once the window is on the wire (its claim committed first).
    const capture = r.chargebee.capture.bind(r.chargebee);
    r.chargebee.capture = async (args) => {
      r.prisma._accounts.get(TENANT)!.status = ACCOUNT.SWITCHING;
      return capture(args);
    };

    const result = await r.sync.runTenant(SLUG);

    expect(result).toMatchObject({ outcome: OUTCOME.SYNCED, syncId: expect.any(String) });
    expect(r.prisma._log.map((s: { status: string }) => s.status)).toEqual(["SUCCESS"]);
    expect(r.usage.reads).toEqual([]);
    expect(r.prisma._cursor).toBe(T0 + MINUTE);
  });
});

describe("a pack paid while a currency switch moves the credits", () => {
  async function switching() {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });
    r.prisma._accounts.get(TENANT)!.status = ACCOUNT.SWITCHING;
    return r;
  }

  it("is not allocated — it would land on the subscription being emptied — and nothing is activated: pending, for after the switch", async () => {
    const r = await switching();
    r.cb.payPack("inv_1", 2);
    const writes = r.gateway.updates.length;

    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "1000")).toEqual({ applied: 0, credits: "0", pending: ["inv_1"] });

    expect(r.cb.allocateCalls).toEqual([]);
    expect(r.prisma._topUps.size).toBe(0);
    expect(r.gateway.updates).toHaveLength(writes);
    expect(r.account().status).toBe(ACCOUNT.SWITCHING);
    expect(r.metrics()).toContain("billing.topup.deferred_switching");

    // The switch done: the next apply grants it, once.
    r.prisma._accounts.get(TENANT)!.status = ACCOUNT.ACTIVE;
    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "1000")).toEqual({ applied: 1, credits: "2000" });
    expect(r.cb.allocateCalls).toHaveLength(1);
  });

  it("one Chargebee granted itself is recorded — its block stays where the switch's rescan finds it — and still nothing is activated", async () => {
    const r = await switching();
    r.cb.payPackWithGrant("inv_2", { credits: 50 });
    const writes = r.gateway.updates.length;

    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "", { chargebeeGrants: true })).toEqual({ applied: 1, credits: "50" });

    expect([...r.prisma._topUps.values()]).toEqual([expect.objectContaining({ invoiceId: "inv_2", source: "catalogue_grant", status: "APPLIED" })]);
    expect(r.cb.allocateCalls).toEqual([]);
    expect(r.gateway.updates).toHaveLength(writes);
    expect(r.account().status).toBe(ACCOUNT.SWITCHING);
  });

  it("a payment_succeeded for it is failed for redelivery — it arrives again once the switch has finished", async () => {
    const r = await switching();
    r.cb.payPack("inv_1");

    await expect(
      r.deliver({ id: "ev_1", event_type: "payment_succeeded", content: { customer: { id: TENANT }, invoice: { id: "inv_1", line_items: [{ entity_id: PACK }] } } }),
    ).rejects.toThrow(/not visible yet/);
    expect(r.cb.allocateCalls).toEqual([]);
  });
});

describe("a pack granted on a subscription the org has left", () => {
  it("is recorded — never granted twice — and raised as an error naming where the credits sit", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });
    // The org moves to sub_2 (a resubscription, or a currency switch).
    r.cb.cancel("sub_1");
    r.cb.subscribe("sub_2", { credits: 1000 });
    await r.deliver(webhook("subscription_cancelled", r.cb.sub("sub_1")));
    expect(r.account().chargebeeSubscriptionId).toBe("sub_2");
    // A pack paid on sub_1 while the org was moving, granted there by Chargebee.
    r.cb.payPackWithGrant("inv_late", { subscriptionId: "sub_1", credits: 50 });

    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "", { chargebeeGrants: true })).toEqual({ applied: 1, credits: "50" });
    expect(r.errors).toContainEqual(
      expect.objectContaining({
        metric: "billing.topup.granted_to_previous_subscription",
        invoiceId: "inv_late",
        grantedOn: ["sub_1"],
        linkedSubscriptionId: "sub_2",
        credits: "50",
      }),
    );

    // Recorded once: a second apply records nothing, and raises nothing new.
    const raised = r.errors.length;
    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "", { chargebeeGrants: true })).toEqual({ applied: 0, credits: "0" });
    expect(r.errors).toHaveLength(raised);
  });
});

describe("webhooks, in any currency", () => {
  it("payment_succeeded for a USD pack records it with the USD pack's credits per unit", async () => {
    const r = lifecycleRig();
    await r.subscribe("sub_1", { plan: USD_FREE, credits: 1000 });
    const webhooks = createWebhookService({
      accountService: r.accounts,
      accounts: createBillingAccountRepository(r.prisma as never),
      topUps: [
        { itemPriceId: "api_token-USD", creditsPerUnit: "50" },
        { itemPriceId: "api_token-INR", creditsPerUnit: "40" },
      ],
      logger: quietLogger,
    });
    r.cb.paidInvoices.push({ id: "inv_usd", paid_at: Math.floor(T0 / 1000), line_items: [{ id: "li_usd", entity_id: "api_token-USD", quantity: 2 }] });

    await webhooks.handle({
      id: "ev_usd",
      event_type: "payment_succeeded",
      content: { customer: { id: TENANT }, invoice: { id: "inv_usd", line_items: [{ entity_id: "api_token-USD" }] } },
    });

    expect([...r.prisma._topUps.values()]).toEqual([expect.objectContaining({ invoiceId: "inv_usd", credits: "100", status: "APPLIED" })]);
    expect(r.cb.allocateCalls).toEqual([expect.objectContaining({ subscriptionId: "sub_1", unitId: UNIT, amount: "100" })]);
    expect(r.account().currency).toBe("USD");
  });

  it("a pack's grant block still missing ten minutes after payment is an error a person is alerted to — not another warning (A19)", async () => {
    const r: LifecycleRig = lifecycleRig();
    await r.subscribe("sub_1", { credits: 1000 });
    r.cb.payPackWithGrant("inv_9", { credits: 50 });
    r.cb.blocks.pop(); // paid at T0; Chargebee's block never appears

    await r.accounts.applyPaidTopUps(TENANT, PACK, "", { chargebeeGrants: true });
    expect(r.warns).toContainEqual(expect.objectContaining({ metric: "billing.topup.grant_not_visible", invoiceId: "inv_9" }));
    expect(r.errors.map((e) => e.metric)).not.toContain("billing.topup.grant_not_visible");

    r.at(11);
    await r.accounts.applyPaidTopUps(TENANT, PACK, "", { chargebeeGrants: true });
    expect(r.errors).toContainEqual(expect.objectContaining({ metric: "billing.topup.grant_not_visible", invoiceId: "inv_9" }));
  });
});
