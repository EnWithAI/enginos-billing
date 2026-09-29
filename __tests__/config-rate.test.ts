/**
 * The credit's dollar value, set the way the business states it: how many
 * credits $1 buys (CREDITS_PER_USD). Billing converts it to the per-credit
 * rate every conversion uses; USD_PER_CREDIT still works where it is set.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig, resetConfig } from "@/config/config";
import { creditsToUsd, usdToCredits } from "@/models/rate";

const KEYS = ["CREDITS_PER_USD", "USD_PER_CREDIT", "CHARGEBEE_SITE", "CHARGEBEE_API_KEY", "CLICKHOUSE_PASSWORD"];

describe("CREDITS_PER_USD", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.CHARGEBEE_SITE = "site-test";
    process.env.CHARGEBEE_API_KEY = "test_key_123";
    process.env.CLICKHOUSE_PASSWORD = "pw";
    delete process.env.CREDITS_PER_USD;
    delete process.env.USD_PER_CREDIT;
    resetConfig();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfig();
  });

  it("50 credits to the dollar makes a credit worth $0.02 — both ways", () => {
    process.env.CREDITS_PER_USD = "50";
    const rate = getConfig().usdPerCredit;

    expect(Number(rate)).toBe(0.02);
    expect(Number(creditsToUsd("1000", rate))).toBe(20); // the free plan's 1,000 credits
    expect(Number(usdToCredits("1", rate))).toBe(50);
  });

  it("wins over USD_PER_CREDIT when both are set", () => {
    process.env.CREDITS_PER_USD = "1000";
    process.env.USD_PER_CREDIT = "0.02";

    expect(Number(getConfig().usdPerCredit)).toBe(0.001);
  });

  it("a rate that does not divide evenly keeps the ledger's ten places", () => {
    process.env.CREDITS_PER_USD = "3";

    expect(getConfig().usdPerCredit).toBe("0.3333333333");
  });

  it("an environment that still sets USD_PER_CREDIT keeps working", () => {
    process.env.USD_PER_CREDIT = "0.02";

    expect(Number(getConfig().usdPerCredit)).toBe(0.02);
  });

  it.each(["0", "-5"])("refuses %s — no rate at all is not a cheaper one", (value) => {
    process.env.CREDITS_PER_USD = value;

    expect(() => getConfig()).toThrow(/CREDITS_PER_USD must be greater than zero/);
  });
});
