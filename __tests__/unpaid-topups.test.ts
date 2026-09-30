/**
 * A top-up whose card declined: no credits until it is paid.
 *
 * MEASURED on the test site (2026-09-28): a declining card makes the top-up
 * charge answer HTTP 200 with a `payment_due` invoice — not an error — and
 * Chargebee issues the pack's credits with the invoice at once, then retries
 * the card a day later (dunning). Voiding the invoice does not take them back.
 * So billing holds those credits back — from the gateway cap, the page's
 * balance and the exhaustion check — until the invoice is paid. "Pay now"
 * collects it at once, because a new card does not by itself; and only one
 * top-up may be owed at a time, or a retry would charge for each.
 */

import { describe, expect, it, vi } from "vitest";

import { createChargebee } from "@/integrations/chargebee";
import type { ChargebeeClient, GrantBlock, UnpaidInvoice } from "@/integrations/chargebee";
import { createBillingAccountRepository } from "@/repositories/billing-account.repository";
import { paidGrantedCredits } from "@/container/budget-hooks";
import { createChargebeeSyncRepository } from "@/repositories/chargebee-sync.repository";
import { createAccountService } from "@/services/account.service";
import { createBillingOverviewService } from "@/services/billing-overview.service";
import { createCheckoutService } from "@/services/checkout.service";
import { AppError } from "@/shared/errors";
import type { Logger } from "@/shared/logger";
import { renderBillingOverview } from "@/views/billing.view";

import { TENANT, makeFakePrisma, quietLogger } from "./harness";

const RETRY = new Date("2026-09-29T10:00:00Z");
const DUE = {
  id: "inv_due",
  status: "payment_due",
  totalMinor: 5000,
  amountDueMinor: 5000,
  currencyCode: "INR",
  nextRetryAt: RETRY,
};
const PAID = { id: "inv_paid", status: "paid", totalMinor: 5000, amountDueMinor: 0, currencyCode: "INR", nextRetryAt: null };
const CARD = { id: "pm_1", type: "card", status: "valid", brand: "visa", last4: "1111", expiryMonth: 12, expiryYear: 2030 };
const OWED: UnpaidInvoice = {
  id: "inv_old",
  status: "payment_due",
  amountDueMinor: 5000,
  currencyCode: "INR",
  nextRetryAt: RETRY,
  date: new Date("2026-09-28T10:00:00Z"),
};

/** The block Chargebee issued with the unpaid invoice — 50 units × 50 credits. */
function blockFor(invoiceId: string, itemPriceId = "pack"): GrantBlock {
  return {
    id: `blk_${invoiceId}`,
    subscriptionId: "sub_1",
    unitId: "token-test",
    grantedAmount: "2500",
    status: "available",
    source: "top_up",
    createdAtMs: 1790600000000,
    invoices: [{ invoiceId, lineItemId: "li_1" }],
    itemPriceId,
    doneBy: null,
  };
}

function rig(
  over: Partial<ChargebeeClient> = {},
  { grants = true, logger = quietLogger }: { grants?: boolean; logger?: Logger } = {},
) {
  const prisma = makeFakePrisma({
    chargebeeCustomerId: TENANT,
    chargebeeSubscriptionId: "sub_1",
    ledgerUnitId: "token-test",
    status: "active",
  } as never);
  const chargebee = {
    chargeItem: async () => DUE,
    collectInvoice: async () => PAID,
    paymentSource: async () => CARD,
    unpaidInvoicesFor: async () => [],
    paidInvoicesFor: async () => [],
    subscriptionIdsOf: async () => ["sub_1"],
    grantBlocks: async () => ({ blocks: [blockFor("inv_due")], complete: true }),
    balance: async () => ({ usable: "2500" }),
    unpaidTopUpCredits: async () => "0",
    ...over,
  } as unknown as ChargebeeClient;
  const pushBudget = vi.fn(async () => {});
  const accountService = createAccountService({
    prisma,
    chargebee,
    usdPerCredit: "0.02",
    pushBudget,
    topUpItemPriceId: "pack",
    logger,
  });
  const checkout = createCheckoutService({
    chargebee,
    accountService,
    accounts: createBillingAccountRepository(prisma),
    itemPriceIds: ["plan"],
    defaultItemPriceId: "plan",
    topUpItemPriceId: "pack",
    topUpCredits: "50",
    topUpChargebeeGrants: grants,
    logger,
    sleep: async () => {},
  });
  return { checkout, pushBudget, prisma };
}

async function rejection(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

describe("a top-up whose card declined", () => {
  it("grants nothing: no cap moved, no pack recorded — the invoice comes back as it is, with its retry date", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const { checkout, pushBudget, prisma } = rig({}, { logger: { ...quietLogger, warn: (o: unknown) => void warnings.push(o as never) } });

    const result = await checkout.startTopUp(TENANT, 50);

    expect(result).toEqual({ invoice: DUE, quantity: 50, applied: 0, credits: "0" });
    expect(pushBudget).not.toHaveBeenCalled();
    expect(prisma._topUps.size).toBe(0);
    expect(warnings).toContainEqual(
      expect.objectContaining({ metric: "billing.topup.unpaid", invoiceId: "inv_due", nextRetryAt: RETRY }),
    );
  });

  it("allows one unpaid top-up at a time: another is a 409 topup-unpaid, and nothing is charged", async () => {
    const chargeItem = vi.fn(async () => DUE);
    const unpaidInvoicesFor = vi.fn(async () => [OWED]);
    const { checkout } = rig({ chargeItem, unpaidInvoicesFor });

    const err = await rejection(checkout.startTopUp(TENANT, 50));

    expect([err.kind, err.code, err.message]).toEqual([
      "conflict",
      "topup-unpaid",
      "Pay the unpaid top-up before buying more credits",
    ]);
    expect(unpaidInvoicesFor).toHaveBeenCalledWith(TENANT, "pack");
    expect(chargeItem).not.toHaveBeenCalled();
  });
});

describe("Pay now — collecting an unpaid top-up", () => {
  it("charges the card for every owed invoice, oldest first, then records the paid packs", async () => {
    const collectInvoice = vi.fn(async (id: string) => ({ ...PAID, id }));
    const paidInvoicesFor = vi.fn(async () => []);
    const { checkout } = rig({
      collectInvoice,
      paidInvoicesFor,
      unpaidInvoicesFor: async () => [OWED, { ...OWED, id: "inv_newer" }],
    });

    const result = await checkout.payUnpaidTopUps(TENANT);

    expect(collectInvoice.mock.calls.map(([id]) => id)).toEqual(["inv_old", "inv_newer"]);
    expect(result.invoices).toEqual([
      { id: "inv_old", status: "paid" },
      { id: "inv_newer", status: "paid" },
    ]);
    expect(paidInvoicesFor).toHaveBeenCalledWith(TENANT, "pack");
  });

  it("grants the pack once collected: recorded, and the cap moved", async () => {
    const { checkout, pushBudget, prisma } = rig({
      unpaidInvoicesFor: async () => [OWED],
      collectInvoice: async () => ({ ...PAID, id: "inv_old" }),
      paidInvoicesFor: async () => [{ id: "inv_old", line_items: [{ id: "li_1", entity_id: "pack" }] }],
      grantBlocks: async () => ({ blocks: [blockFor("inv_old")], complete: true }),
    });

    expect(await checkout.payUnpaidTopUps(TENANT)).toEqual({
      invoices: [{ id: "inv_old", status: "paid" }],
      applied: 1,
      credits: "2500",
    });
    expect([...prisma._topUps.values()]).toEqual([
      expect.objectContaining({ invoiceId: "inv_old", source: "catalogue_grant", status: "APPLIED" }),
    ]);
    expect(pushBudget).toHaveBeenCalledTimes(1);
  });

  it("does nothing when nothing is owed", async () => {
    const collectInvoice = vi.fn(async () => PAID);
    const { checkout } = rig({ collectInvoice });

    expect(await checkout.payUnpaidTopUps(TENANT)).toEqual({ invoices: [], applied: 0, credits: "0" });
    expect(collectInvoice).not.toHaveBeenCalled();
  });

  it("a card that declines again is the same 409 as a declined top-up, and the invoice stays owed", async () => {
    // MEASURED: collect_payment on a declining card answers 400, not 402.
    const declined = Object.assign(new Error("Payment collection failed. Reason: (3001) Insufficient funds."), {
      status: 400,
      apiErrorCode: "payment_processing_failed",
    });
    const { checkout } = rig({
      unpaidInvoicesFor: async () => [OWED],
      collectInvoice: async () => {
        throw declined;
      },
    });

    const err = await rejection(checkout.payUnpaidTopUps(TENANT));
    expect([err.kind, err.code]).toEqual(["conflict", "topup-payment-failed"]);
    expect(err.message).toBe("Payment failed: Payment collection failed. Reason: (3001) Insufficient funds.");
  });

  it("sends a customer with no usable card to add one first", async () => {
    const collectInvoice = vi.fn(async () => PAID);
    const { checkout } = rig({
      collectInvoice,
      unpaidInvoicesFor: async () => [OWED],
      paymentSource: async () => ({ ...CARD, status: "expired" }),
    });

    const err = await rejection(checkout.payUnpaidTopUps(TENANT));
    expect([err.kind, err.code]).toEqual(["conflict", "no-payment-method"]);
    expect(collectInvoice).not.toHaveBeenCalled();
  });

  it("lets an outage through for the route's fallback", async () => {
    const outage = new Error("Chargebee unreachable");
    const { checkout } = rig({
      unpaidInvoicesFor: async () => [OWED],
      collectInvoice: async () => {
        throw outage;
      },
    });

    await expect(checkout.payUnpaidTopUps(TENANT)).rejects.toBe(outage);
  });
});

describe("a declined top-up's credits are held back until it is paid", () => {
  const ACCOUNT = { chargebeeCustomerId: TENANT, chargebeeSubscriptionId: "sub_1", ledgerUnitId: "token-test" };

  it("from the gateway cap", async () => {
    const unpaidTopUpCredits = vi.fn(async () => "2500");
    const credits = await paidGrantedCredits(
      { grantedCredits: async () => ({ credits: "3500", blocks: 2 }), unpaidTopUpCredits },
      ACCOUNT as never,
      "pack",
    );

    expect(credits).toBe("1000");
    expect(unpaidTopUpCredits).toHaveBeenCalledWith({
      customerId: TENANT,
      subscriptionId: "sub_1",
      unitId: "token-test",
      itemPriceId: "pack",
    });
  });

  it("from the cap, never below zero", async () => {
    expect(
      await paidGrantedCredits(
        { grantedCredits: async () => ({ credits: "100", blocks: 1 }), unpaidTopUpCredits: async () => "2500" },
        ACCOUNT as never,
        "pack",
      ),
    ).toBe("0");
  });

  it("from the exhaustion check: a pack paid while another is owed opens only on the paid credits", async () => {
    // Chargebee's usable 5000 holds both packs; 2500 of it is the owed one.
    const { checkout, pushBudget } = rig({
      paidInvoicesFor: async () => [{ id: "inv_new", line_items: [{ id: "li_1", entity_id: "pack" }] }],
      grantBlocks: async () => ({ blocks: [blockFor("inv_new"), blockFor("inv_owed")], complete: true }),
      balance: (async () => ({ usable: "5000" })) as never,
      unpaidTopUpCredits: async () => "2500",
    });

    await checkout.applyTopUps(TENANT);

    expect(pushBudget).toHaveBeenCalledWith(TENANT, expect.objectContaining({ usableCredits: "2500", unblock: true }));
  });

  it("from the exhaustion check: nothing paid left means exhausted, whatever the owed pack holds", async () => {
    const { checkout, pushBudget } = rig({
      paidInvoicesFor: async () => [{ id: "inv_new", line_items: [{ id: "li_1", entity_id: "pack" }] }],
      grantBlocks: async () => ({ blocks: [blockFor("inv_new")], complete: true }),
      balance: (async () => ({ usable: "2500" })) as never,
      unpaidTopUpCredits: async () => "2500",
    });

    await checkout.applyTopUps(TENANT);

    expect(pushBudget).toHaveBeenCalledWith(TENANT, expect.objectContaining({ usableCredits: "0", unblock: false }));
  });
});

describe("the Chargebee calls", () => {
  function client(answer: Record<string, unknown>, status = 200) {
    const sent: Array<{ method: string; url: URL; body: URLSearchParams }> = [];
    const cb = createChargebee({
      site: "s",
      apiKey: "k",
      maxAttempts: 3,
      sleep: async () => {},
      fetchImpl: (async (url: string, init?: RequestInit) => {
        sent.push({
          method: init?.method ?? "GET",
          url: new URL(String(url)),
          body: new URLSearchParams(String(init?.body ?? "")),
        });
        return new Response(JSON.stringify(answer), { status });
      }) as unknown as typeof fetch,
    });
    return { cb, sent };
  }

  it("lists the customer's uncollected invoices for the top-up, oldest first, with when Chargebee retries", async () => {
    const { cb, sent } = client({
      list: [
        {
          invoice: {
            id: "130",
            status: "payment_due",
            amount_due: 200,
            currency_code: "INR",
            next_retry_at: 1790679503,
            date: 1790593103,
            line_items: [{ entity_id: "api_token-INR" }],
          },
        },
        // A plan invoice left unpaid is not a top-up.
        { invoice: { id: "131", status: "not_paid", amount_due: 900, line_items: [{ entity_id: "plan-INR" }] } },
      ],
    });

    const unpaid = await cb.unpaidInvoicesFor("cust_1", "api_token-INR");

    const q = sent[0]!.url.searchParams;
    expect(sent[0]!.url.pathname).toBe("/api/v2/invoices");
    expect(q.get("customer_id[is]")).toBe("cust_1");
    expect(q.get("status[in]")).toBe('["payment_due","not_paid"]');
    expect(q.get("sort_by[asc]")).toBe("date");
    expect(unpaid).toEqual([
      {
        id: "130",
        status: "payment_due",
        amountDueMinor: 200,
        currencyCode: "INR",
        nextRetryAt: new Date(1790679503 * 1000),
        date: new Date(1790593103 * 1000),
      },
    ]);
  });

  it("sums the live blocks of unsettled top-up invoices — owed, abandoned, voided or pending — on the account's unit", async () => {
    const block = (id: string, invoice: string, extra: Record<string, unknown> = {}) => ({
      grant_block: {
        id,
        subscription_id: "sub_1",
        unit_id: "token-test",
        granted_amount: "50.0000000000",
        status: "available",
        billing_metadata: JSON.stringify({
          line_items: [{ id: `li_${invoice}`, invoice_number: invoice, quantity: 1 }],
          item_price_id: "api_token-INR",
        }),
        ...extra,
      },
    });
    const sent: URL[] = [];
    const cb = createChargebee({
      site: "s",
      apiKey: "k",
      maxAttempts: 1,
      sleep: async () => {},
      fetchImpl: (async (url: string) => {
        const u = new URL(String(url));
        sent.push(u);
        if (u.pathname === "/api/v2/invoices") {
          return Response.json({
            list: [
              { invoice: { id: "126", status: "payment_due", line_items: [{ entity_id: "api_token-INR" }] } },
              { invoice: { id: "103", status: "voided", line_items: [{ entity_id: "api_token-INR" }] } },
              { invoice: { id: "140", status: "not_paid", line_items: [{ entity_id: "plan-INR" }] } },
            ],
          });
        }
        return Response.json({
          list: [
            block("b126", "126"),
            block("b103", "103"),
            block("b96", "96"), // paid: counts
            block("b140", "140", {
              billing_metadata: JSON.stringify({ line_items: [{ invoice_number: "140" }], item_price_id: "plan-INR" }),
            }),
            block("b126x", "126", { status: "expired" }),
            block("b126u", "126", { unit_id: "token" }),
          ],
        });
      }) as unknown as typeof fetch,
    });

    expect(
      await cb.unpaidTopUpCredits({ customerId: "cust_1", subscriptionId: "sub_1", unitId: "token-test", itemPriceId: "api_token-INR" }),
    ).toBe("100");
    expect(sent[0]!.searchParams.get("status[in]")).toBe('["payment_due","not_paid","voided","pending"]');
    expect(sent[0]!.searchParams.get("customer_id[is]")).toBe("cust_1");
  });

  it("asks Chargebee once when no top-up is unsettled", async () => {
    const { cb, sent } = client({ list: [] });

    expect(await cb.unpaidTopUpCredits({ customerId: "cust_1", subscriptionId: "sub_1", itemPriceId: "api_token-INR" })).toBe("0");
    expect(sent).toHaveLength(1);
  });

  it("collects an invoice with collect_payment", async () => {
    const { cb, sent } = client({ invoice: { id: "128", status: "paid", total: 100, amount_due: 0, currency_code: "INR" } });

    expect(await cb.collectInvoice("128")).toEqual({
      id: "128",
      status: "paid",
      totalMinor: 100,
      amountDueMinor: 0,
      currencyCode: "INR",
      nextRetryAt: null,
    });
    expect(sent.map((s) => [s.method, s.url.pathname])).toEqual([["POST", "/api/v2/invoices/128/collect_payment"]]);
  });

  it("never retries a collect — it moves money, and a 5xx says nothing about whether it did", async () => {
    const { cb, sent } = client({ message: "gateway timeout" }, 503);

    await expect(cb.collectInvoice("128")).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });

  it("reads the retry date off a charge Chargebee could not collect", async () => {
    const { cb } = client({
      invoice: { id: "126", status: "payment_due", total: 100, amount_due: 100, currency_code: "INR", next_retry_at: 1790679129 },
    });

    expect(await cb.chargeItem({ subscriptionId: "sub_1", itemPriceId: "api_token-INR" })).toMatchObject({
      status: "payment_due",
      nextRetryAt: new Date(1790679129 * 1000),
    });
  });
});

describe("the billing page's unpaid top-ups", () => {
  function overview(unpaidInvoicesFor: ChargebeeClient["unpaidInvoicesFor"], logger: Logger = quietLogger) {
    const prisma = makeFakePrisma({
      chargebeeCustomerId: TENANT,
      chargebeeSubscriptionId: "sub_1",
      ledgerUnitId: "token-test",
      status: "active",
    } as never);
    const accounts = createBillingAccountRepository(prisma as never);
    return createBillingOverviewService({
      chargebee: {
        unpaidInvoicesFor,
        transactionsPage: async () => ({ transactions: [], nextOffset: null }),
        balance: async () => ({ usable: "0" }),
        grantedCredits: async () => ({ credits: "0", blocks: 0 }),
        subscription: async () => null,
        paymentSource: async () => null,
        unpaidTopUpCredits: async () => "0",
      } as unknown as ChargebeeClient,
      accountService: { ensureLocalAccount: (t: string) => accounts.findByTenantId(t) } as never,
      accounts,
      syncs: createChargebeeSyncRepository(prisma as never),
      plansOffered: async () => [],
      topUpItemPriceId: "pack",
      logger,
    });
  }

  it("are listed for the tenant's own customer", async () => {
    const unpaidInvoicesFor = vi.fn(async () => [OWED]);

    const result = await overview(unpaidInvoicesFor).overview(TENANT);

    expect(unpaidInvoicesFor).toHaveBeenCalledWith(TENANT, "pack");
    expect(result).toMatchObject({ kind: "linked", unpaidTopUps: [OWED] });
  });

  it("are null — not 'nothing owed' — when Chargebee cannot be asked, and the page still renders", async () => {
    const errors: unknown[] = [];
    const result = await overview(
      async () => {
        throw new Error("Chargebee down");
      },
      { ...quietLogger, error: (o: unknown) => void errors.push(o) },
    ).overview(TENANT);

    expect(result).toMatchObject({ kind: "linked", unpaidTopUps: null });
    expect(errors).toEqual([expect.objectContaining({ metric: "billing.page.unpaid_topups_unreadable" })]);
  });

  it("leave the balance: a declined top-up's credits come off granted and remaining, not onto consumed", async () => {
    const prisma = makeFakePrisma({
      chargebeeCustomerId: TENANT,
      chargebeeSubscriptionId: "sub_1",
      ledgerUnitId: "token-test",
      status: "active",
    } as never);
    const accounts = createBillingAccountRepository(prisma as never);
    const result = await createBillingOverviewService({
      chargebee: {
        unpaidInvoicesFor: async () => [OWED],
        unpaidTopUpCredits: async () => "2500",
        transactionsPage: async () => ({ transactions: [], nextOffset: null }),
        balance: async () => ({ usable: "3200" }),
        grantedCredits: async () => ({ credits: "3500", blocks: 2 }),
        subscription: async () => null,
        paymentSource: async () => null,
      } as unknown as ChargebeeClient,
      accountService: { ensureLocalAccount: (t: string) => accounts.findByTenantId(t) } as never,
      accounts,
      syncs: createChargebeeSyncRepository(prisma as never),
      plansOffered: async () => [],
      topUpItemPriceId: "pack",
      logger: quietLogger,
    }).overview(TENANT);

    expect(result).toMatchObject({
      kind: "linked",
      credits: { granted: "1000", allocated: "1000", consumed: "300", current: "700" },
    });
  });

  it("render with the amount in minor units and the retry date", () => {
    const view = renderBillingOverview(
      {
        kind: "linked",
        freePlan: true,
        plansOffered: [],
        account: { status: "active", chargebeeSubscriptionId: "sub_1", ledgerUnitId: "token-test" } as never,
        credits: { granted: "0", allocated: "0", consumed: "0", current: "0" },
        payments: [],
        paymentsNextOffset: null,
        subscription: null,
        lastSync: null,
        topUp: null,
        unpaidTopUps: [OWED],
      },
      { site: "s", defaultItemPriceId: "plan" },
    );

    expect(view.unpaidTopUps).toEqual([
      { invoiceId: "inv_old", status: "payment_due", amountDueMinor: 5000, currencyCode: "INR", nextRetryAt: RETRY },
    ]);
  });
});
