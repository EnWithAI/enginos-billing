/**
 * The one place dollars and credits convert into each other.
 *
 * A credit here is a BILLING UNIT with a fixed dollar rate, not a literal LLM
 * token. That distinction is why a single rate can exist at all: real model
 * tokens cost different amounts per model, so a grant of 1,000 of those would
 * be worth a different amount to every customer and no conversion would be
 * possible. A credit is worth `usdPerCredit`, always.
 *
 * Two directions, used at opposite ends of the system:
 *
 *   grant → budget    creditsToUsd()    once per grant, pushed to LiteLLM
 *   spend → capture   usdToCredits()    once per window, drawn from the ledger
 */

import { compare, divide, isPositive, multiply, subtract, decimal, type DecimalLike } from "./decimal";

/**
 * Validate the rate where it is read, not at the first capture of the month.
 *
 * A zero or negative rate is not a smaller charge — it is a division that
 * throws or silently inverts the sign of every capture.
 */
export function assertRate(usdPerCredit: DecimalLike): string {
  if (!isPositive(usdPerCredit)) {
    throw new RangeError(`USD_PER_CREDIT must be greater than zero, got ${String(usdPerCredit)}`);
  }
  return decimal(usdPerCredit);
}

/** Credits → dollars. Turns a grant into a LiteLLM `max_budget`. */
export function creditsToUsd(credits: DecimalLike, usdPerCredit: DecimalLike): string {
  assertRate(usdPerCredit);
  return multiply(credits, usdPerCredit);
}

/** Dollars → credits. Turns a window's spend into a capture amount. */
export function usdToCredits(usd: DecimalLike, usdPerCredit: DecimalLike): string {
  assertRate(usdPerCredit);
  return divide(usd, usdPerCredit);
}

/**
 * Split a fractional amount into what can be captured now and what carries forward.
 *
 * Only needed when the Chargebee ledger unit is configured as whole credits.
 * Truncating each window independently would be a silent discount: a tenant
 * making many small windows would round to zero every time and ride free.
 */
export function splitWholeCredits(credits: DecimalLike): { capture: string; residual: string } {
  const whole = truncateToWhole(credits);
  return { capture: whole, residual: subtract(credits, whole) };
}

function truncateToWhole(credits: DecimalLike): string {
  const [whole = "0"] = decimal(credits).split(".");
  // "-0" is a valid intermediate here and confuses equality downstream.
  return whole === "-0" ? "0" : whole;
}

/**
 * Is this capture worth sending?
 *
 * Chargebee rejects a zero-amount ledger operation, so a window with no traffic
 * is marked skipped and the cursor advances — a quiet tenant must not wedge the
 * pipeline behind an un-billable window.
 */
export function isBillable(credits: DecimalLike): boolean {
  return compare(credits, "0") > 0;
}
