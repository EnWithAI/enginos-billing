/**
 * The account lifecycle: linking a subscription, renewing it, and what happens
 * when Chargebee or the gateway fails part-way.
 */

import { describe, expect, it } from "vitest";

import { createAccountService } from "@/services/account.service";
import { TENANT, SLUG, makeFakePrisma, quietLogger } from "./harness";

const RATE = "0.001";

function fakeChargebee(over: Record<string, unknown> = {}) {
  return {
    createCustomer: async ({ id }: { id: string }) => ({ id }),
    balance: async () => ({ unitId: "token-test", unitName: "token-test", usable: "1000", onHold: "0" }),
    grantedCredits: async () => ({ credits: "1000", blocks: 1 }),
    capture: async () => ({ kind: "captured" as const }),
    captureIdempotent: async () => ({ kind: "captured" as const }),
    findOperation: async () => null,
    ledgerOperations: async () => [],
    allocate: async () => ({ operationId: "op_1", balanceAfter: null }),
    paidInvoicesFor: async () => [],
    subscription: async () => null,
    customer: async (id: string) => ({ id }),
    subscriptionIdsOf: async () => [],
    checkoutPage: async () => ({}),
    portalSession: async () => ({}),
    ...over,
  };
}

describe("account lifecycle", () => {
  const build = (prisma: unknown, over: Record<string, unknown> = {}, chargebeeOver: Record<string, unknown> = {}) =>
    createAccountService({
      prisma: prisma as never,
      chargebee: fakeChargebee(chargebeeOver) as never,
      usdPerCredit: RATE,
      logger: quietLogger,
      ...over,
    });

  it("links the subscription, stores the credit unit, and starts the usage cursor", async () => {
    const prisma = makeFakePrisma({ chargebeeSubscriptionId: null, ledgerUnitId: null });
    const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);

    const account = await build(prisma, { clock: () => NOW }).syncSubscription({
      tenantId: TENANT,
      subscriptionId: "sub_1",
      itemPriceId: "plan-monthly",
    });

    expect(account.chargebeeSubscriptionId).toBe("sub_1");
    expect(account.ledgerUnitId).toBe("token-test");
    // The credits themselves are NOT copied here. There is no granted_credits
    // column and no ledger entry: Chargebee holds the grant, and the gateway
    // cap is computed from it at push time.
    expect(account).not.toHaveProperty("grantedCredits");
    // THE activation point: billing starts now, never from ClickHouse's 90 days.
    expect(prisma._cursor).toBe(NOW);
  });

  it("converges rather than compounding when the webhook and the pull both fire", async () => {
    // This needed an idempotency key when a grant entry was written. It needs
    // none now: every run READS Chargebee and applies what it says.
    const prisma = makeFakePrisma({ chargebeeSubscriptionId: null, ledgerUnitId: null });
    const accounts = build(prisma);

    await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1" });
    const cursorAfterFirst = prisma._cursor;

    await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1" });
    await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1" });

    expect(prisma._accounts.get(TENANT)!.chargebeeSubscriptionId).toBe("sub_1");
    // And, critically, the cursor did not restart — which would have skipped
    // every span ingested between the calls.
    expect(prisma._cursor).toBe(cursorAfterFirst);
  });

  it("a renewal re-reads Chargebee without rewinding or skipping the cursor", async () => {
    const prisma = makeFakePrisma({ chargebeeSubscriptionId: null, ledgerUnitId: null });
    const accounts = build(prisma);

    await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", termStart: new Date(1000) });
    // A minute of usage is billed, then the term rolls over.
    prisma._accounts.get(TENANT)!.lastProcessedIngestedAt = new Date(Date.UTC(2026, 8, 21, 9, 5, 0));
    const before = prisma._cursor;

    await accounts.renew({ tenantId: TENANT, subscriptionId: "sub_1", termStart: new Date(2000) });

    expect(prisma._accounts.get(TENANT)!.currentTermStart).toEqual(new Date(2000));
    expect(prisma._cursor).toBe(before);
    // The old term's credits are expired BY CHARGEBEE, which is why there is no
    // expiry entry to write here any more — grantedCredits() excludes blocks it
    // no longer reports as live, and the cap follows.
  });

  it("holds the account activating and blocks the team when the budget push fails", async () => {
    const prisma = makeFakePrisma({ chargebeeSubscriptionId: null, ledgerUnitId: null });
    const pushed: string[] = [];
    const blocked: string[] = [];

    const account = await build(prisma, {
      pushBudget: async (tenantId: string) => {
        pushed.push(tenantId);
        throw new Error("gateway unreachable");
      },
      blockBudget: async (tenantId: string) => void blocked.push(tenantId),
    }).syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1" });

    // Fail closed: the customer has paid, but the gateway would otherwise
    // enforce a budget nobody computed. Nothing is lost — the credits are in
    // Chargebee and the minute retry tries again.
    expect(pushed).toEqual([TENANT]);
    expect(blocked).toEqual([TENANT]);
    expect(account.status).toBe("activating");
    // The cursor still exists, so no usage accrues unbilled while it is held.
    expect(prisma._cursor).toBeDefined();
  });

  it("leaves the account unlinked when Chargebee cannot create the customer", async () => {
    const prisma = makeFakePrisma();

    // Onboarding must not block on Chargebee, but the failure has to be
    // RECORDED — an unlinked row is a work item, a missing row is invisible.
    const account = await build(prisma, {}, {
      createCustomer: async () => {
        throw new Error("chargebee down");
      },
    }).ensureCustomer({ tenantId: TENANT, routingSlug: SLUG, billingEmail: "a@b.com" });

    expect(account.chargebeeCustomerId).toBeFalsy();
  });

  it("treats a subscription with no prepaid ledger as unbillable rather than throwing", async () => {
    const prisma = makeFakePrisma({ chargebeeSubscriptionId: null, ledgerUnitId: null });

    const account = await build(prisma, {}, { balance: async () => null }).syncSubscription({
      tenantId: TENANT,
      subscriptionId: "sub_1",
    });

    // Linked but with no unit: the usage sync refuses it as not billable
    // instead of sending a capture that Chargebee could only reject.
    expect(account.chargebeeSubscriptionId).toBe("sub_1");
    expect(account.ledgerUnitId).toBeNull();
  });
});
