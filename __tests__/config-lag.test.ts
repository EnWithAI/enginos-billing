/**
 * C11: BILLING_LAG_MS is in milliseconds, and a value too short for the
 * spans to land is refused.
 *
 * Windows are on when each LLM call ENDED, and its span reaches ClickHouse up
 * to ~45 s later (measured). A window read sooner is billed before its spans
 * land, and they are never charged. The live .env once carried
 * `BILLING_LAG_MS=120` (meant as two minutes), and once `0`; the process
 * refuses to start on anything under thirty seconds.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIN_LAG_MS, getConfig, resetConfig } from "@/config/config";

const KEYS = ["BILLING_LAG_MS", "BILLING_ALLOW_SHORT_LAG", "CHARGEBEE_SITE", "CHARGEBEE_API_KEY", "CLICKHOUSE_PASSWORD"];

describe("C11 BILLING_LAG_MS below the floor is refused at start", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.CHARGEBEE_SITE = "site-test";
    process.env.CHARGEBEE_API_KEY = "test_key_123";
    process.env.CLICKHOUSE_PASSWORD = "pw";
    delete process.env.BILLING_ALLOW_SHORT_LAG;
    resetConfig();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfig();
  });

  it("the live value, 120, stops the process with a message that says why", () => {
    process.env.BILLING_LAG_MS = "120";
    expect(() => getConfig()).toThrow(/BILLING_LAG_MS is 120 ms.*MILLISECONDS.*60000/s);
  });

  it("anything under thirty seconds is refused; 30 s, 45 s and the default minute are not", () => {
    expect(MIN_LAG_MS).toBe(30_000);
    process.env.BILLING_LAG_MS = "29999";
    expect(() => getConfig()).toThrow(/below the 30000 ms floor/);
    for (const ok of ["30000", "45000", "60000"]) {
      process.env.BILLING_LAG_MS = ok;
      resetConfig();
      expect(getConfig().lagMs).toBe(Number(ok));
    }
  });

  it("unset, it is a minute", () => {
    delete process.env.BILLING_LAG_MS;
    expect(getConfig().lagMs).toBe(60_000);
  });

  it("0 — no wait at all — is refused", () => {
    process.env.BILLING_LAG_MS = "0";
    expect(() => getConfig()).toThrow(/BILLING_LAG_MS/);
  });

  it("BILLING_ALLOW_SHORT_LAG=true — tests only — lifts the floor, and only exactly `true` does", () => {
    process.env.BILLING_LAG_MS = "120";
    process.env.BILLING_ALLOW_SHORT_LAG = "1";
    expect(() => getConfig()).toThrow(/BILLING_LAG_MS/);
    process.env.BILLING_ALLOW_SHORT_LAG = "true";
    resetConfig();
    expect(getConfig().lagMs).toBe(120);
  });

  it(".env.example documents the unit, the floor and why", () => {
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    expect(example).toMatch(/^BILLING_LAG_MS=60000$/m);
    expect(example).toMatch(/MILLISECONDS/);
    expect(example).toMatch(/under 30000/);
    expect(example).toMatch(/REFUSED/);
    expect(example).toMatch(/BILLING_ALLOW_SHORT_LAG=true lifts the floor for tests only/);
  });
});
