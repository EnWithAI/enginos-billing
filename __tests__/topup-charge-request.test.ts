/**
 * The top-up charge as Chargebee receives it.
 *
 * MEASURED on the test site (2026-09-28): the invoice this call creates takes
 * its collection from the subscription, else the customer. With that
 * `auto_collection` off, the charge came back `payment_due` — and the charge's
 * Credit Grant was issued anyway, so the customer had the credits without
 * paying. With `auto_collection=on` on the call itself the same setup was paid
 * at once. The customer has confirmed the charge, so the call always says on.
 */

import { describe, expect, it } from "vitest";

import { createChargebee } from "@/integrations/chargebee";

function recordingClient(answer: Record<string, unknown>) {
  const sent: Array<{ path: string; body: URLSearchParams }> = [];
  const client = createChargebee({
    site: "test",
    apiKey: "key",
    maxAttempts: 1,
    sleep: async () => {},
    fetchImpl: (async (url: string, init?: RequestInit) => {
      sent.push({
        path: new URL(String(url)).pathname.replace(/^\/api\/v2/, ""),
        body: new URLSearchParams(String(init?.body ?? "")),
      });
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { client, sent };
}

const PAID = {
  invoice: { id: "124", status: "paid", total: 5000, amount_due: 0, currency_code: "INR" },
};

describe("chargeItem — the top-up charge", () => {
  it("collects now whatever the account's auto_collection says", async () => {
    const { client, sent } = recordingClient(PAID);

    await client.chargeItem({ subscriptionId: "sub_1", itemPriceId: "api_token-INR", quantity: 50 });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe("/invoices/create_for_charge_items_and_charges");
    expect(Object.fromEntries(sent[0]!.body)).toEqual({
      subscription_id: "sub_1",
      "item_prices[item_price_id][0]": "api_token-INR",
      "item_prices[quantity][0]": "50",
      auto_collection: "on",
    });
  });

  it("returns the invoice as Chargebee left it", async () => {
    const { client } = recordingClient(PAID);

    expect(await client.chargeItem({ subscriptionId: "sub_1", itemPriceId: "api_token-INR", quantity: 50 })).toEqual({
      id: "124",
      status: "paid",
      totalMinor: 5000,
      amountDueMinor: 0,
      currencyCode: "INR",
      nextRetryAt: null,
    });
  });
});
