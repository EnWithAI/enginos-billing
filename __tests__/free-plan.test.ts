/**
 * The free plan, with no checkout and no card, for every org it is for:
 * enginos-platform asks once the org exists, and the billing page asks again
 * for any org that still has no subscription. Safe to ask any number of times,
 * and never for a plan that costs money.
 *
 * Who it is for is per org (billing_account.free_plan), falling back to
 * FREE_PLAN_DEFAULT — off unless configured. An org it is not for is offered
 * the paid plans instead.
 */

import { describe, expect, it, vi } from "vitest";

import type { ChargebeeClient } from "@/integrations/chargebee";
import { createBillingAccountRepository } from "@/repositories/billing-account.repository";
import { createChargebeeSyncRepository } from "@/repositories/chargebee-sync.repository";
import { createBillingOverviewService } from "@/services/billing-overview.service";
import { createCheckoutService } from "@/services/checkout.service";
import { AppError } from "@/shared/errors";

import { TENANT, makeFakePrisma, quietLogger } from "./harness";

const FREE = "free-yearly";

function rig(
  over: Partial<ChargebeeClient> = {},
  account: Record<string, unknown> = {},
  opts: { freeItemPriceId?: string; itemPriceIds?: string[]; freePlanDefault?: boolean } = {},
) {
  const prisma = makeFakePrisma({ chargebeeCustomerId: TENANT, chargebeeSubscriptionId: null, ...account } as never);
  const accounts = createBillingAccountRepository(prisma as never);
  const chargebee = {
    activeSubscriptions: vi.fn(async () => []),
    itemPrice: vi.fn(async () => ({ id: FREE, name: "Free", priceMinor: 0, currencyCode: "INR", period: 1, periodUnit: "year" })),
    subscribeCustomer: vi.fn(async () => ({ id: "sub_free" })),
    ...over,
  } as unknown as ChargebeeClient & Record<string, ReturnType<typeof vi.fn>>;
  const accountService = {
    ensureLocalAccount: vi.fn(async (tenantId: string) => accounts.findByTenantId(tenantId)),
    ensureCustomer: vi.fn(async () => ({ tenantId: TENANT, chargebeeCustomerId: TENANT })),
    bootstrapFromTenant: vi.fn(async () => ({ tenantId: TENANT, chargebeeCustomerId: TENANT })),
    syncFromChargebee: vi.fn(async () => ({ chargebeeSubscriptionId: "sub_free", status: "active", ledgerUnitId: "token-test" })),
  };
  const sleep = vi.fn(async () => {});
  const checkout = createCheckoutService({
    chargebee,
    accountService: accountService as never,
    accounts,
    itemPriceIds: opts.itemPriceIds ?? [FREE, "paid-monthly"],
    defaultItemPriceId: "paid-monthly",
    freeItemPriceId: opts.freeItemPriceId ?? FREE,
    // On unless a test says otherwise: most of this file is about the org the
    // free plan IS for. The production default is off (config.ts).
    freePlanDefault: opts.freePlanDefault ?? true,
    checkoutRedirectUrl: "https://app.test/organization/billing?from=checkout",
    topUpItemPriceId: "pack",
    topUpCredits: "50",
    logger: quietLogger,
    sleep,
  });
  return { checkout, chargebee, accountService, prisma, accounts, sleep };
}

async function refusal(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

describe("putting an org on the free plan", () => {
  it("subscribes an org with no subscription — no card — under a per-tenant idempotency key, then links it", async () => {
    const r = rig();

    expect(await r.checkout.provisionFreePlan(TENANT)).toEqual({ status: "subscribed", subscriptionId: "sub_free" });
    expect(r.chargebee.subscribeCustomer).toHaveBeenCalledWith({
      customerId: TENANT,
      itemPriceId: FREE,
      idempotencyKey: `free-plan:${TENANT}`,
    });
    expect(r.accountService.syncFromChargebee).toHaveBeenCalledWith(TENANT);
  });

  it("waits for Chargebee's credit ledger before calling the org set up — the usage sync skips an account with no unit", async () => {
    const r = rig();
    r.accountService.syncFromChargebee
      .mockResolvedValueOnce({ chargebeeSubscriptionId: "sub_free", status: "active", ledgerUnitId: null } as never)
      .mockResolvedValueOnce({ chargebeeSubscriptionId: "sub_free", status: "active", ledgerUnitId: null } as never)
      .mockResolvedValueOnce({ chargebeeSubscriptionId: "sub_free", status: "active", ledgerUnitId: "token-test" } as never);

    expect(await r.checkout.provisionFreePlan(TENANT)).toEqual({ status: "subscribed", subscriptionId: "sub_free" });
    expect(r.accountService.syncFromChargebee).toHaveBeenCalledTimes(3);
    expect(r.sleep).toHaveBeenCalledTimes(2);
  });

  it("stops waiting after a bounded time, leaving the unit to a later sync", async () => {
    const r = rig();
    r.accountService.syncFromChargebee.mockResolvedValue({
      chargebeeSubscriptionId: "sub_free",
      status: "active",
      ledgerUnitId: null,
    } as never);

    expect(await r.checkout.provisionFreePlan(TENANT)).toMatchObject({ status: "subscribed" });
    expect(r.accountService.syncFromChargebee).toHaveBeenCalledTimes(10);
    expect(r.sleep).toHaveBeenCalledTimes(9);
  });

  it("leaves an org that already has a subscription alone — live or cancelled — and asks Chargebee nothing", async () => {
    const r = rig({}, { chargebeeSubscriptionId: "sub_paid", status: "cancelled" });

    expect(await r.checkout.provisionFreePlan(TENANT)).toEqual({ status: "already-subscribed", subscriptionId: "sub_paid" });
    expect(r.chargebee.activeSubscriptions).not.toHaveBeenCalled();
    expect(r.chargebee.subscribeCustomer).not.toHaveBeenCalled();
  });

  it("links a subscription Chargebee already holds instead of creating a second", async () => {
    const r = rig({ activeSubscriptions: vi.fn(async () => [{ id: "sub_earlier" }]) as never });

    expect(await r.checkout.provisionFreePlan(TENANT)).toMatchObject({ status: "linked" });
    expect(r.chargebee.subscribeCustomer).not.toHaveBeenCalled();
    expect(r.accountService.syncFromChargebee).toHaveBeenCalledWith(TENANT);
  });

  it("never subscribes a card-less customer to a plan that costs money", async () => {
    const r = rig({
      itemPrice: vi.fn(async () => ({ id: FREE, name: "Oops", priceMinor: 10000, currencyCode: "INR", period: 1, periodUnit: "year" })) as never,
    });

    const err = await refusal(r.checkout.provisionFreePlan(TENANT));
    expect([err.kind, err.code]).toEqual(["conflict", "free-plan-misconfigured"]);
    expect(r.chargebee.subscribeCustomer).not.toHaveBeenCalled();
  });

  it("refuses a free plan outside ITEM_PRICE_IDS — the linking step would never reach it", async () => {
    const r = rig({}, {}, { itemPriceIds: ["paid-monthly"] });

    const err = await refusal(r.checkout.provisionFreePlan(TENANT));
    expect(err.code).toBe("free-plan-misconfigured");
    expect(r.chargebee.subscribeCustomer).not.toHaveBeenCalled();
  });

  it("does nothing when no free plan is configured", async () => {
    const err = await refusal(rig({}, {}, { freeItemPriceId: "" }).checkout.provisionFreePlan(TENANT));
    expect(err.code).toBe("free-plan-not-configured");
  });

  it("a create that lost a race to another call is settled by looking again", async () => {
    const activeSubscriptions = vi.fn(async () => [] as unknown[]);
    activeSubscriptions.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "sub_other_call" }]);
    const r = rig({
      activeSubscriptions: activeSubscriptions as never,
      subscribeCustomer: vi.fn(async () => {
        throw new Error("request in progress");
      }) as never,
    });

    expect(await r.checkout.provisionFreePlan(TENANT)).toMatchObject({ status: "subscribed" });
    expect(r.accountService.syncFromChargebee).toHaveBeenCalledWith(TENANT);
  });

  it("a create that failed with nothing to show for it fails the call", async () => {
    const r = rig({
      subscribeCustomer: vi.fn(async () => {
        throw new Error("Chargebee down");
      }) as never,
    });

    await expect(r.checkout.provisionFreePlan(TENANT)).rejects.toThrow("Chargebee down");
    expect(r.accountService.syncFromChargebee).not.toHaveBeenCalled();
  });
});

describe("which org the free plan is for", () => {
  it("is off by default: the org still gets its Chargebee customer at onboarding, but no subscription", async () => {
    const r = rig({}, {}, { freePlanDefault: false });

    expect(await r.checkout.provisionFreePlan(TENANT, { billingEmail: "admin@acme.test" })).toEqual({
      status: "not-eligible",
      subscriptionId: null,
      customerId: TENANT,
    });
    expect(r.accountService.ensureCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, billingEmail: "admin@acme.test" }),
    );
    expect(r.chargebee.activeSubscriptions).not.toHaveBeenCalled();
    expect(r.chargebee.subscribeCustomer).not.toHaveBeenCalled();
  });

  it("a brand-new org with no billing row yet gets one, and its customer, from the platform's own record", async () => {
    const r = rig({}, {}, { freePlanDefault: false });

    expect(await r.checkout.provisionFreePlan("new-tenant", { billingEmail: "admin@new.test" })).toMatchObject({
      status: "not-eligible",
    });
    expect(r.accountService.bootstrapFromTenant).toHaveBeenCalledWith("new-tenant", "admin@new.test");
  });

  it("the admin email fills a billing contact that is missing, and never replaces one", async () => {
    const r = rig({}, { billingEmail: "billing@acme.test" }, { freePlanDefault: false });

    await r.checkout.provisionFreePlan(TENANT, { billingEmail: "admin@acme.test" });
    expect(r.accountService.ensureCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ billingEmail: "billing@acme.test" }),
    );
  });

  it("an org's own setting wins over the default, either way", async () => {
    const on = rig({}, { freePlan: true }, { freePlanDefault: false });
    expect(await on.checkout.provisionFreePlan(TENANT)).toMatchObject({ status: "subscribed" });

    const off = rig({}, { freePlan: false }, { freePlanDefault: true });
    expect(await off.checkout.provisionFreePlan(TENANT)).toMatchObject({ status: "not-eligible" });
    expect(off.chargebee.subscribeCustomer).not.toHaveBeenCalled();
  });

  it("checkout sells the paid plans to an org the free plan is not for — and never the free plan itself", async () => {
    const checkoutPage = vi.fn(async () => ({ id: "hp_1", url: "https://cb.test/hp_1" }));
    const r = rig({ checkoutPage: checkoutPage as never }, {}, { freePlanDefault: false });

    const err = await refusal(r.checkout.startSubscription(TENANT, FREE));
    expect([err.kind, err.code]).toEqual(["invalid", "plan-not-offered"]);
    expect(checkoutPage).not.toHaveBeenCalled();

    await r.checkout.startSubscription(TENANT, "paid-monthly");
    expect(checkoutPage).toHaveBeenCalledWith({
      customerId: TENANT,
      itemPriceId: "paid-monthly",
      redirectUrl: "https://app.test/organization/billing?from=checkout",
    });
  });

  it("an operator turning it ON puts an org with no subscription on it at once", async () => {
    const r = rig({}, {}, { freePlanDefault: false });

    expect(await r.checkout.setFreePlan(TENANT, true)).toMatchObject({
      freePlan: true,
      provisioned: { status: "subscribed", subscriptionId: "sub_free" },
    });
    expect(r.prisma._accounts.get(TENANT)!.freePlan).toBe(true);
    expect(r.chargebee.subscribeCustomer).toHaveBeenCalledTimes(1);
  });

  it("an operator turning it OFF leaves an org already on the free plan subscribed", async () => {
    const r = rig({}, { chargebeeSubscriptionId: "sub_free", status: "active" }, { freePlanDefault: true });

    expect(await r.checkout.setFreePlan(TENANT, false)).toEqual({ tenantId: TENANT, freePlan: false, subscriptionId: "sub_free" });
    expect(r.prisma._accounts.get(TENANT)).toMatchObject({ freePlan: false, chargebeeSubscriptionId: "sub_free", status: "active" });
    expect(r.chargebee.activeSubscriptions).not.toHaveBeenCalled();
    expect(r.chargebee.subscribeCustomer).not.toHaveBeenCalled();
  });

  it("refuses a tenant the platform does not know", async () => {
    const r = rig();
    r.accountService.ensureLocalAccount.mockResolvedValueOnce(null as never);

    const err = await refusal(r.checkout.setFreePlan("no-such-tenant", true));
    expect([err.kind, err.code]).toEqual(["not_found", "no-tenant"]);
  });
});

describe("the billing page as the fallback", () => {
  function overview(
    account: Record<string, unknown>,
    autoSubscribe: (tenantId: string) => Promise<unknown>,
    freePlanDefault = true,
  ) {
    const prisma = makeFakePrisma({ chargebeeCustomerId: TENANT, status: "unlinked", ...account } as never);
    const accounts = createBillingAccountRepository(prisma as never);
    const service = createBillingOverviewService({
      chargebee: {
        transactionsPage: async () => ({ transactions: [], nextOffset: null }),
        subscription: async () => null,
        paymentSource: async () => null,
        balance: async () => null,
        grantedCredits: async () => ({ credits: "0" }),
      } as unknown as ChargebeeClient,
      accountService: { ensureLocalAccount: (t: string) => accounts.findByTenantId(t) } as never,
      accounts,
      syncs: createChargebeeSyncRepository(prisma as never),
      plansOffered: async () => [plan(FREE), plan("paid-monthly")],
      autoSubscribe,
      freeItemPriceId: FREE,
      freePlanDefault,
      logger: quietLogger,
    });
    return { service, prisma };
  }

  function plan(itemPriceId: string) {
    return { itemPriceId, name: itemPriceId, priceMinor: 0, currencyCode: "INR", period: 1, periodUnit: "month", resolved: true };
  }

  it("offers an org the free plan is not for the paid plans, and does not try to subscribe it", async () => {
    const autoSubscribe = vi.fn(async () => undefined);
    const { service } = overview({ chargebeeSubscriptionId: null }, autoSubscribe, false);

    const page = await service.overview(TENANT);

    expect(autoSubscribe).not.toHaveBeenCalled();
    expect(page.freePlan).toBe(false);
    expect(page.plansOffered.map((p) => p.itemPriceId)).toEqual(["paid-monthly"]);
  });

  it("still lists the free plan for an org already on it, so the page can name its plan", async () => {
    const { service } = overview(
      { chargebeeSubscriptionId: "sub_free", chargebeeItemPriceId: FREE, status: "active", freePlan: false },
      vi.fn(async () => undefined),
      true,
    );

    const page = await service.overview(TENANT);

    expect(page.freePlan).toBe(false);
    expect(page.plansOffered.map((p) => p.itemPriceId)).toEqual([FREE, "paid-monthly"]);
  });

  it("puts an org with no subscription on the free plan before rendering", async () => {
    const autoSubscribe = vi.fn(async () => undefined);
    const { service } = overview({ chargebeeSubscriptionId: null }, autoSubscribe);

    await service.overview(TENANT);

    expect(autoSubscribe).toHaveBeenCalledWith(TENANT);
  });

  it("does not ask for an org that already has a subscription", async () => {
    const autoSubscribe = vi.fn(async () => undefined);
    const { service } = overview({ chargebeeSubscriptionId: "sub_1", status: "active" }, autoSubscribe);

    await service.overview(TENANT);

    expect(autoSubscribe).not.toHaveBeenCalled();
  });

  it("renders the org unsubscribed when the free plan could not be set up — the page never fails for it", async () => {
    const { service } = overview({ chargebeeSubscriptionId: null }, async () => {
      throw new Error("Chargebee down");
    });

    const page = await service.overview(TENANT);

    expect(page.kind).toBe("linked");
    if (page.kind === "linked") expect(page.account.chargebeeSubscriptionId).toBeNull();
  });
});
