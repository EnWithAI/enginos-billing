/**
 * The HTTP layer: the one route wrapper, and the services the routes used to
 * carry inline.
 *
 * What is pinned here is the CONTRACT enginos-platform passes through to
 * crewpe-ui — status and `code` for every refusal — and the two safety
 * properties that used to live in route bodies: the plan allowlist, and the
 * invoice ownership check whose "not yours" must be indistinguishable from
 * "not found".
 */

import { describe, expect, it, vi } from "vitest";

import { route } from "@/http/route";
import type { ChargebeeClient } from "@/integrations/chargebee";
import { createBillingAccountRepository } from "@/repositories/billing-account.repository";
import { createAccountService } from "@/services/account.service";
import { createCheckoutService } from "@/services/checkout.service";
import { createInvoiceService } from "@/services/invoice.service";
import { createPortalService } from "@/services/portal.service";
import { AppError, conflict } from "@/shared/errors";
import type { Logger } from "@/shared/logger";
import { renderBillingOverview } from "@/views/billing.view";

import { T0, TENANT, makeFakePrisma, quietLogger } from "./harness";

function request() {
  return new Request("http://billing.test/api/x", { method: "POST", body: "{}" });
}

const FALLBACK = { status: 502, body: { error: "Nope", code: "nope" }, metric: "billing.test.failed", message: "failed" };

describe("route()", () => {
  it("turns an AppError into its status and { error, code }", async () => {
    const res = await route({ fallback: FALLBACK }, async () => {
      throw conflict("Subscribe before topping up", "no-subscription");
    })(request());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Subscribe before topping up", code: "no-subscription" });
  });

  it("answers an unexpected failure with the fallback, never the raw message, and logs it with context", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await route({ fallback: FALLBACK }, async (_r, { logContext }) => {
      logContext.tenantId = TENANT;
      throw new Error("connection reset by peer");
    })(request());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Nope", code: "nope" });
    expect(logged).toHaveBeenCalledWith(
      { metric: "billing.test.failed", tenantId: TENANT, err: "connection reset by peer" },
      "failed",
    );
    logged.mockRestore();
  });
});

function chargebeeStub(over: Partial<ChargebeeClient> = {}) {
  return {
    createCustomer: async ({ id }: { id: string }) => ({ id }),
    checkoutPage: async () => ({ id: "hp_1" }),
    checkoutOneTime: async () => ({ id: "hp_topup" }),
    portalSession: async () => ({ id: "ps_1" }),
    ...over,
  } as unknown as ChargebeeClient;
}

function checkoutRig(
  over: Partial<ChargebeeClient> = {},
  account: Record<string, unknown> = {},
  logger: Logger = quietLogger,
  prepare?: (prisma: ReturnType<typeof makeFakePrisma>) => void,
) {
  const prisma = makeFakePrisma({ chargebeeCustomerId: TENANT, ...account } as never);
  prepare?.(prisma);
  const chargebee = chargebeeStub(over);
  const accounts = createBillingAccountRepository(prisma);
  const accountService = createAccountService({ prisma, chargebee, usdPerCredit: "0.001", logger });
  return createCheckoutService({
    chargebee,
    accountService,
    accounts,
    itemPriceIds: ["plan-monthly"],
    defaultItemPriceId: "plan-monthly",
    topUpItemPriceId: "pack",
    topUpCredits: "1000",
    logger: quietLogger,
  });
}

async function rejection(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

describe("checkout", () => {
  it("refuses a plan that is not on the allowlist, whatever the request says", async () => {
    const err = await rejection(checkoutRig().startSubscription(TENANT, "some-other-plan"));
    expect([err.kind, err.code]).toEqual(["invalid", "plan-not-offered"]);
  });

  it("opens checkout for the tenant's own customer", async () => {
    const checkoutPage = vi.fn(async () => ({ id: "hp_1" }));
    await checkoutRig({ checkoutPage }).startSubscription(TENANT);
    expect(checkoutPage).toHaveBeenCalledWith({ customerId: TENANT, itemPriceId: "plan-monthly" });
  });

  it("will not top up an account with no subscription", async () => {
    const err = await rejection(checkoutRig({}, { chargebeeSubscriptionId: null }).startTopUp(TENANT));
    expect([err.kind, err.code]).toEqual(["conflict", "no-subscription"]);
  });

  it("will not top up a CANCELLED account — it still carries its subscription id — and says why, as a 409", async () => {
    // The credits would reopen a LiteLLM team whose usage the sync no longer
    // bills, because it skips cancelled accounts. Refused before any payment.
    const checkoutOneTime = vi.fn(async () => ({ id: "hp_topup" }));
    const rig = checkoutRig({ checkoutOneTime }, { chargebeeSubscriptionId: "sub_1", ledgerUnitId: "token", status: "cancelled" });

    const err = await rejection(rig.startTopUp(TENANT));

    expect([err.kind, err.code, err.message]).toEqual([
      "conflict",
      "subscription-cancelled",
      "Your subscription has ended — subscribe again to add credits",
    ]);
    expect(checkoutOneTime).not.toHaveBeenCalled();

    const res = await route({ fallback: FALLBACK }, async () => Response.json(await rig.startTopUp(TENANT)))(request());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Your subscription has ended — subscribe again to add credits",
      code: "subscription-cancelled",
    });
  });

  it("will not grant a paid pack to a CANCELLED account either — and a pack paid anyway is raised as an error, for a refund", async () => {
    const allocate = vi.fn(async () => ({ operationId: "op", balanceAfter: "0" }));
    const paidInvoicesFor = vi.fn(async () => [{ id: "inv_1" }, { id: "inv_0" }]);
    // inv_0 was granted to the subscription before it ended (its topup_grant
    // row says so); inv_1 was paid after.
    const grantBlocks = vi.fn(async () => ({ blocks: [], complete: true }));
    const errors: Array<Record<string, unknown>> = [];
    const rig = checkoutRig(
      { allocate, paidInvoicesFor, grantBlocks, subscriptionIdsOf: async () => ["sub_1"] } as never,
      { chargebeeSubscriptionId: "sub_1", ledgerUnitId: "token", status: "cancelled" },
      { ...quietLogger, error: (o: unknown) => void errors.push(o as Record<string, unknown>) },
      (prisma) =>
        prisma._topUps.set("tg_0", {
          id: "tg_0",
          tenantId: TENANT,
          invoiceId: "inv_0",
          chargebeeSubscriptionId: "sub_1",
          ledgerUnitId: "token",
          credits: "1000",
          expiresAt: new Date(T0 + 86_400_000),
          idempotencyKey: "invoice:inv_0",
          keyIssuedAt: new Date(T0),
          status: "APPLIED",
          source: "allocation",
          chargebeeRef: "ledger_operation:op_0",
          attemptCount: 1,
          error: null,
          createdAt: new Date(T0),
          updatedAt: new Date(T0),
          appliedAt: new Date(T0),
        }),
    );

    const err = await rejection(rig.applyTopUps(TENANT));

    expect([err.kind, err.code]).toEqual(["conflict", "subscription-cancelled"]);
    expect(allocate).not.toHaveBeenCalled();
    // Not a warn that nobody reads: an error naming exactly the invoice that was paid for nothing.
    expect(errors).toEqual([
      expect.objectContaining({ metric: "billing.topup.refused_cancelled", tenantId: TENANT, invoiceIds: ["inv_1"] }),
    ]);
  });

  it("still tops up an active account", async () => {
    const checkoutOneTime = vi.fn(async () => ({ id: "hp_topup" }));
    const rig = checkoutRig({ checkoutOneTime }, { chargebeeSubscriptionId: "sub_1", ledgerUnitId: "token", status: "active" });

    expect(await rig.startTopUp(TENANT)).toEqual({ hostedPage: { id: "hp_topup" }, credits: "1000" });
    expect(checkoutOneTime).toHaveBeenCalledWith({ customerId: TENANT, itemPriceId: "pack" });
  });

  it("names a site with one-time checkout switched off, instead of failing generically", async () => {
    const disabled = Object.assign(new Error("One time checkout is not enabled for this site"), {
      apiErrorCode: "invalid_request",
    });
    const err = await rejection(
      checkoutRig({
        checkoutOneTime: async () => {
          throw disabled;
        },
      }).startTopUp(TENANT),
    );
    expect([err.kind, err.code]).toEqual(["conflict", "topup-disabled"]);
  });

  it("lets any other Chargebee failure through for the route's fallback", async () => {
    const outage = new Error("Chargebee /hosted_pages unreachable");
    const rig = checkoutRig({
      checkoutOneTime: async () => {
        throw outage;
      },
    });
    await expect(rig.startTopUp(TENANT)).rejects.toBe(outage);
  });
});

describe("portal", () => {
  const portal = (over: Partial<ChargebeeClient>, account: Record<string, unknown> = {}, enabled = true) => {
    const prisma = makeFakePrisma({ chargebeeCustomerId: TENANT, ...account } as never);
    return createPortalService({
      chargebee: chargebeeStub(over),
      accounts: createBillingAccountRepository(prisma),
      redirectUrl: "http://app.test",
      enabled,
      logger: quietLogger,
    });
  };

  it("stays shut unless it is turned on — the Chargebee portal lets a customer cancel", async () => {
    const portalSession = vi.fn(async () => ({ id: "ps_1" }));
    const err = await rejection(portal({ portalSession }, {}, false).open(TENANT));
    expect([err.kind, err.code]).toEqual(["conflict", "portal-off"]);
    expect(portalSession).not.toHaveBeenCalled();

    expect(await portal({ portalSession }, {}, true).open(TENANT)).toEqual({ id: "ps_1" });
  });

  it("has nothing to open for a tenant with no customer", async () => {
    const err = await rejection(portal({}, { chargebeeCustomerId: null }).open(TENANT));
    expect([err.kind, err.code]).toEqual(["not_found", "no-customer"]);
  });

  it("names a site whose portal API is switched off", async () => {
    const err = await rejection(
      portal({
        portalSession: async () => {
          throw Object.assign(new Error("Customer portal access via API is disabled."), {
            apiErrorCode: "configuration_incompatible",
          });
        },
      }).open(TENANT),
    );
    expect([err.kind, err.code]).toEqual(["conflict", "portal-disabled"]);
  });
});

describe("invoice download", () => {
  const invoices = (over: Partial<ChargebeeClient>) => {
    const prisma = makeFakePrisma({ chargebeeCustomerId: TENANT } as never);
    return createInvoiceService({
      chargebee: chargebeeStub(over),
      accounts: createBillingAccountRepository(prisma),
      logger: quietLogger,
    });
  };
  const pdf = async () => ({ url: "https://s3.test/82.pdf", validTillMs: 1 });

  it("mints a link for the tenant's own invoice", async () => {
    const svc = invoices({ invoice: async () => ({ id: "82", customerId: TENANT, status: "paid" }), invoicePdfUrl: pdf });
    expect(await svc.downloadLink(TENANT, "82")).toEqual({ url: "https://s3.test/82.pdf", validTillMs: 1 });
  });

  it("answers another customer's invoice exactly as it answers a missing one", async () => {
    const theirs = invoices({ invoice: async () => ({ id: "83", customerId: "someone-else", status: "paid" }), invoicePdfUrl: pdf });
    const missing = invoices({ invoice: async () => null, invoicePdfUrl: pdf });

    const a = await rejection(theirs.downloadLink(TENANT, "83"));
    const b = await rejection(missing.downloadLink(TENANT, "83"));
    expect([a.kind, a.message, a.code]).toEqual([b.kind, b.message, b.code]);
    expect(a.kind).toBe("not_found");
  });

  it("reports a Chargebee outage as upstream, never as not found", async () => {
    const svc = invoices({
      invoice: async () => {
        throw new Error("timeout");
      },
    });
    const err = await rejection(svc.downloadLink(TENANT, "82"));
    expect(err.kind).toBe("upstream");
  });
});

describe("billing page view", () => {
  const config = { site: "test-site", defaultItemPriceId: "plan-monthly" };
  const plansOffered: never[] = [];

  it("gives an unlinked tenant every key, with the site set so checkout can load", () => {
    expect(renderBillingOverview({ kind: "unlinked", plansOffered }, config)).toEqual({
      site: "test-site",
      plansOffered,
      status: "unlinked",
      plan: { itemPriceId: "plan-monthly" },
      term: { start: null, end: null },
      credits: { unit: null, granted: "0", allocated: "0", consumed: "0", current: "0" },
      lastSync: null,
      payments: [],
      subscription: null,
    });
  });

  it("shows no credits while activating, whatever Chargebee holds", () => {
    const account = {
      status: "activating",
      chargebeeItemPriceId: "plan-yearly",
      ledgerUnitId: "token",
      currentTermStart: null,
      currentTermEnd: null,
    } as never;
    const view = renderBillingOverview({ kind: "activating", plansOffered, account }, config);
    expect(view.status).toBe("activating");
    expect(view.plan).toEqual({ itemPriceId: "plan-yearly" });
    expect(view.credits).toEqual({ unit: "token", granted: "0", allocated: "0", consumed: "0", current: "0" });
  });

  it("renders unreadable payments as null, not as an empty list", () => {
    const account = { status: "active", chargebeeSubscriptionId: "sub_1", ledgerUnitId: "token" } as never;
    const view = renderBillingOverview(
      {
        kind: "linked",
        plansOffered,
        account,
        credits: { granted: "1000", allocated: "1000", consumed: "10", current: "990" },
        payments: null,
        subscription: null,
        lastSync: null,
      },
      config,
    );
    expect(view.payments).toBeNull();
    expect(view.credits).toEqual({ unit: "token", granted: "1000", allocated: "1000", consumed: "10", current: "990" });
  });
});
