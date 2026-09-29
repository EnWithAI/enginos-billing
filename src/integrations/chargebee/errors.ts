/**
 * What a Chargebee failure MEANS for billing.
 *
 * Errors are classified, not just thrown. A timeout is NOT a failure: it says
 * nothing about whether the charge landed, so the sync stays unresolved and
 * the next tick asks about it. Treating it as failure loses the usage;
 * treating it as success loses the money. Every code set below is the answer
 * to "which of those is this".
 */

export const CAPTURE_OK = "captured";
export const CAPTURE_REPLAYED = "replayed";
export const CAPTURE_RETRYABLE = "retryable";
export const CAPTURE_TERMINAL = "terminal";
export const CAPTURE_NO_LEDGER = "no_ledger";
/** The customer is out of credits — a business state, not a defect. */
export const CAPTURE_INSUFFICIENT = "insufficient";
/**
 * Chargebee throttled us.
 *
 * Split out of `retryable` because it is the one refusal we know was made
 * BEFORE the operation was applied: a 429 is the API declining to look at the
 * request at all. So unlike a timeout it needs no lookup to resolve — it is
 * simply sent again later — and unlike a terminal error it says nothing about
 * the request being wrong. Collapsing it into "unknown" made a tenant under
 * load look identical to a tenant whose charge might have silently landed.
 */
export const CAPTURE_RATE_LIMITED = "rate_limited";

export type CaptureKind =
  | typeof CAPTURE_OK
  | typeof CAPTURE_REPLAYED
  | typeof CAPTURE_RETRYABLE
  | typeof CAPTURE_TERMINAL
  | typeof CAPTURE_NO_LEDGER
  | typeof CAPTURE_INSUFFICIENT
  | typeof CAPTURE_RATE_LIMITED;

export interface CaptureResult {
  kind: CaptureKind;
  operationId?: string;
  balanceAfter?: string | null;
  error?: ChargebeeError;
}

/**
 * Codes meaning "this subscription has no prepaid ledger".
 *
 * Distinct from a hard failure: nothing was charged and nothing will be until
 * someone configures the ledger, so the usage sync HOLDS the window (INVALID)
 * and bills it once the configuration is fixed — it no longer moves past it.
 * `invalid_request` is Chargebee's generic 400 as well, so this also catches
 * requests that are wrong for other reasons; both need a person.
 */
export const NO_LEDGER_CODES = new Set(["resource_not_found", "invalid_request"]);

/**
 * Codes that indicate our id was already used — i.e. the charge landed.
 *
 * MEASURED against the live site on 2026-09-24, by re-POSTing a capture whose
 * id already existed: HTTP 400, `type: invalid_request`, and BOTH
 * `api_error_code` and `error_code` set to `ERROR_DUPLICATE_OPERATION_ID`,
 * "Duplicate operation id: one or more operationId values conflict." The
 * operation and the balance were unchanged — Chargebee refuses the reuse
 * rather than charging it again.
 *
 * It reaches us whenever a capture lands between another caller's lookup and
 * its send: a manual sync beside the cron, a second replica, or an old worker
 * during a rollout. Before it was pinned it fell through to `terminal`, so a
 * window that HAD been charged was recorded INVALID and held its tenant on the
 * five-minute-to-an-hour backoff.
 *
 * The other three are the unmeasured guesses this set used to hold. They stay
 * because a duplicate is never taken on the code alone: `capture()` retrieves
 * the operation and settles only if a capture of ours is really there.
 */
const DUPLICATE_CODES = new Set([
  "ERROR_DUPLICATE_OPERATION_ID",
  "duplicate_entry",
  "resource_already_exists",
  "idempotency_replayed",
]);

/** Is this Chargebee saying the operation id is already taken? Both code fields are checked. */
export function isDuplicateOperation(err: ChargebeeError): boolean {
  return hasCode(err, DUPLICATE_CODES);
}

/**
 * MEASURED against the live site, because the API reference does not document
 * it: a capture beyond the usable balance on a CAPPED credit unit returns
 * HTTP 400 with `api_error_code: ERROR_INSUFFICIENT_BALANCE` and the message
 * "Not enough balance exists in the account."
 *
 * It is terminal — a retry cannot fix it — but it is NOT a defect. The customer
 * simply ran out, which needs a top-up and a different alert from a malformed
 * request. Note this only fires on a capped unit; a unit with unlimited
 * overdraft silently accepts the capture and accrues debt instead.
 */
const INSUFFICIENT_BALANCE_CODES = new Set(["ERROR_INSUFFICIENT_BALANCE"]);

/**
 * Chargebee will not talk to us at all — a wrong, revoked or rotated API key.
 *
 * Treated as UNKNOWN, not terminal. It says nothing about whether a charge
 * landed, and it is fixed by a person putting the right key back, after which
 * the same capture settles on its own. Terminal would have been the honest
 * reading of "a retry cannot fix this", but the consequence was worse: the
 * error threw out of the tenant run before `classify()` was ever reached, so a
 * bad key produced no batch, no status, no attempt count and no escalation —
 * billing simply stopped, and the only trace was one log line per tick.
 *
 * MEASURED against the live site: HTTP 401, `api_error_code:
 * api_authentication_failed`, "Sorry, authentication failed. Invalid api key".
 */
const AUTH_FAILURE_CODES = new Set(["api_authentication_failed"]);

/** Is this Chargebee refusing to authenticate us, rather than refusing a charge? */
export function isAuthFailure(err: ChargebeeError): boolean {
  return AUTH_FAILURE_CODES.has(err.apiErrorCode ?? "") || err.status === 401;
}

/**
 * Chargebee is refusing to serve the SITE, not the request.
 *
 * MEASURED against the live site on 2026-09-22, after a test site was
 * disabled: HTTP 403, `api_error_code: request_blocked`, `error_code:
 * api_disabled`, "The site is not enabled".
 *
 * Classed with the unknowns for the same reason as a bad credential, and it
 * took an outage to notice it was missing: a 403 is not >= 500 and not a 401,
 * so it fell through every branch to `terminal` — and on the LOOKUP path it did
 * not even reach classify(), it threw out of the tenant run. The capture was
 * left in whatever state it was in and the only trace was a generic
 * `tenant_error` line. Nothing was charged and nothing was lost, but an
 * operator had no way to tell a disabled site from a bug.
 *
 * It says nothing about whether a charge landed, it is fixed by a person, and
 * it stops EVERY tenant at once — which is what separates it from a per-tenant
 * defect and why it deserves its own metric.
 */
export function isSiteBlocked(err: ChargebeeError): boolean {
  return hasCode(err, SITE_BLOCKED_CODES) || err.status === 403;
}

/** See isSiteBlocked. `api_disabled` arrives as `error_code`, `request_blocked` as `api_error_code`. */
const SITE_BLOCKED_CODES = new Set(["request_blocked", "api_disabled", "site_not_ready"]);

/** Chargebee cannot be reached or will not answer — a person, or time, fixes it. */
export function isUnreachable(err: ChargebeeError): boolean {
  return isAuthFailure(err) || isSiteBlocked(err);
}

/**
 * Is Chargebee throttling us?
 *
 * The status code is the reliable signal; the code set is there because
 * Chargebee documents `api_request_limit_exceeded` on some plans and returns it
 * alongside the 429 rather than instead of it.
 */
export function isRateLimited(err: ChargebeeError): boolean {
  return err.status === 429 || RATE_LIMIT_CODES.has(err.apiErrorCode ?? "");
}

const RATE_LIMIT_CODES = new Set(["api_request_limit_exceeded", "site_not_ready_to_accept_request"]);

/** Chargebee's "no such resource" — a definite answer, not a failure to get one. */
export function isResourceNotFound(err: ChargebeeError): boolean {
  return err.status === 404 && err.apiErrorCode === "resource_not_found";
}

/**
 * Chargebee answered, and refused THIS request: a 4xx that is not throttling
 * (a 429 refuses every request alike) and not a refusal to serve us at all (a
 * bad key or a disabled site, which stop every request alike).
 *
 * What it tells a caller working through several requests is that the next
 * one is worth sending: Chargebee is up and talking, this one was wrong. It
 * does NOT, on its own, prove nothing landed — an idempotency-key conflict is
 * a 400 too, and the request that first used the key may have — so a caller
 * that re-sends later must still look before it does (the top-up guard does).
 */
export function isDefiniteRefusal(err: ChargebeeError): boolean {
  const status = err.status ?? 0;
  return status >= 400 && status < 500 && !err.retryable && !isRateLimited(err) && !isUnreachable(err);
}

export interface ChargebeeError extends Error {
  status?: number;
  apiErrorCode?: string;
  /**
   * Chargebee's second code field. Usually the same value as `api_error_code`,
   * but not always — a disabled site says `api_disabled` only here — so a code
   * that matters is looked for in both.
   */
  errorCode?: string;
  retryable?: boolean;
}

/** Does either of the error's code fields carry one of these codes? */
function hasCode(err: ChargebeeError, codes: ReadonlySet<string>): boolean {
  return codes.has(err.apiErrorCode ?? "") || codes.has(err.errorCode ?? "");
}

/**
 * Turn a thrown Chargebee error into an outcome the sync loop can act on.
 *
 * The distinction that matters: `retryable` leaves the batch pending so the same
 * id replays, `terminal` stops and asks for a human, `replayed` means our id was
 * already used and the money has therefore already moved. A pure function of
 * the error: `capture()` confirms a `replayed` by lookup before it is believed.
 */
export function classify(err: ChargebeeError, id: string): CaptureResult {
  if (isDuplicateOperation(err)) {
    return { kind: CAPTURE_REPLAYED, operationId: id, error: err };
  }
  // BEFORE the generic retryable branch, which a 429 also satisfies. A throttled
  // request was refused before it was applied, so it is a definite "not done"
  // rather than an unknown, and the caller backs off instead of paying for a
  // lookup that can only say the same thing.
  if (isRateLimited(err)) {
    return { kind: CAPTURE_RATE_LIMITED, error: err };
  }
  if (err.retryable) {
    return { kind: CAPTURE_RETRYABLE, error: err };
  }
  if (INSUFFICIENT_BALANCE_CODES.has(err.apiErrorCode ?? "")) {
    return { kind: CAPTURE_INSUFFICIENT, error: err };
  }
  if (NO_LEDGER_CODES.has(err.apiErrorCode ?? "")) {
    return { kind: CAPTURE_NO_LEDGER, error: err };
  }
  // Before the terminal fallback: we cannot see Chargebee, so we cannot know.
  // A rejected key and a disabled site are both "ask again once someone fixes
  // it", never "this charge was refused".
  if (isUnreachable(err)) {
    return { kind: CAPTURE_RETRYABLE, error: err };
  }
  return { kind: CAPTURE_TERMINAL, error: err };
}
