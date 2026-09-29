import { describe, expect, it } from "vitest";
import { add, compare, decimal, divide, multiply, scaled, subtract } from "@/models/decimal";

describe("decimal", () => {
  it("parses and renders without drift", () => {
    expect(decimal("0.001")).toBe("0.001");
    expect(decimal("1000")).toBe("1000");
    expect(decimal("-2.5")).toBe("-2.5");
    expect(decimal("0")).toBe("0");
  });

  it("accepts numbers in exponential notation", () => {
    // Per-request LLM costs land here routinely; String(1e-7) is "1e-7".
    expect(decimal(1e-7)).toBe("0.0000001");
    expect(decimal(2.5e-9)).toBe("0.0000000025");
  });

  it("quantises below ten places by rounding half-up, not truncating", () => {
    expect(decimal("0.00000000005")).toBe("0.0000000001");
    expect(decimal("0.00000000004")).toBe("0");
  });

  it("adds exactly where float addition does not", () => {
    expect(add("0.1", "0.2")).toBe("0.3");
    expect(0.1 + 0.2).not.toBe(0.3); // the reason this module exists
  });

  it("sums ten thousand tiny costs without accumulating error", () => {
    const values = Array.from({ length: 10_000 }, () => "0.0000001");
    expect(add(...values)).toBe("0.001");
  });

  it("divides exactly at the billing rate", () => {
    expect(divide("0.25", "0.001")).toBe("250");
    expect(divide("1", "3")).toBe("0.3333333333");
    expect(divide("2", "3")).toBe("0.6666666667");
  });

  it("multiplies exactly for the grant conversion", () => {
    expect(multiply("1000", "0.001")).toBe("1");
    expect(multiply("2500", "0.0004")).toBe("1");
  });

  it("throws on division by zero rather than yielding Infinity", () => {
    expect(() => divide("1", "0")).toThrow(RangeError);
  });

  it("subtracts and compares consistently", () => {
    expect(subtract("1", "0.4")).toBe("0.6");
    expect(compare("0.1", "0.2")).toBe(-1);
    expect(compare("0.30", "0.3")).toBe(0);
  });

  it("rejects values that are not decimals", () => {
    expect(() => scaled("abc")).toThrow(TypeError);
    expect(() => scaled(Number.NaN)).toThrow(TypeError);
    expect(() => scaled(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});
