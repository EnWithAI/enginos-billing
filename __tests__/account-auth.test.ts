/**
 * Auth guards and the account lifecycle.
 *
 * The webhook password is the ONLY thing in front of an endpoint that grants
 * credits — Chargebee does not sign its webhooks — so those checks get the same
 * scrutiny as the money maths.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { createAccounts } from "@/lib/account";
import { ENTRY } from "@/lib/db";
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
    subscription: async () => null,
    checkoutPage: async () => ({}),
    portalSession: async () => ({}),
    ...over,
  };
}

describe("auth guards", () => {
  beforeEach(() => {
    process.env.CHARGEBEE_SITE = "test-site";
    process.env.CHARGEBEE_API_KEY = "test_key";
    process.env.CLICKHOUSE_PASSWORD = "pw";
    process.env.BILLING_INTERNAL_API_KEY = "internal-secret";
    process.env.CHARGEBEE_WEBHOOK_USER = "chargebee";
    process.env.CHARGEBEE_WEBHOOK_PASSWORD = "hook-secret";
  });

  it("rejects a webhook with no credentials, wrong credentials, or the wrong scheme", async () => {
    const { webhookAuthorised } = await import("@/lib/auth");
    const ok = "Basic " + Buffer.from("chargebee:hook-secret").toString("base64");

    expect(webhookAuthorised(ok)).toBe(true);
    expect(webhookAuthorised(null)).toBe(false);
    expect(webhookAuthorised("Basic " + Buffer.from("chargebee:wrong").toString("base64"))).toBe(false);
    expect(webhookAuthorised("Bearer hook-secret")).toBe(false);
    expect(webhookAuthorised("Basic not-base64")).toBe(false);
  });

  it("rejects the internal API without an exact bearer match", async () => {
    const { internalAuthorised } = await import("@/lib/auth");
    expect(internalAuthorised("Bearer internal-secret")).toBe(true);
    expect(internalAuthorised("Bearer internal-secre")).toBe(false); // prefix
    expect(internalAuthorised("Bearer internal-secret ")).toBe(false); // trailing space
    expect(internalAuthorised("internal-secret")).toBe(false); // no scheme
    expect(internalAuthorised(null)).toBe(false);
  });
});

describe("account lifecycle", () => {
  it("mirrors the grant and derives the gateway budget from it", async () => {
    const prisma = makeFakePrisma();
    const accounts = createAccounts({
      prisma: prisma as never,
      chargebee: fakeChargebee() as never,
      usdPerCredit: RATE,
      logger: quietLogger,
    });

    const account = await accounts.syncSubscription({
      tenantId: TENANT,
      subscriptionId: "sub_1",
      sourceRef: "evt_1",
    });

    expect(account.grantedCredits).toBe("1000");
    // 1000 credits x $0.001 — the budget the gateway enforces in real time.
    expect(account.budgetUsd).toBe("1");
    expect(prisma._entries).toHaveLength(1);
    expect(prisma._entries[0]!.entryType).toBe(ENTRY.GRANT);
  });

  it("cannot grant twice for the same Chargebee event", async () => {
    // Two guards, and this exercises the second: even if the webhook claim were
    // bypassed, the ledger's unique (tenant_id, source_ref) refuses the row.
    const prisma = makeFakePrisma();
    const accounts = createAccounts({
      prisma: prisma as never,
      chargebee: fakeChargebee() as never,
      usdPerCredit: RATE,
      logger: quietLogger,
    });

    await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "evt_1" });
    await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "evt_1" });
    await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "evt_1" });

    expect(prisma._entries.filter((e: { entryType: string }) => e.entryType === ENTRY.GRANT)).toHaveLength(1);
  });

  it("a different event id for the same subscription grants again", async () => {
    // Deliberate: a renewal is a distinct event and SHOULD grant. The guard is
    // per-event, not per-subscription, or renewals would silently never land.
    const prisma = makeFakePrisma();
    const accounts = createAccounts({
      prisma: prisma as never,
      chargebee: fakeChargebee() as never,
      usdPerCredit: RATE,
      logger: quietLogger,
    });

    await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "evt_1" });
    await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "evt_2" });

    expect(prisma._entries.filter((e: { entryType: string }) => e.entryType === ENTRY.GRANT)).toHaveLength(2);
  });

  it("pushes the budget to the gateway, and survives that push failing", async () => {
    const prisma = makeFakePrisma();
    const pushed: string[] = [];

    const accounts = createAccounts({
      prisma: prisma as never,
      chargebee: fakeChargebee() as never,
      usdPerCredit: RATE,
      pushBudget: async (tenantId) => {
        pushed.push(tenantId);
        throw new Error("gateway unreachable");
      },
      logger: quietLogger,
    });

    // A gateway outage must not lose the grant — the credits are the
    // customer's regardless of whether enforcement caught up.
    const account = await accounts.syncSubscription({
      tenantId: TENANT,
      subscriptionId: "sub_1",
      sourceRef: "evt_1",
    });

    // Pushed AFTER the grant entry is written: the cap is read from the ledger.
    expect(pushed).toEqual([TENANT]);
    expect(account.budgetUsd).toBe("1");
    expect(account.grantedCredits).toBe("1000");
    expect(prisma._entries).toHaveLength(1);
  });

  it("records an explicit expiry on renewal instead of letting the balance just restart", async () => {
    const prisma = makeFakePrisma();
    const accounts = createAccounts({
      prisma: prisma as never,
      chargebee: fakeChargebee() as never,
      usdPerCredit: RATE,
      logger: quietLogger,
    });

    await accounts.syncSubscription({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "evt_1" });
    await accounts.renew({ tenantId: TENANT, subscriptionId: "sub_1", sourceRef: "evt_renew" });

    const kinds = prisma._entries.map((e: { entryType: string }) => e.entryType);
    // Without the expiry row, "where did my 300 credits go" is unanswerable a
    // year later — the balance would be right for the wrong reason.
    expect(kinds).toContain(ENTRY.EXPIRY);
    expect(kinds.filter((k: string) => k === ENTRY.GRANT)).toHaveLength(2);
  });

  it("leaves the account unlinked when Chargebee cannot create the customer", async () => {
    const prisma = makeFakePrisma();
    const accounts = createAccounts({
      prisma: prisma as never,
      chargebee: fakeChargebee({
        createCustomer: async () => {
          throw new Error("chargebee down");
        },
      }) as never,
      usdPerCredit: RATE,
      logger: quietLogger,
    });

    // Onboarding must not block on Chargebee, but the failure has to be
    // RECORDED — an unlinked row is a work item, a missing row is invisible.
    const account = await accounts.ensureCustomer({
      tenantId: TENANT,
      routingSlug: SLUG,
      billingEmail: "a@b.com",
    });

    expect(account.chargebeeCustomerId).toBeFalsy();
  });

  it("treats a subscription with no ledger as zero credits rather than throwing", async () => {
    const prisma = makeFakePrisma();
    const accounts = createAccounts({
      prisma: prisma as never,
      chargebee: fakeChargebee({ balance: async () => null }) as never,
      usdPerCredit: RATE,
      logger: quietLogger,
    });

    const account = await accounts.syncSubscription({
      tenantId: TENANT,
      subscriptionId: "sub_1",
      sourceRef: "evt_1",
    });

    expect(account.grantedCredits).toBe("0");
    expect(prisma._entries).toHaveLength(0);
  });
});
