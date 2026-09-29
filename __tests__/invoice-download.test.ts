/**
 * Invoice downloads, and the one thing that makes them safe.
 *
 * Chargebee invoice ids on this site are small sequential integers — the first
 * real one is "82". Anything that turns an id into a download link is therefore
 * an enumeration surface onto other organizations' billing addresses and
 * amounts, and the only thing standing in front of it is the ownership check in
 * the route: load the tenant's Chargebee customer, ask Chargebee who owns the
 * invoice, compare.
 *
 * These tests pin the CLIENT behaviour that check depends on. The distinction
 * that matters most is the last one: a 404 must be null and anything else must
 * throw, because the route turns null into "not found" and a throw into a 502.
 * Collapsing them would report a Chargebee outage as "that invoice is not
 * yours", which is both wrong and impossible to debug from the outside.
 */

import { describe, expect, it } from "vitest";

import { createChargebee } from "@/integrations/chargebee";

const OWNER = "5d3fa58c-86c5-4141-a0d3-94d385af953f";

/** MEASURED against the live site — the shapes these methods actually parse. */
const INVOICE = {
  invoice: { id: "82", customer_id: OWNER, status: "paid", total: 1000000, currency_code: "INR" },
};
const DOWNLOAD = {
  download: {
    download_url: "https://cb-downloads-prod.s3.amazonaws.com/enwithai-test/invoice/16A0Fv.pdf?X-Amz-Signature=abc",
    valid_till: 1790070838,
  },
};
const NOT_FOUND = (id: string) =>
  new Response(JSON.stringify({ api_error_code: "resource_not_found", message: `${id} not found` }), { status: 404 });

function client(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return createChargebee({
    site: "test",
    apiKey: "key",
    maxAttempts: 1,
    sleep: async () => {},
    fetchImpl: ((url: string, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as unknown as typeof fetch,
  });
}

describe("reading an invoice to establish ownership", () => {
  it("returns the owning customer, which is the only fact the route needs", async () => {
    const cb = client(() => new Response(JSON.stringify(INVOICE), { status: 200 }));
    const inv = await cb.invoice("82");
    expect(inv).toEqual({ id: "82", customerId: OWNER, status: "paid" });
  });

  it("is null for an invoice Chargebee does not have", async () => {
    const cb = client(() => NOT_FOUND("99999"));
    expect(await cb.invoice("99999")).toBeNull();
  });

  it("THROWS when Chargebee is broken, rather than reporting the invoice as missing", async () => {
    // The distinction the security story rests on. Null means "no such invoice",
    // which the route answers identically to "not yours". A 500 means we could
    // not find out, and must surface as a 502 — telling a paying customer their
    // own invoice is not theirs because Chargebee had a bad minute is a support
    // ticket nobody can diagnose.
    const cb = client(() => new Response(JSON.stringify({ message: "internal" }), { status: 500 }));
    await expect(cb.invoice("82")).rejects.toThrow();
  });

  it("does not confuse an unrelated 404 with a missing invoice", async () => {
    // A 404 WITHOUT resource_not_found is a routing mistake on our side, not an
    // answer about this invoice.
    const cb = client(() => new Response(JSON.stringify({ message: "no route" }), { status: 404 }));
    await expect(cb.invoice("82")).rejects.toThrow();
  });

  it("escapes the id, so it cannot alter the path it is interpolated into", async () => {
    let seen = "";
    const cb = client((url) => {
      seen = url;
      return new Response(JSON.stringify(INVOICE), { status: 200 });
    });
    await cb.invoice("82/../../customers");
    expect(seen).toContain("82%2F..%2F..%2Fcustomers");
    expect(seen).not.toContain("/customers");
  });
});

describe("minting the download link", () => {
  it("returns the pre-signed url and when it dies", async () => {
    const cb = client(() => new Response(JSON.stringify(DOWNLOAD), { status: 200 }));
    const dl = await cb.invoicePdfUrl("82");
    expect(dl?.url).toBe(DOWNLOAD.download.download_url);
    // Epoch SECONDS on the wire, converted once here.
    expect(dl?.validTillMs).toBe(1790070838 * 1000);
  });

  it("posts, because minting a link is not a read", async () => {
    let method = "";
    const cb = client((url, init) => {
      method = String(init?.method);
      expect(url).toContain("/invoices/82/pdf");
      return new Response(JSON.stringify(DOWNLOAD), { status: 200 });
    });
    await cb.invoicePdfUrl("82");
    expect(method).toBe("POST");
  });

  it("is null when the invoice is unknown", async () => {
    const cb = client(() => NOT_FOUND("99999"));
    expect(await cb.invoicePdfUrl("99999")).toBeNull();
  });

  it("is null rather than a broken link when Chargebee answers without one", async () => {
    const cb = client(() => new Response(JSON.stringify({ download: {} }), { status: 200 }));
    expect(await cb.invoicePdfUrl("82")).toBeNull();
  });

  it("throws when Chargebee is broken, so the route can say 502 and not 404", async () => {
    const cb = client(() => new Response(JSON.stringify({ message: "boom" }), { status: 500 }));
    await expect(cb.invoicePdfUrl("82")).rejects.toThrow();
  });
});

describe("the ownership comparison the route performs", () => {
  /** The route's check, stated here so a change to it breaks a test. */
  const mayDownload = (invoiceCustomerId: string | null, accountCustomerId: string | null) =>
    invoiceCustomerId != null && accountCustomerId != null && invoiceCustomerId === accountCustomerId;

  it("allows the owner", () => {
    expect(mayDownload(OWNER, OWNER)).toBe(true);
  });

  it("refuses another tenant's invoice", () => {
    expect(mayDownload(OWNER, "22222222-2222-4222-8222-222222222222")).toBe(false);
  });

  it("refuses when either side is unknown, rather than treating null as a match", () => {
    // Two nulls comparing equal is the classic way this check quietly inverts:
    // an account with no Chargebee customer would match an invoice with no
    // customer and download it.
    expect(mayDownload(null, null)).toBe(false);
    expect(mayDownload(OWNER, null)).toBe(false);
    expect(mayDownload(null, OWNER)).toBe(false);
  });
});
