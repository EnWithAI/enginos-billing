/**
 * Sync states — the state of the CHARGEBEE OPERATION, never of the cursor.
 *
 * The cursor is `billing_account.last_processed_ingested_at` and answers a
 * different question ("where is the worker"). These answer "what did Chargebee
 * say", and the split between RESOLVED and UNRESOLVED is what connects the two:
 * the cursor may move past a resolved row, and is held by an unresolved one.
 *
 * There is no generic FAILED. It answered "it did not work" without saying
 * which of four very different things happened — throttled, unknown, out of
 * credits, malformed — and each of them wants a different response.
 */
export const SYNC = {
  /** Written, not yet sent. The id has never been on the wire, so a send is safe. */
  PENDING: "PENDING",
  /**
   * On the wire, CLAIMED by the one caller sending it. A crash leaves this;
   * once the claim's lease has run out it is resolved by lookup, never by a
   * blind re-send.
   */
  PROCESSING: "PROCESSING",
  /** Chargebee took it, had already taken it, or there was nothing to charge. */
  SUCCESS: "SUCCESS",
  /** Timeout, 5xx, bad credential, disabled site — we cannot tell. Ask, do not guess. */
  UNKNOWN: "UNKNOWN",
  /** Throttled. Refused before it was applied, so it is simply sent again on a backoff. */
  RATE_LIMITING: "RATE_LIMITING",
  /**
   * No balance. Not retried at all while the account is `exhausted` — the
   * usage sync holds the whole tenant — and due at once when credits come
   * back, so a top-up still clears it with no requeue step.
   */
  OUT_OF_CREDITS: "OUT_OF_CREDITS",
  /** Bad data or configuration. Retried on a long backoff, but it needs a person. */
  INVALID: "INVALID",
  /**
   * Refused (OUT_OF_CREDITS or INVALID), and the subscription it is pinned to
   * has ENDED — the account is cancelled, or has moved to another
   * subscription. Nothing was charged and nothing ever will be: no top-up
   * reaches an ended subscription. Resolved, so it stops holding the tenant,
   * and logged once as `billing.sync.written_off`. Its amount is the revenue
   * given up.
   */
  WRITTEN_OFF: "WRITTEN_OFF",
} as const;

/** Resolved rows the cursor may move past: charged, or given up for good. */
export function isSettled(status: string | null | undefined): boolean {
  return status === SYNC.SUCCESS || status === SYNC.WRITTEN_OFF;
}

/** These hold the tenant, and each tick tries to resolve the oldest of them. */
export const UNRESOLVED = [
  SYNC.PENDING,
  SYNC.PROCESSING,
  SYNC.UNKNOWN,
  SYNC.RATE_LIMITING,
  SYNC.OUT_OF_CREDITS,
  SYNC.INVALID,
] as const;

/**
 * How long a PROCESSING row belongs to the caller that claimed it.
 *
 * PROCESSING means one of two things, and nothing in the row says which: a
 * sender that is still waiting on Chargebee, or one that died. Recovering the
 * first is not recovery — it is a second caller (a manual sync beside the
 * cron, another replica, an old worker during a rollout) looking the id up,
 * getting a 404 because the first POST has not landed yet, and sending it
 * again. So the row is left alone until its sender cannot still be alive.
 *
 * That bound is the longest one send can take: the recovery lookup and the
 * capture each make up to three 20-second attempts with backoff (the 20
 * seconds cover the whole exchange, response body included), and a
 * duplicate answer adds one more lookup and a balance read — about three and a
 * half minutes at the very worst. Five minutes is the sweep's own
 * `executionTimeout`, and the margin over that worst case. The price is paid
 * only after a crash: the row a dead worker left waits out the lease before it
 * is settled, and the usage behind it waits with it — delayed, never lost.
 *
 * If a sender is ever paused for longer than this (a suspended host), the
 * claim compare-and-set still stops two callers sending at once, and a late
 * POST is refused by Chargebee as a duplicate and settled as a replay.
 */
export const PROCESSING_LEASE_MS = 5 * 60_000;

/**
 * How long to leave a row alone before trying it again.
 *
 * Declared beside the statuses because it is the other half of what each one
 * MEANS: `RATE_LIMITING` without a backoff is just a slower way of being rate
 * limited, and `INVALID` without one is the blind retry §7 rules out.
 *
 *   OUT_OF_CREDITS   never on a timer. While the account is `exhausted` the
 *                    usage sync does not reach the row at all (holdExhausted
 *                    in usage-sync.service.ts): every retry would be refused,
 *                    and each one cost Chargebee a lookup and a refused
 *                    capture. Credits coming back is what activate() sees (a
 *                    top-up, a renewal, a webhook, the daily resync), and it
 *                    moves the account out of `exhausted`; from then the row
 *                    is due at once, so a top-up bills it on the next tick.
 *   PENDING          every tick. Nothing has been sent; there is nothing to
 *   UNKNOWN          back off from, and an unknown is resolved by ONE cheap GET
 *                    whose whole purpose is to run soon after the failure. The
 *                    claim (a compare-and-set on status and attempt count) is
 *                    what stops two callers taking the same row.
 *   PROCESSING       once the sender's lease is over — PROCESSING_LEASE_MS.
 *   RATE_LIMITING    1 min doubling to 15. Chargebee asked us to slow down.
 *   INVALID          5 min doubling to 1 hour, so a corrected configuration
 *                    heals itself within the hour without anyone touching the
 *                    database — but the row is not hammered while it is broken.
 */
export function retryDelayMs(status: string, attemptCount: number): number {
  const backoff = (baseMs: number, capMs: number) =>
    Math.min(capMs, baseMs * 2 ** Math.max(0, attemptCount - 1));

  if (status === SYNC.PROCESSING) return PROCESSING_LEASE_MS;
  if (status === SYNC.RATE_LIMITING) return backoff(60_000, 15 * 60_000);
  if (status === SYNC.INVALID) return backoff(5 * 60_000, 60 * 60_000);
  return 0;
}
