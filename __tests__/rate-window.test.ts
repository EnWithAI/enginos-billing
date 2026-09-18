import { describe, expect, it } from "vitest";
import { assertRate, creditsToUsd, isBillable, splitWholeCredits, usdToCredits } from "@/lib/rate";
import { add } from "@/lib/decimal";
import {
  DEFAULT_LAG_MS,
  findWindowGaps,
  isFallingBehind,
  nextWindow,
  toClickHouseTime,
} from "@/lib/window";

const RATE = "0.001";
const MINUTE = 60 * 1000;
const T0 = Date.UTC(2026, 8, 16, 12, 0, 0);

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

describe("window", () => {
  it("opens no window until the lag buffer has passed", () => {
    // Steady state on a fast cron. Must be idle, not an error.
    expect(nextWindow({ syncFrom: T0, now: T0 + 30_000 })).toBeNull();
    expect(nextWindow({ syncFrom: T0, now: T0 + DEFAULT_LAG_MS })).toBeNull();
  });

  it("opens a window once traffic has aged past the buffer", () => {
    expect(nextWindow({ syncFrom: T0, now: T0 + DEFAULT_LAG_MS + 10 * MINUTE })).toEqual({
      start: T0,
      end: T0 + 10 * MINUTE,
    });
  });

  it("produces contiguous windows that share no instant", () => {
    const first = nextWindow({ syncFrom: T0, now: T0 + DEFAULT_LAG_MS + 10 * MINUTE })!;
    const second = nextWindow({
      lastWindowEnd: first.end,
      syncFrom: T0,
      now: T0 + DEFAULT_LAG_MS + 25 * MINUTE,
    })!;

    expect(second.start).toBe(first.end); // no gap
    expect(second.end).toBeGreaterThan(second.start); // half-open
    expect(findWindowGaps([first, second], T0)).toEqual([]);
  });

  it("caps a long backlog instead of making one enormous window", () => {
    const window = nextWindow({ syncFrom: T0, now: T0 + 7 * 24 * 60 * MINUTE })!;
    expect(window.end - window.start).toBe(60 * MINUTE);
  });

  it("clamps a cursor behind syncFrom so history cannot be re-billed", () => {
    const window = nextWindow({
      lastWindowEnd: T0 - 30 * 24 * 60 * MINUTE,
      syncFrom: T0,
      now: T0 + DEFAULT_LAG_MS + 10 * MINUTE,
    })!;
    expect(window.start).toBe(T0);
  });

  it("detects the three ways a window chain can break", () => {
    expect(
      findWindowGaps(
        [
          { start: T0, end: T0 + MINUTE },
          { start: T0 + 5 * MINUTE, end: T0 + 6 * MINUTE },
        ],
        T0,
      ),
    ).toHaveLength(1); // gap

    expect(
      findWindowGaps(
        [
          { start: T0, end: T0 + 5 * MINUTE },
          { start: T0 + 2 * MINUTE, end: T0 + 6 * MINUTE },
        ],
        T0,
      ),
    ).toHaveLength(1); // overlap

    expect(findWindowGaps([{ start: T0 + MINUTE, end: T0 + 2 * MINUTE }], T0)).toHaveLength(1);
  });

  it("flags a cursor a week behind, because ClickHouse drops data at 90 days", () => {
    expect(isFallingBehind(T0, T0 + 6 * 24 * 60 * MINUTE)).toBe(false);
    expect(isFallingBehind(T0, T0 + 8 * 24 * 60 * MINUTE)).toBe(true);
    expect(isFallingBehind(null, T0)).toBe(false);
  });

  it("renders timestamps in the format ClickHouse parses", () => {
    expect(toClickHouseTime(T0)).toBe("2026-09-16 12:00:00.000");
  });
});

describe("chargebee findOperation hardening (regression)", () => {
  it("ignores an operation whose id does not match, even though the API returns it", async () => {
    // MEASURED: Chargebee's /ledger_operations IGNORES `id[is]`. It returns the
    // subscription's operations regardless, so a query for a batch id that was
    // never captured comes back holding the grant's `allocation`. Trusting that
    // made every first capture look already-done — the charge was skipped while
    // the window was marked billed.
    const { createChargebee } = await import("@/lib/chargebee");

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          list: [{ ledger_operation: { id: "some-other-operation", type: "allocation" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const cb = createChargebee({ site: "test", apiKey: "k", fetchImpl });

    expect(await cb.findOperation("our-batch-uuid", "sub_1")).toBeNull();
  });

  it("matches only a real capture under our own id", async () => {
    const { createChargebee } = await import("@/lib/chargebee");

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          list: [
            { ledger_operation: { id: "our-batch-uuid", type: "allocation" } }, // grant, not a charge
            { ledger_operation: { id: "our-batch-uuid", type: "capture" } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const cb = createChargebee({ site: "test", apiKey: "k", fetchImpl });

    expect(await cb.findOperation("our-batch-uuid", "sub_1")).toEqual({ id: "our-batch-uuid" });
  });
});
