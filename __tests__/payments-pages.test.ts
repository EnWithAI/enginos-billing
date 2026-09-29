/**
 * The billing page's payment history, a page at a time.
 *
 * Chargebee pages a list by an opaque `next_offset`, not by number: the
 * overview carries the newest page and its cursor, and every later page is
 * asked for with the cursor the page before it returned. The cursor only says
 * where in the list to continue — whose list is always the tenant's own
 * customer, resolved on the server.
 */

import { describe, expect, it, vi } from "vitest";

import { createChargebee } from "@/integrations/chargebee";
import type { ChargebeeClient } from "@/integrations/chargebee";
import { createBillingAccountRepository } from "@/repositories/billing-account.repository";
import { createChargebeeSyncRepository } from "@/repositories/chargebee-sync.repository";
import { PAYMENTS_PAGE_SIZE, createBillingOverviewService } from "@/services/billing-overview.service";
import { renderPaymentsPage } from "@/views/billing.view";

import { TENANT, makeFakePrisma, quietLogger } from "./harness";

const TXN = {
  id: "txn_1",
  type: "payment",
  status: "success",
  amount: 5000,
  currency_code: "INR",
  date: 1790573655,
  payment_method: "card",
  masked_card_number: "************1111",
  linked_invoices: [{ invoice_id: "101" }],
};

describe("reading a page of payments from Chargebee", () => {
  function client(answer: Record<string, unknown>) {
    const urls: URL[] = [];
    const cb = createChargebee({
      site: "s",
      apiKey: "k",
      maxAttempts: 1,
      sleep: async () => {},
      fetchImpl: ((url: URL) => {
        urls.push(new URL(String(url)));
        return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
      }) as unknown as typeof fetch,
    });
    return { cb, urls };
  }

  it("asks for the customer's payments, newest first, from the cursor — and returns the next cursor", async () => {
    const { cb, urls } = client({ list: [{ transaction: TXN }], next_offset: '["1790000000000","2"]' });

    const page = await cb.transactionsPage("cust_1", { limit: 10, offset: '["1790573655000","1"]' });

    const q = urls[0]!.searchParams;
    expect(q.get("customer_id[is]")).toBe("cust_1");
    expect(q.get("sort_by[desc]")).toBe("date");
    expect(q.get("limit")).toBe("10");
    expect(q.get("offset")).toBe('["1790573655000","1"]');
    expect(page.nextOffset).toBe('["1790000000000","2"]');
    expect(page.transactions).toEqual([
      expect.objectContaining({ id: "txn_1", amountMinor: 5000, atMs: 1790573655000, invoiceIds: ["101"] }),
    ]);
  });

  it("the last page has no cursor, and the first sends none", async () => {
    const { cb, urls } = client({ list: [{ transaction: TXN }] });

    expect((await cb.transactionsPage("cust_1")).nextOffset).toBeNull();
    expect(urls[0]!.searchParams.has("offset")).toBe(false);
  });
});

describe("the tenant's payment pages", () => {
  function overview(account: Record<string, unknown>, transactionsPage: ChargebeeClient["transactionsPage"]) {
    const prisma = makeFakePrisma({ chargebeeCustomerId: TENANT, ...account } as never);
    const accounts = createBillingAccountRepository(prisma as never);
    return createBillingOverviewService({
      chargebee: { transactionsPage } as unknown as ChargebeeClient,
      accountService: { ensureLocalAccount: (t: string) => accounts.findByTenantId(t) } as never,
      accounts,
      syncs: createChargebeeSyncRepository(prisma as never),
      plansOffered: async () => [],
      logger: quietLogger,
    });
  }

  it("pages the tenant's OWN customer, from the cursor it was given", async () => {
    const transactionsPage = vi.fn(async () => ({ transactions: [], nextOffset: "next" }));

    expect(await overview({}, transactionsPage).paymentsPage(TENANT, "cursor")).toEqual({ transactions: [], nextOffset: "next" });
    expect(transactionsPage).toHaveBeenCalledWith(TENANT, { limit: PAYMENTS_PAGE_SIZE, offset: "cursor" });
  });

  it("a tenant with no customer has no payments, and Chargebee is not asked", async () => {
    const transactionsPage = vi.fn(async () => ({ transactions: [], nextOffset: null }));

    expect(await overview({ chargebeeCustomerId: null }, transactionsPage).paymentsPage(TENANT, "cursor")).toEqual({
      transactions: [],
      nextOffset: null,
    });
    expect(transactionsPage).not.toHaveBeenCalled();
  });

  it("renders a page the way the overview renders its first one", () => {
    expect(
      renderPaymentsPage({
        transactions: [
          {
            id: "txn_1",
            type: "refund",
            status: "success",
            amountMinor: 100,
            currencyCode: "INR",
            atMs: 1790573655000,
            method: "card",
            maskedCardNumber: "************1111",
            errorText: null,
            invoiceIds: [],
          },
        ],
        nextOffset: null,
      }),
    ).toEqual({
      payments: [expect.objectContaining({ id: "txn_1", type: "refund", at: new Date(1790573655000), error: null })],
      nextOffset: null,
    });
  });
});
