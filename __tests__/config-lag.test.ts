/**
 * C11: BILLING_LAG_MS is in milliseconds, and a seconds-sized value is refused.
 *
 * The live .env carried `BILLING_LAG_MS=120` — 0.12 s, meant as two minutes —
 * so the worker read up to the present instant and billed windows ClickHouse
 * was still inserting into; a row that landed a moment late was never charged
 * (proved live in L2). The process now refuses to start on such a value.
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
    expect(() => getConfig()).toThrow(/BILLING_LAG_MS is 120 ms.*MILLISECONDS.*120000/s);
  });

  it("anything under ten seconds is refused; ten seconds and the documented two minutes are not", () => {
    expect(MIN_LAG_MS).toBe(10_000);
    process.env.BILLING_LAG_MS = "9999";
    expect(() => getConfig()).toThrow(/below the 10000 ms floor/);
    for (const ok of ["10000", "120000"]) {
      process.env.BILLING_LAG_MS = ok;
      resetConfig();
      expect(getConfig().lagMs).toBe(Number(ok));
    }
  });

  it("unset, it is ten seconds", () => {
    delete process.env.BILLING_LAG_MS;
    expect(getConfig().lagMs).toBe(10_000);
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
    expect(example).toMatch(/^BILLING_LAG_MS=10000$/m);
    expect(example).toMatch(/MILLISECONDS/);
    expect(example).toMatch(/10000 is REFUSED/);
    expect(example).toMatch(/BILLING_ALLOW_SHORT_LAG=true lifts the floor for tests only/);
  });
});
