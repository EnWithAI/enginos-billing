/**
 * The Chargebee calls the billing currency adds, as Chargebee receives them —
 * the real client over a recording `fetchImpl`, as topup-charge-request.test.ts
 * does for the top-up charge.
 *
 *   update_billing_info   the address the org confirmed, field by field
 *   GET /customers/{id}   the address Chargebee holds, mapped for the page
 *   cancel_for_items      the old subscription ended NOW, nothing credited,
 *                         and a cancel of one already cancelled is a success
 *   grant blocks          each block's own expiry
 *   invoice filters       every currency's top-up in one read
 */

import { describe, expect, it } from "vitest";

import { createChargebee } from "@/integrations/chargebee";

interface Sent {
  method: string;
  path: string;
  query: URLSearchParams;
  body: URLSearchParams;
}

/** The real client over a fetch that records every request and answers it with `answer`. */
function recordingClient(answer: (sent: Sent, n: number) => { status?: number; body: unknown }, maxAttempts = 1) {
  const sent: Sent[] = [];
  const client = createChargebee({
    site: "test",
    apiKey: "key",
    maxAttempts,
    sleep: async () => {},
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      const request = {
        method: init?.method ?? "GET",
        path: u.pathname.replace(/^\/api\/v2/, ""),
        query: u.searchParams,
        body: new URLSearchParams(String(init?.body ?? "")),
      };
      sent.push(request);
      const { status = 200, body } = answer(request, sent.length);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch,
  });
  return { client, sent };
}

const CHARGEBEE_ADDRESS = {
  first_name: "Asha",
  last_name: "Rao",
  company: "Acme",
  line1: "12 MG Road",
  line2: "",
  city: "Bengaluru",
  state: "Karnataka",
  state_code: "KA",
  zip: "560001",
  country: "IN",
  validation_status: "not_validated",
};

describe("update_billing_info — setting the customer's billing address", () => {
  it("reads the customer, then sends exactly the fields given, under billing_address[...], to the customer's own path", async () => {
    const { client, sent } = recordingClient(() => ({ body: { customer: { id: "cust 1", billing_address: CHARGEBEE_ADDRESS } } }));

    await client.updateBillingInfo("cust 1", {
      country: "IN",
      line1: "12 MG Road",
      city: "Bengaluru",
      state: "Karnataka",
      stateCode: "KA",
      zip: "560001",
      firstName: "Asha",
      lastName: "Rao",
      company: "Acme",
    });

    expect(sent.map((s) => [s.method, s.path])).toEqual([
      ["GET", "/customers/cust%201"],
      ["POST", "/customers/cust%201/update_billing_info"],
    ]);
    expect(Object.fromEntries(sent[1]!.body)).toEqual({
      "billing_address[first_name]": "Asha",
      "billing_address[last_name]": "Rao",
      "billing_address[company]": "Acme",
      "billing_address[line1]": "12 MG Road",
      "billing_address[city]": "Bengaluru",
      "billing_address[state]": "Karnataka",
      "billing_address[state_code]": "KA",
      "billing_address[zip]": "560001",
      "billing_address[country]": "IN",
    });
  });

  it("leaves out a field the address does not have — on this call, which REPLACES, that is how a cleared field is cleared", async () => {
    const { client, sent } = recordingClient(() => ({ body: { customer: { id: "c1", billing_address: CHARGEBEE_ADDRESS } } }));

    await client.updateBillingInfo("c1", { country: "US", line1: "1 Main St", city: "Austin" });

    expect(Object.fromEntries(sent[1]!.body)).toEqual({
      "billing_address[line1]": "1 Main St",
      "billing_address[city]": "Austin",
      "billing_address[country]": "US",
    });
  });

  it("answers with the customer as Chargebee now holds it", async () => {
    const { client } = recordingClient(() => ({
      body: { customer: { id: "c1", billing_address: CHARGEBEE_ADDRESS, preferred_currency_code: "INR" }, card: {} },
    }));

    expect(await client.updateBillingInfo("c1", { country: "IN", line1: "12 MG Road", city: "Bengaluru" })).toEqual({
      id: "c1",
      billingAddress: {
        firstName: "Asha",
        lastName: "Rao",
        company: "Acme",
        line1: "12 MG Road",
        line2: null,
        city: "Bengaluru",
        state: "Karnataka",
        stateCode: "KA",
        zip: "560001",
        country: "IN",
        email: null,
        phone: null,
        line3: null,
      },
      preferredCurrencyCode: "INR",
      vatNumber: null,
      vatNumberPrefix: null,
      registeredForGst: null,
      businessCustomerWithoutVatNumber: null,
    });
  });

  it("is retried on a 5xx — the same address twice is the same address", async () => {
    let posts = 0;
    const { client, sent } = recordingClient(
      (s) => (s.method === "POST" && (posts += 1) === 1 ? { status: 503, body: { message: "busy" } } : { body: { customer: { id: "c1" } } }),
      3,
    );

    await client.updateBillingInfo("c1", { country: "US", line1: "1 Main St", city: "Austin" });
    expect(sent.map((s) => s.method)).toEqual(["GET", "POST", "POST"]);
  });

  it("sends back what billing does not own, exactly as it was: the tax registration, and the address's email, phone and line3", async () => {
    const { client, sent } = recordingClient((s) =>
      s.method === "GET"
        ? {
            body: {
              customer: {
                id: "c1",
                vat_number: "29ABCDE1234F1Z5",
                vat_number_prefix: "XI",
                registered_for_gst: true,
                business_customer_without_vat_number: false,
                billing_address: { ...CHARGEBEE_ADDRESS, email: "accounts@acme.test", phone: "+91 80 1234 5678", line3: "Block C" },
              },
            },
          }
        : { body: { customer: { id: "c1" } } },
    );

    await client.updateBillingInfo("c1", { country: "IN", line1: "1 New Road", city: "Mysuru" });

    expect(Object.fromEntries(sent[1]!.body)).toEqual({
      "billing_address[line1]": "1 New Road",
      "billing_address[city]": "Mysuru",
      "billing_address[country]": "IN",
      "billing_address[email]": "accounts@acme.test",
      "billing_address[phone]": "+91 80 1234 5678",
      "billing_address[line3]": "Block C",
      vat_number: "29ABCDE1234F1Z5",
      vat_number_prefix: "XI",
      registered_for_gst: "true",
      business_customer_without_vat_number: "false",
    });
  });

  it("throws Chargebee's refusal as it came, for the caller to name", async () => {
    const { client, sent } = recordingClient(
      (s) =>
        s.method === "GET"
          ? { body: { customer: { id: "c1" } } }
          : { status: 400, body: { message: "billing_address[state_code] : invalid value", api_error_code: "invalid_request" } },
      3,
    );

    await expect(client.updateBillingInfo("c1", { country: "IN", line1: "x", city: "y", stateCode: "ZZ" })).rejects.toMatchObject({
      status: 400,
      apiErrorCode: "invalid_request",
      message: "billing_address[state_code] : invalid value",
    });
    expect(sent.filter((s) => s.method === "POST")).toHaveLength(1); // a 4xx is not retried
  });
});

describe("a tax registration belongs to its country (A28)", () => {
  /** A customer in India, registered for GST, with an email and a phone on its address. */
  const REGISTERED = {
    id: "c1",
    vat_number: "29ABCDE1234F1Z5",
    vat_number_prefix: "XI",
    registered_for_gst: true,
    business_customer_without_vat_number: false,
    billing_address: { ...CHARGEBEE_ADDRESS, email: "accounts@acme.test", phone: "+91 80 1234 5678", line3: "Block C" },
  };

  function client() {
    const warns: Array<Record<string, unknown>> = [];
    const sent: Array<{ method: string; body: URLSearchParams }> = [];
    const cb = createChargebee({
      site: "test",
      apiKey: "key",
      maxAttempts: 1,
      sleep: async () => {},
      logger: { ...{ log() {}, error() {} }, warn: (o: unknown) => void warns.push(o as Record<string, unknown>) },
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        sent.push({ method: init?.method ?? "GET", body: new URLSearchParams(String(init?.body ?? "")) });
        return Response.json({ customer: init?.method === "POST" ? { id: "c1" } : REGISTERED });
      }) as unknown as typeof fetch,
    });
    return { cb, sent, warns };
  }

  it("an address kept in its country sends the registration back exactly as it was — nothing said", async () => {
    const r = client();

    await r.cb.updateBillingInfo("c1", { country: "IN", line1: "1 New Road", city: "Mysuru" });

    expect(Object.fromEntries(r.sent[1]!.body)).toMatchObject({
      vat_number: "29ABCDE1234F1Z5",
      vat_number_prefix: "XI",
      registered_for_gst: "true",
      business_customer_without_vat_number: "false",
    });
    expect(r.warns).toEqual([]);
  });

  it("an address moved to another country leaves the old country's registration out — Chargebee's replace clears it — and says which fields, never their values", async () => {
    const r = client();

    await r.cb.updateBillingInfo("c1", { country: "US", line1: "1 Main St", city: "Austin" });

    const body = Object.fromEntries(r.sent[1]!.body);
    expect(body).toEqual({
      "billing_address[line1]": "1 Main St",
      "billing_address[city]": "Austin",
      "billing_address[country]": "US",
      // The address's email, phone and third line are still the customer's.
      "billing_address[email]": "accounts@acme.test",
      "billing_address[phone]": "+91 80 1234 5678",
      "billing_address[line3]": "Block C",
    });
    expect(r.warns).toEqual([
      {
        metric: "billing.address.tax_registration_cleared",
        customerId: "c1",
        from: "IN",
        to: "US",
        fields: ["vat_number", "vat_number_prefix", "registered_for_gst", "business_customer_without_vat_number"],
      },
    ]);
    expect(JSON.stringify(r.warns)).not.toContain("29ABCDE1234F1Z5");
  });
});

describe("GET /customers/{id} — the address on file", () => {
  it("maps the billing address, empty fields as null, with the preferred currency", async () => {
    const { client, sent } = recordingClient(() => ({ body: { customer: { id: "c1", billing_address: CHARGEBEE_ADDRESS } } }));

    const customer = await client.customer("c1");

    expect([sent[0]!.method, sent[0]!.path]).toEqual(["GET", "/customers/c1"]);
    expect(customer).toMatchObject({ id: "c1", preferredCurrencyCode: null });
    expect(customer?.billingAddress).toMatchObject({ line1: "12 MG Road", line2: null, stateCode: "KA", country: "IN" });
  });

  it("has no address for a customer Chargebee holds none for — not one made of empty fields", async () => {
    const { client } = recordingClient(() => ({ body: { customer: { id: "c1", email: "a@acme.test" } } }));

    expect(await client.customer("c1")).toEqual({
      id: "c1",
      billingAddress: null,
      preferredCurrencyCode: null,
      vatNumber: null,
      vatNumberPrefix: null,
      registeredForGst: null,
      businessCustomerWithoutVatNumber: null,
    });
  });

  it("is null for a customer that does not exist, as before", async () => {
    const { client } = recordingClient(() => ({ status: 404, body: { api_error_code: "resource_not_found" } }));

    expect(await client.customer("nobody")).toBeNull();
  });
});

describe("cancel_for_items — ending the old subscription now", () => {
  it("cancels at once, crediting, invoicing and refunding nothing — every choice said, none left to the site", async () => {
    const { client, sent } = recordingClient(() => ({ body: { subscription: { id: "sub_A", status: "cancelled" }, customer: {} } }));

    expect(await client.cancelSubscription("sub_A")).toEqual({ id: "sub_A", status: "cancelled" });
    expect(sent).toHaveLength(1);
    expect([sent[0]!.method, sent[0]!.path]).toEqual(["POST", "/subscriptions/sub_A/cancel_for_items"]);
    expect(Object.fromEntries(sent[0]!.body)).toEqual({
      end_of_term: "false",
      credit_option_for_current_term_charges: "none",
      unbilled_charges_option: "delete",
      account_receivables_handling: "no_action",
      refundable_credits_handling: "no_action",
    });
  });

  it("takes a refusal on a subscription already cancelled as the success it is — read back, and returned", async () => {
    const { client, sent } = recordingClient((s) =>
      s.method === "POST"
        ? { status: 400, body: { message: "Subscription is already cancelled", api_error_code: "invalid_state_for_request" } }
        : { body: { subscription: { id: "sub_A", status: "cancelled", cancelled_at: 1790000000 } } },
    );

    expect(await client.cancelSubscription("sub_A")).toEqual({ id: "sub_A", status: "cancelled", cancelled_at: 1790000000 });
    expect(sent.map((s) => [s.method, s.path])).toEqual([
      ["POST", "/subscriptions/sub_A/cancel_for_items"],
      ["GET", "/subscriptions/sub_A"],
    ]);
  });

  it("takes a subscription that is GONE (a definite 404) as ended — waiting for it would wait for ever", async () => {
    const { client, sent } = recordingClient(() => ({ status: 404, body: { message: "Not found", api_error_code: "resource_not_found" } }));

    expect(await client.cancelSubscription("sub_A")).toEqual({ id: "sub_A", status: "cancelled" });
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET"]);
  });

  it("throws the refusal when the subscription is still live — nothing was cancelled", async () => {
    const { client } = recordingClient((s) =>
      s.method === "POST"
        ? { status: 400, body: { message: "Cannot cancel", api_error_code: "invalid_request" } }
        : { body: { subscription: { id: "sub_A", status: "active" } } },
    );

    await expect(client.cancelSubscription("sub_A")).rejects.toMatchObject({ status: 400, message: "Cannot cancel" });
  });

  it("cancels at the term end when Chargebee refuses a mid-term cancel of a plan with a Credit Grant (MEASURED)", async () => {
    const REFUSAL =
      "You cannot cancel a subscription with items having credit unit grants immediately or mid-term. You can schedule the updates during renewal";
    const { client, sent } = recordingClient((s) => {
      if (s.method === "GET") return { body: { subscription: { id: "sub_A", status: "active" } } };
      return s.body.get("end_of_term") === "true"
        ? { body: { subscription: { id: "sub_A", status: "non_renewing" }, customer: {} } }
        : { status: 400, body: { message: REFUSAL, api_error_code: "invalid_request" } };
    });

    expect(await client.cancelSubscription("sub_A")).toEqual({ id: "sub_A", status: "non_renewing" });
    expect(sent.map((s) => [s.method, s.path])).toEqual([
      ["POST", "/subscriptions/sub_A/cancel_for_items"],
      ["GET", "/subscriptions/sub_A"],
      ["POST", "/subscriptions/sub_A/cancel_for_items"],
    ]);
    // The fallback sends only the schedule: credit and charge options mean nothing at the term end.
    expect(Object.fromEntries(sent[2]!.body)).toEqual({ end_of_term: "true" });
  });

  it("takes a subscription already scheduled to end (non_renewing) as done — a repeat schedules nothing", async () => {
    const { client, sent } = recordingClient((s) =>
      s.method === "POST"
        ? { status: 400, body: { message: "You cannot cancel … credit unit grants …", api_error_code: "invalid_request" } }
        : { body: { subscription: { id: "sub_A", status: "non_renewing" } } },
    );

    expect(await client.cancelSubscription("sub_A")).toEqual({ id: "sub_A", status: "non_renewing" });
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET"]);
  });

  it("retries a 5xx, and never takes one for a refusal to look up", async () => {
    const { client, sent } = recordingClient(
      (_s, n) => (n < 3 ? { status: 502, body: {} } : { body: { subscription: { id: "sub_A", status: "cancelled" } } }),
      3,
    );

    expect(await client.cancelSubscription("sub_A")).toMatchObject({ status: "cancelled" });
    expect(sent.map((s) => s.method)).toEqual(["POST", "POST", "POST"]);
  });
});

describe("grant blocks carry their own expiry", () => {
  it("maps expires_at (seconds) to expiresAtMs, and none to null", async () => {
    const block = (id: string, extra: Record<string, unknown>) => ({
      grant_block: { id, subscription_id: "sub_A", unit_id: "token-test", granted_amount: 10, status: "available", created_at: 1790000000, ...extra },
    });
    const { client } = recordingClient(() => ({
      body: { list: [block("plan", { expires_at: 1792592000 }), block("pack", { expires_at: 5680261800 }), block("hand", {}), block("zero", { expires_at: 0 })] },
    }));

    const { blocks } = await client.grantBlocks("sub_A");

    expect(Object.fromEntries(blocks.map((b) => [b.id, b.expiresAtMs]))).toEqual({
      plan: 1792592000_000,
      pack: 5680261800_000,
      hand: null,
      zero: null,
    });
  });
});

describe("invoice filters take every currency's top-up at once", () => {
  const line = (entity_id: string) => ({ entity_id });
  const INVOICES = {
    list: [
      { invoice: { id: "126", status: "payment_due", amount_due: 5000, currency_code: "INR", line_items: [line("api_token-INR")] } },
      { invoice: { id: "127", status: "payment_due", amount_due: 500, currency_code: "USD", line_items: [line("api_token-USD")] } },
      { invoice: { id: "128", status: "not_paid", amount_due: 900, currency_code: "INR", line_items: [line("plan-INR")] } },
    ],
  };

  it("unpaidInvoicesFor: one read, the invoices with a line for ANY of the ids", async () => {
    const { client, sent } = recordingClient(() => ({ body: INVOICES }));

    const owed = await client.unpaidInvoicesFor("c1", ["api_token-INR", "api_token-USD"]);

    expect(owed.map((i) => [i.id, i.currencyCode])).toEqual([
      ["126", "INR"],
      ["127", "USD"],
    ]);
    expect(sent).toHaveLength(1);
  });

  it("unpaidInvoicesFor: one id still works as it always has", async () => {
    const { client } = recordingClient(() => ({ body: INVOICES }));

    expect((await client.unpaidInvoicesFor("c1", "api_token-USD")).map((i) => i.id)).toEqual(["127"]);
  });

  it("paidInvoicesFor: the paid invoices with a line for any of the ids", async () => {
    const { client, sent } = recordingClient(() => ({
      body: {
        list: [
          { invoice: { id: "200", status: "paid", line_items: [line("api_token-USD")] } },
          { invoice: { id: "201", status: "paid", line_items: [line("plan-USD")] } },
          { invoice: { id: "202", status: "paid", line_items: [line("plan-INR"), line("api_token-INR")] } },
        ],
      },
    }));

    expect((await client.paidInvoicesFor("c1", ["api_token-INR", "api_token-USD"])).map((i) => i.id)).toEqual(["200", "202"]);
    expect(sent[0]!.query.get("status[is]")).toBe("paid");
  });

  it("unpaidTopUpCredits: holds back the unsettled packs of every currency's top-up", async () => {
    const block = (id: string, invoice: string, itemPriceId: string) => ({
      grant_block: {
        id,
        subscription_id: "sub_1",
        unit_id: "token-test",
        granted_amount: "50.0000000000",
        status: "available",
        billing_metadata: JSON.stringify({ line_items: [{ id: `li_${invoice}`, invoice_number: invoice }], item_price_id: itemPriceId }),
      },
    });
    const { client } = recordingClient((s) =>
      s.path === "/invoices"
        ? { body: INVOICES }
        : { body: { list: [block("b126", "126", "api_token-INR"), block("b127", "127", "api_token-USD"), block("b128", "128", "plan-INR")] } },
    );

    expect(
      await client.unpaidTopUpCredits({
        customerId: "c1",
        subscriptionId: "sub_1",
        unitId: "token-test",
        itemPriceId: ["api_token-INR", "api_token-USD"],
      }),
    ).toBe("100");
  });

  it("asks Chargebee nothing when no top-up is configured at all", async () => {
    const { client, sent } = recordingClient(() => ({ body: INVOICES }));

    expect(await client.unpaidInvoicesFor("c1", [])).toEqual([]);
    expect(await client.paidInvoicesFor("c1", [])).toEqual([]);
    expect(await client.unpaidTopUpCredits({ customerId: "c1", subscriptionId: "sub_1", itemPriceId: [] })).toBe("0");
    expect(sent).toEqual([]);
  });
});

describe("subscription_for_items with an id of our own", () => {
  const SUB = { subscription: { id: "cs_0123", status: "active", currency_code: "USD" } };
  const args = { customerId: "c1", itemPriceId: "pre-paid-test-v1-USD-Yearly", idempotencyKey: "currency-switch:0123", subscriptionId: "cs_0123" };

  it("creates the subscription under that id, with the idempotency key", async () => {
    const { client, sent } = recordingClient(() => ({ body: SUB }));

    expect(await client.subscribeCustomer(args)).toEqual(SUB.subscription);
    expect([sent[0]!.method, sent[0]!.path]).toEqual(["POST", "/customers/c1/subscription_for_items"]);
    expect(Object.fromEntries(sent[0]!.body)).toEqual({
      id: "cs_0123",
      "subscription_items[item_price_id][0]": "pre-paid-test-v1-USD-Yearly",
      "subscription_items[quantity][0]": "1",
    });
  });

  it.each([
    ["the id refused as a duplicate (an earlier attempt landed)", { status: 400, body: { api_error_code: "duplicate_entry", message: "id already exists" } }],
    ["a 5xx — which Chargebee replays under the key for 30 minutes", { status: 503, body: { message: "busy" } }],
  ])("answers %s by reading the subscription BY THAT ID", async (_label, refusal) => {
    const { client, sent } = recordingClient((s) => (s.method === "POST" ? refusal : { body: SUB }), 2);

    expect(await client.subscribeCustomer(args)).toEqual(SUB.subscription);
    expect(sent.at(-1)!.path).toBe("/subscriptions/cs_0123");
  });

  it("rethrows when the subscription is not there after all, or when no id was given", async () => {
    const missing = recordingClient((s) =>
      s.method === "POST" ? { status: 503, body: { message: "busy" } } : { status: 404, body: { api_error_code: "resource_not_found" } },
    );
    await expect(missing.client.subscribeCustomer(args)).rejects.toMatchObject({ status: 503 });

    const noId = recordingClient(() => ({ status: 400, body: { api_error_code: "duplicate_entry" } }));
    await expect(noId.client.subscribeCustomer({ ...args, subscriptionId: undefined })).rejects.toMatchObject({ status: 400 });
    expect(noId.sent.map((s) => s.method)).toEqual(["POST"]);
  });
});

describe("the customer's preferred currency", () => {
  it("is set with preferred_currency_code alone, on the customer", async () => {
    const { client, sent } = recordingClient(() => ({ body: { customer: { id: "c1", preferred_currency_code: "USD" } } }));

    expect((await client.setPreferredCurrency("c1", "USD")).preferredCurrencyCode).toBe("USD");
    expect([sent[0]!.method, sent[0]!.path, Object.fromEntries(sent[0]!.body)]).toEqual(["POST", "/customers/c1", { preferred_currency_code: "USD" }]);
  });
});

describe("a hosted checkout pre-filled with the confirmed address", () => {
  it("sends the address's fields as billing_address[...], leaving out the empty ones", async () => {
    const { client, sent } = recordingClient(() => ({ body: { hosted_page: { id: "hp_1" } } }));

    await client.checkoutPage({
      customerId: "c1",
      itemPriceId: "plan-monthly",
      billingAddress: { country: "IN", line1: "12 MG Road", city: "Bengaluru", stateCode: "KA", line2: null, company: null },
    });

    expect(Object.fromEntries(sent[0]!.body)).toEqual({
      "customer[id]": "c1",
      "subscription_items[item_price_id][0]": "plan-monthly",
      "subscription_items[quantity][0]": "1",
      "billing_address[line1]": "12 MG Road",
      "billing_address[city]": "Bengaluru",
      "billing_address[state_code]": "KA",
      "billing_address[country]": "IN",
    });
  });

  it("sends no address when there is none", async () => {
    const { client, sent } = recordingClient(() => ({ body: { hosted_page: { id: "hp_1" } } }));

    await client.checkoutPage({ customerId: "c1", itemPriceId: "plan-monthly", billingAddress: null });

    expect([...sent[0]!.body.keys()].some((k) => k.startsWith("billing_address"))).toBe(false);
  });
});

describe("unsettled top-ups: one rule, shared", () => {
  it("lists the ids of top-up invoices not settled, for any of the item prices", async () => {
    const { client, sent } = recordingClient(() => ({
      body: {
        list: [
          { invoice: { id: "126", status: "payment_due", line_items: [{ entity_id: "api_token-INR" }] } },
          { invoice: { id: "127", status: "voided", line_items: [{ entity_id: "api_token-USD" }] } },
          { invoice: { id: "128", status: "pending", line_items: [{ entity_id: "plan-INR" }] } },
        ],
      },
    }));

    expect(await client.unsettledTopUpInvoiceIds("c1", ["api_token-INR", "api_token-USD"])).toEqual(["126", "127"]);
    expect(sent[0]!.query.get("status[in]")).toBe('["payment_due","not_paid","voided","pending"]');
  });

  it("the same read with each invoice's status — owed, voided and pending told apart — and none asked for none configured", async () => {
    const { client, sent } = recordingClient(() => ({
      body: {
        list: [
          { invoice: { id: "126", status: "payment_due", line_items: [{ entity_id: "api_token-INR" }] } },
          { invoice: { id: "127", status: "pending", line_items: [{ entity_id: "api_token-USD" }] } },
          { invoice: { id: "128", status: "pending", line_items: [{ entity_id: "plan-INR" }] } },
        ],
      },
    }));

    expect(await client.unsettledTopUpInvoices("c1", ["api_token-INR", "api_token-USD"])).toEqual([
      { id: "126", status: "payment_due" },
      { id: "127", status: "pending" },
    ]);
    expect(await client.unsettledTopUpInvoices("c1", [])).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("isUnsettledTopUpGrant: a top-up's block whose invoice is unsettled — on a mapped block as on a raw one", async () => {
    const { isUnsettledTopUpGrant } = await import("@/integrations/chargebee");
    const unsettled = new Set(["126"]);
    const block = (itemPriceId: string | null, invoiceId: string | null) => ({ itemPriceId, invoices: [{ invoiceId, lineItemId: "li" }] });

    expect(isUnsettledTopUpGrant(block("api_token-INR", "126"), unsettled, ["api_token-INR", "api_token-USD"])).toBe(true);
    expect(isUnsettledTopUpGrant(block("api_token-INR", "96"), unsettled, ["api_token-INR"])).toBe(false); // paid
    expect(isUnsettledTopUpGrant(block("plan-INR", "126"), unsettled, ["api_token-INR"])).toBe(false); // not a top-up
    expect(isUnsettledTopUpGrant(block(null, null), unsettled, ["api_token-INR"])).toBe(false); // an allocation
  });
});
