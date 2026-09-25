/**
 * Fixed-point decimal arithmetic on BigInt, scaled to 10 places.
 *
 * Money does not survive binary floating point. `0.1 + 0.2` is the textbook
 * case, but the one that bites here is division: converting dollars to credits
 * divides by a rate like 0.001, and a float result that lands a half-ulp low
 * turns 250 credits into 249.99999999999997. Captured a few thousand times,
 * that drifts away from Chargebee's ledger.
 *
 * Ten places is not arbitrary — it is the precision Chargebee accepts on a
 * ledger operation amount, so a value that survives this module survives the
 * wire without further rounding.
 *
 * Values cross module boundaries as decimal STRINGS. A JS number is fine as an
 * input (ClickHouse hands us float64 and there is no more precision to be had)
 * but never as a carrier between steps, because each hop can lose a digit.
 *
 * EXPONENT NOTATION IS ACCEPTED, EXACTLY. Two sources print it for perfectly
 * ordinary money: a JS number below 1e-6 (`String(5e-7)` is "5e-7"), and
 * Prisma's `Decimal`, whose toString() switches to "5e-7" at the same point.
 * A $0.0000005 window read back from `chargebee_sync` used to throw here before
 * its claim, every tick, for ever — the tenant's billing wedged behind one
 * row. The exponent is applied by moving the decimal point in the digit string,
 * never through a float, so "5e-7" and "0.0000005" are the same value to the
 * last place. Values leave this module in plain notation only.
 */

/** Decimal places carried internally. Matches Chargebee's ledger precision. */
export const PLACES = 10;

const SCALE = 10n ** BigInt(PLACES);
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;
const EXPONENT_PATTERN = /^(-?)(\d+)(?:\.(\d+))?[eE]([-+]?\d+)$/;

/**
 * The largest exponent expanded. Far past any amount of money (DECIMAL(20,10)
 * holds ten integer digits) and small enough that a hostile "1e999999999"
 * cannot make us build a billion-character string.
 */
const MAX_EXPONENT = 400;

/** Anything this module accepts as a decimal input. */
export type DecimalLike = string | number | bigint | { toString(): string };

/**
 * Parse into the scaled BigInt representation.
 *
 * Accepts a JS number for values that originate as floats (a ClickHouse sum),
 * converting through its shortest round-trip string so the binary
 * representation is pinned once, here, rather than drifting through later
 * arithmetic.
 */
export function scaled(value: DecimalLike): bigint {
  if (typeof value === "bigint") return value;

  const raw = typeof value === "number" ? numberToString(value) : String(value).trim();
  const text = EXPONENT_PATTERN.test(raw) ? expandExponent(raw) : raw;

  if (!DECIMAL_PATTERN.test(text)) {
    throw new TypeError(`Not a decimal value: ${JSON.stringify(String(value))}`);
  }

  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? text.slice(1) : text).split(".");

  // Round half-up on the first discarded digit rather than truncating, so a
  // value already more precise than we carry does not drift downward on every
  // pass through.
  const kept = fraction.slice(0, PLACES).padEnd(PLACES, "0");
  const roundUp = fraction.length > PLACES && Number(fraction[PLACES]) >= 5;

  let result = BigInt(whole) * SCALE + BigInt(kept);
  if (roundUp) result += 1n;

  return negative ? -result : result;
}

/** Render a scaled BigInt as a decimal string, trailing zeros trimmed. */
export function unscaled(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;

  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(PLACES, "0").replace(/0+$/, "");

  const text = fraction ? `${whole}.${fraction}` : `${whole}`;
  return negative && (whole !== 0n || fraction) ? `-${text}` : text;
}

/** Normalise any decimal input to the canonical string form. */
export function decimal(value: DecimalLike): string {
  return unscaled(scaled(value));
}

/** Sum exactly. */
export function add(...values: DecimalLike[]): string {
  return unscaled(values.reduce<bigint>((total, value) => total + scaled(value), 0n));
}

/** `a - b`, exactly. */
export function subtract(a: DecimalLike, b: DecimalLike): string {
  return unscaled(scaled(a) - scaled(b));
}

/** `a * b`, rounded half-up to PLACES. */
export function multiply(a: DecimalLike, b: DecimalLike): string {
  return unscaled(divideScaled(scaled(a) * scaled(b), SCALE));
}

/** `a / b`, rounded half-up to PLACES. Throws on a zero divisor. */
export function divide(a: DecimalLike, b: DecimalLike): string {
  const divisor = scaled(b);
  if (divisor === 0n) throw new RangeError("Division by zero");
  return unscaled(divideScaled(scaled(a) * SCALE, divisor));
}

/** Negative, zero, or positive — the sign of `a - b`. */
export function compare(a: DecimalLike, b: DecimalLike): -1 | 0 | 1 {
  const left = scaled(a);
  const right = scaled(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isPositive(value: DecimalLike): boolean {
  return scaled(value) > 0n;
}


/**
 * Integer division rounding half-up on the absolute value, so -0.5 goes to -1
 * rather than 0. Symmetry matters: an adjustment computed as a negative
 * difference must round the same distance as the positive one it corrects.
 */
function divideScaled(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}

/**
 * The exact, exponent-free decimal string for a value read from the database.
 *
 * Prisma returns `DECIMAL` columns as `Decimal` objects, and their toString()
 * prints exponent notation below 1e-6 — a `billed_usd` of 0.0000005 reads back
 * as "5e-7". `toFixed()` with no argument is the same value in plain notation,
 * unrounded, so that is what crosses the repository boundary. Anything else
 * (a string, a number) goes through `decimal()`, which accepts both notations.
 */
export function fromDb(value: DecimalLike | { toFixed(): string }): string {
  const plain =
    value != null && typeof value === "object" && typeof (value as { toFixed?: unknown }).toFixed === "function"
      ? (value as { toFixed(): string }).toFixed()
      : (value as DecimalLike);
  return decimal(plain);
}

/**
 * A JS number as its shortest round-trip string — which may be exponential
 * (`String(1e-7)` is "1e-7"; per-request LLM costs land exactly there, so this
 * is the hot path, not an edge case). `scaled()` expands the exponent exactly.
 */
function numberToString(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError(`Not a finite number: ${value}`);
  return String(value);
}

/**
 * "5e-7" → "0.0000005", "1.25e+3" → "1250", by moving the decimal point in the
 * digit string. Exact: no float is involved at any step.
 */
function expandExponent(text: string): string {
  const [, sign = "", whole = "0", fraction = "", exponentText = "0"] = EXPONENT_PATTERN.exec(text)!;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_EXPONENT) {
    throw new TypeError(`Not a decimal value: ${JSON.stringify(text)}`);
  }

  const digits = whole + fraction;
  const point = whole.length + exponent; // where the decimal point lands in `digits`
  let intPart: string;
  let fracPart: string;
  if (point <= 0) {
    intPart = "0";
    fracPart = "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    intPart = digits + "0".repeat(point - digits.length);
    fracPart = "";
  } else {
    intPart = digits.slice(0, point);
    fracPart = digits.slice(point);
  }

  intPart = intPart.replace(/^0+(?=\d)/, "");
  return fracPart ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}
