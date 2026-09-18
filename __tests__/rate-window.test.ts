import { describe, expect, it } from "vitest";
import { assertRate, creditsToUsd, isBillable, splitWholeCredits, usdToCredits } from "@/lib/rate";
import { add } from "@/lib/decimal";

const RATE = "0.001";

describe("rate", () => {
  it("converts the design's worked example both ways", () => {
    // 1,000 credit grant at $0.001 -> a $1.00 gateway budget.
    expect(creditsToUsd("1000", RATE)).toBe("1");
    // $0.25 spent in a window -> 250 credits drawn from the grant.
    expect(usdToCredits("0.25", RATE)).toBe("250");
  });

  it("round-trips without losing value", () => {
    expect(usdToCredits(creditsToUsd("1337", RATE), RATE)).toBe("1337");
  });

  it("rejects a non-positive rate at the boundary", () => {
    expect(() => assertRate("0")).toThrow(RangeError);
    expect(() => assertRate("-0.001")).toThrow(RangeError);
    expect(assertRate("0.001")).toBe("0.001");
  });

  it("converts sub-cent spend to a fractional credit rather than zero", () => {
    expect(usdToCredits(0.0000005, RATE)).toBe("0.0005");
    expect(isBillable(usdToCredits(0.0000005, RATE))).toBe(true);
  });

  it("treats a window with no spend as not billable", () => {
    expect(usdToCredits("0", RATE)).toBe("0");
    expect(isBillable("0")).toBe(false);
  });

  it("carries the fraction forward in whole-credit mode", () => {
    // Four windows of 0.4 credits must eventually charge 1, never zero forever.
    let residual = "0";
    const captured: string[] = [];

    for (let i = 0; i < 4; i += 1) {
      const split = splitWholeCredits(add("0.4", residual));
      captured.push(split.capture);
      residual = split.residual;
    }

    expect(captured).toEqual(["0", "0", "1", "0"]);
    expect(residual).toBe("0.6");
  });
});

describe("chargebee findOperation (retrieve by id)", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  // Shapes MEASURED against the test site.
  const NOT_FOUND = {
    http_status_code: 404,
    api_error_code: "resource_not_found",
    type: "invalid_request",
    message: "our-batch-uuid not found",
  };

  it("retrieves the operation by our id rather than scanning a page of the list", async () => {
    // The list endpoint ignores `id[is]` and returns 100 per page, so a capture
    // that landed could fall off the page once a subscription had more than
    // 100 operations — and be sent again.
    const { createChargebee } = await import("@/lib/chargebee");
    const urls: string[] = [];
    const fetchImpl = (async (url: URL) => {
      urls.push(String(url));
      return json(200, { ledger_operation: { id: "our-batch-uuid", type: "capture", subscription_id: "sub_1" } });
    }) as unknown as typeof fetch;

    const cb = createChargebee({ site: "test", apiKey: "k", fetchImpl });

    expect(await cb.findOperation("our-batch-uuid", "sub_1")).toEqual({ id: "our-batch-uuid" });
    expect(urls).toEqual(["https://test.chargebee.com/api/v2/ledger_operations/our-batch-uuid"]);
  });

  it("reads resource_not_found as a definite 'never captured'", async () => {
    const { createChargebee } = await import("@/lib/chargebee");
    const fetchImpl = (async () => json(404, NOT_FOUND)) as unknown as typeof fetch;

    const cb = createChargebee({ site: "test", apiKey: "k", fetchImpl });

    expect(await cb.findOperation("our-batch-uuid", "sub_1")).toBeNull();
  });

  it("does not count a grant under our id as a charge", async () => {
    const { createChargebee } = await import("@/lib/chargebee");
    const fetchImpl = (async () =>
      json(200, { ledger_operation: { id: "our-batch-uuid", type: "allocation", subscription_id: "sub_1" } })) as unknown as typeof fetch;

    const cb = createChargebee({ site: "test", apiKey: "k", fetchImpl });

    expect(await cb.findOperation("our-batch-uuid", "sub_1")).toBeNull();
  });

  it("throws on a failed lookup instead of reporting 'not found'", async () => {
    // A 5xx or timeout says nothing about whether the capture exists. Reading
    // it as "not found" would re-send a charge that may have landed.
    const { createChargebee } = await import("@/lib/chargebee");
    const fetchImpl = (async () => json(503, { message: "unavailable" })) as unknown as typeof fetch;

    const cb = createChargebee({ site: "test", apiKey: "k", fetchImpl, maxAttempts: 1 });

    await expect(cb.findOperation("our-batch-uuid", "sub_1")).rejects.toMatchObject({ retryable: true });
  });
});
