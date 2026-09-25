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
 *   spend → capture   usdToCredits()    once per capture, drawn from the ledger
 */

import { compare, divide, isPositive, multiply, decimal, type DecimalLike } from "./decimal";

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

/** Dollars → credits. Turns a capture's spend into its amount. */
export function usdToCredits(usd: DecimalLike, usdPerCredit: DecimalLike): string {
  assertRate(usdPerCredit);
  return divide(usd, usdPerCredit);
}

/**
 * Is this capture worth sending?
 *
 * Chargebee rejects a zero-amount ledger operation, so zero-cost usage is
 * never sent — the cursor simply moves past it. It must not wedge the poll
 * behind a capture that can never be accepted.
 *
 * There is no whole-credit truncation here any more. It existed for a ledger
 * unit that rejects fractions, and carrying the truncated remainder forward
 * needed somewhere to keep it — which, with no batch table, would have been an
 * internal ledger. Chargebee's ledger takes ten decimal places.
 */
export function isBillable(credits: DecimalLike): boolean {
  return compare(credits, "0") > 0;
}
