import { describe, expect, it } from "vitest";
import { assertRate, creditsToUsd, isBillable, usdToCredits } from "@/models/rate";

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

});

describe("chargebee findOperation (retrieve by id)", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  // Shapes MEASURED against the test site.
  const NOT_FOUND = {
    http_status_code: 404,
    api_error_code: "resource_not_found",
    type: "invalid_request",
    message: "our-operation-uuid not found",
  };

  it("retrieves the operation by our id rather than scanning a page of the list", async () => {
    // The list endpoint ignores `id[is]` and returns 100 per page, so a capture
    // that landed could fall off the page once a subscription had more than
    // 100 operations — and be sent again.
    const { createChargebee } = await import("@/integrations/chargebee");
    const urls: string[] = [];
    const fetchImpl = (async (url: URL) => {
      urls.push(String(url));
      return json(200, { ledger_operation: { id: "our-operation-uuid", type: "capture", subscription_id: "sub_1" } });
    }) as unknown as typeof fetch;

    const cb = createChargebee({ site: "test", apiKey: "k", fetchImpl });

    expect(await cb.findOperation("our-operation-uuid", "sub_1")).toEqual({ id: "our-operation-uuid" });
    expect(urls).toEqual(["https://test.chargebee.com/api/v2/ledger_operations/our-operation-uuid"]);
  });

  it("reads resource_not_found as a definite 'never captured'", async () => {
    const { createChargebee } = await import("@/integrations/chargebee");
    const fetchImpl = (async () => json(404, NOT_FOUND)) as unknown as typeof fetch;

    const cb = createChargebee({ site: "test", apiKey: "k", fetchImpl });

    expect(await cb.findOperation("our-operation-uuid", "sub_1")).toBeNull();
  });

  it("does not count a grant under our id as a charge", async () => {
    const { createChargebee } = await import("@/integrations/chargebee");
    const fetchImpl = (async () =>
      json(200, { ledger_operation: { id: "our-operation-uuid", type: "allocation", subscription_id: "sub_1" } })) as unknown as typeof fetch;

    const cb = createChargebee({ site: "test", apiKey: "k", fetchImpl });

    expect(await cb.findOperation("our-operation-uuid", "sub_1")).toBeNull();
  });

  it("throws on a failed lookup instead of reporting 'not found'", async () => {
    // A 5xx or timeout says nothing about whether the capture exists. Reading
    // it as "not found" would re-send a charge that may have landed.
    const { createChargebee } = await import("@/integrations/chargebee");
    const fetchImpl = (async () => json(503, { message: "unavailable" })) as unknown as typeof fetch;

    const cb = createChargebee({ site: "test", apiKey: "k", fetchImpl, maxAttempts: 1 });

    await expect(cb.findOperation("our-operation-uuid", "sub_1")).rejects.toMatchObject({ retryable: true });
  });
});

/**
 * The grant total that drives the LiteLLM cap.
 *
 * This replaced `SUM(credit_ledger)`, and the expired-block exclusion replaced
 * the `expiry` entries the renewal path used to write. Get it wrong in the
 * generous direction and a customer keeps spending last term's credits; get it
 * wrong in the mean direction and a paying customer is capped at zero.
 */
describe("chargebee grant blocks", () => {
  const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
  const seconds = (ms: number) => Math.floor(ms / 1000);

  it("counts a live block and one that is merely spent", async () => {
    // A fully consumed block still counts: the cap is baseline + everything
    // granted, and the team's own cumulative spend is what eats it.
    const { isLiveGrantBlock } = await import("@/integrations/chargebee");
    expect(isLiveGrantBlock({ status: "available" }, NOW)).toBe(true);
    expect(isLiveGrantBlock({}, NOW)).toBe(true);
    expect(isLiveGrantBlock({ status: "available", expires_at: seconds(NOW) + 86400 }, NOW)).toBe(true);
  });

  it("excludes a block Chargebee has expired, and one whose expiry has passed", async () => {
    const { isLiveGrantBlock } = await import("@/integrations/chargebee");
    expect(isLiveGrantBlock({ status: "expired" }, NOW)).toBe(false);
    expect(isLiveGrantBlock({ status: "invalidated" }, NOW)).toBe(false);
    // Honoured even when the status still claims otherwise: only `available` is
    // documented, so the date is the safer of the two signals.
    expect(isLiveGrantBlock({ status: "available", expires_at: seconds(NOW) - 1 }, NOW)).toBe(false);
  });

  it("sums only the live blocks of the requested unit", async () => {
    const { createChargebee } = await import("@/integrations/chargebee");
    const chargebee = createChargebee({
      site: "s",
      apiKey: "k",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            list: [
              { grant_block: { id: "g1", granted_amount: "1000.0000000000", unit_id: "token", status: "available" } },
              { grant_block: { id: "g2", granted_amount: "1000.0000000000", unit_id: "token", status: "expired" } },
              { grant_block: { id: "g3", granted_amount: "500.0000000000", unit_id: "other", status: "available" } },
            ],
          }),
          { status: 200 },
        )) as never,
    });

    // Last term's 1000 expired and another unit's 500 is not ours: 1000.
    expect(await chargebee.grantedCredits("sub_1", "token", NOW)).toEqual({ credits: "1000", blocks: 1 });
  });
});
