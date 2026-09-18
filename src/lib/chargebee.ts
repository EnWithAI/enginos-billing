/**
 * Chargebee prepaid credit ledger.
 *
 * The pinned SDK (2.x) has no binding for these endpoints, so they are called
 * over plain REST — the same approach the existing chargebee-checkout prototype
 * takes for balances.
 *
 * Two things here are the difference between billing correctly and billing twice:
 *
 * 1. Every capture carries a client-supplied `id` — our batch UUID. Chargebee
 *    documents that for external ledger operations "the same value should be
 *    reused across retries". Without it, a crash between Chargebee accepting the
 *    charge and us recording it charges the customer again on the next tick.
 *    The prototype route omits this, which is a live bug.
 *
 * 2. Errors are classified, not just thrown. A timeout is NOT a failure: it says
 *    nothing about whether the charge landed, so the batch must stay pending and
 *    replay with the same id. Treating it as failure loses the usage; treating
 *    it as success loses the money.
 *
 * Deliberately NOT used: the `chargebee-idempotency-key` header. Its replay
 * window is 30 minutes, far shorter than a batch stuck behind an outage.
 */

import { getConfig } from "./config";
import { decimal } from "./decimal";

export const CAPTURE_OK = "captured";
export const CAPTURE_REPLAYED = "replayed";
export const CAPTURE_RETRYABLE = "retryable";
export const CAPTURE_TERMINAL = "terminal";
export const CAPTURE_NO_LEDGER = "no_ledger";
/** The customer is out of credits — a business state, not a defect. */
export const CAPTURE_INSUFFICIENT = "insufficient";

export type CaptureKind =
  | typeof CAPTURE_OK
  | typeof CAPTURE_REPLAYED
  | typeof CAPTURE_RETRYABLE
  | typeof CAPTURE_TERMINAL
  | typeof CAPTURE_NO_LEDGER
  | typeof CAPTURE_INSUFFICIENT;

export interface CaptureResult {
  kind: CaptureKind;
  operationId?: string;
  balanceAfter?: string | null;
  error?: ChargebeeError;
}

/**
 * Codes meaning "this subscription has no prepaid ledger".
 *
 * Distinct from a hard failure: nothing was charged and nothing will be, so the
 * caller may safely skip the window rather than wedging behind it.
 */
const NO_LEDGER_CODES = new Set(["resource_not_found", "invalid_request"]);

/**
 * Codes that indicate our id was already used — i.e. the charge landed.
 *
 * NOTE: Chargebee's documentation does not enumerate the code returned when a
 * client-supplied ledger operation id is reused, nor the one for an exhausted
 * balance. These are the plausible candidates; the real values must be captured
 * against the test site and pinned here. Until then `findOperation()` is the
 * safety net — see `captureIdempotent()`.
 */
const DUPLICATE_CODES = new Set(["duplicate_entry", "resource_already_exists", "idempotency_replayed"]);

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

export interface ChargebeeError extends Error {
  status?: number;
  apiErrorCode?: string;
  retryable?: boolean;
}

export interface LedgerBalance {
  unitId: string;
  unitName: string;
  usable: string;
  onHold: string;
}

export interface CaptureArgs {
  id: string;
  subscriptionId: string;
  unitId: string;
  amount: string;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface ChargebeeClient {
  createCustomer(args: { id: string; email?: string; company?: string }): Promise<{ id: string }>;
  capture(args: CaptureArgs): Promise<CaptureResult>;
  captureIdempotent(args: CaptureArgs): Promise<CaptureResult>;
  findOperation(id: string, subscriptionId: string): Promise<{ id: string } | null>;
  balance(subscriptionId: string): Promise<LedgerBalance | null>;
  checkoutPage(args: {
    customerId: string;
    itemPriceId: string;
    quantity?: number;
  }): Promise<Record<string, unknown>>;
  portalSession(args: { customerId: string; redirectUrl: string }): Promise<Record<string, unknown>>;
  grantedCredits(subscriptionId: string, unitId?: string): Promise<{ credits: string; blocks: number }>;
  subscription(id: string): Promise<Record<string, unknown> | null>;
  activeSubscriptions(customerId: string): Promise<Array<Record<string, any>>>;
  allocate(args: {
    subscriptionId: string;
    unitId: string;
    amount: string;
    expiresAt: number;
    idempotencyKey: string;
  }): Promise<{ operationId: string; balanceAfter: string | null }>;
  checkoutOneTime(args: { customerId: string; itemPriceId: string }): Promise<Record<string, unknown>>;
  paidInvoicesFor(customerId: string, itemPriceId: string): Promise<Array<Record<string, any>>>;
}

export interface ChargebeeOptions {
  site?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function createChargebee(options: ChargebeeOptions = {}): ChargebeeClient {
  const site = options.site ?? getConfig().chargebee.site;
  const apiKey = options.apiKey ?? getConfig().chargebee.apiKey;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const base = `https://${site}.chargebee.com/api/v2`;
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;

  async function request(
    method: "GET" | "POST",
    path: string,
    params: Record<string, unknown> = {},
    idempotencyKey?: string,
  ): Promise<Record<string, any>> {
    const url = new URL(`${base}${path}`);
    let body: URLSearchParams | undefined;

    if (method === "GET") {
      for (const [key, value] of Object.entries(params)) {
        if (value != null) url.searchParams.set(key, String(value));
      }
    } else {
      body = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value != null) body.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: auth,
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          // Only used where Chargebee gives us no client-supplied id of our
          // own — currently just /allocate. Its window is 30 minutes, which is
          // fine for a top-up retried seconds later and useless for anything
          // that might be stuck for hours. Capture does NOT rely on it.
          ...(idempotencyKey ? { "chargebee-idempotency-key": idempotencyKey } : {}),
        },
        ...(body ? { body } : {}),
      });
    } catch (cause) {
      // A network failure or abort says nothing about whether the request was
      // applied, so it is retryable rather than failed.
      throw Object.assign(new Error(`Chargebee ${path} unreachable: ${(cause as Error).message}`), {
        retryable: true,
        cause,
      }) as ChargebeeError;
    } finally {
      clearTimeout(timer);
    }

    const payload = (await response.json().catch(() => ({}))) as Record<string, any>;

    if (!response.ok) {
      throw Object.assign(new Error(payload.message || `Chargebee ${path} failed (${response.status})`), {
        status: response.status,
        apiErrorCode: payload.api_error_code,
        // 5xx and 429 may succeed on retry; 4xx will not.
        retryable: response.status >= 500 || response.status === 429,
      }) as ChargebeeError;
    }

    return payload;
  }

  /** Retry only what a retry could fix, with a bounded backoff. */
  async function withRetry<T>(run: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await run();
      } catch (err) {
        lastError = err;
        if (!(err as ChargebeeError).retryable || attempt === maxAttempts) throw err;
        await sleep(2 ** (attempt - 1) * 500);
      }
    }
    throw lastError;
  }

  /**
   * Create the customer with an id WE choose (the tenant UUID).
   *
   * Letting Chargebee generate one would make a retry create a second customer
   * for the same tenant. Supplying it means a retry collides on Chargebee's side
   * and we can treat "already exists" as success.
   */
  async function createCustomer({
    id,
    email,
    company,
  }: {
    id: string;
    email?: string;
    company?: string;
  }): Promise<{ id: string }> {
    try {
      const payload = await withRetry(() =>
        request("POST", "/customers", { id, email, company }),
      );
      return { id: payload.customer?.id ?? id };
    } catch (err) {
      const code = (err as ChargebeeError).apiErrorCode;
      if (code === "duplicate_entry" || code === "resource_already_exists") {
        return { id };
      }
      throw err;
    }
  }

  /**
   * Consume credits against a subscription's grant.
   *
   * `ledger_operation_timestamp` is always now, never the window's end: the API
   * rejects anything older than ten minutes, and a capture is a balance drawdown
   * rather than a dated invoice line. The window it covers travels in metadata
   * so the operation stays auditable.
   */
  async function capture(args: CaptureArgs): Promise<CaptureResult> {
    const amount = decimal(args.amount);
    const now = args.now ?? Date.now();

    try {
      const payload = await withRetry(() =>
        request("POST", "/ledger_operations/capture", {
          id: args.id,
          subscription_id: args.subscriptionId,
          unit_id: args.unitId,
          amount,
          ledger_operation_timestamp: Math.floor(now / 1000),
          ...(args.metadata ? { "metadata[json]": JSON.stringify(args.metadata) } : {}),
        }),
      );

      return {
        kind: CAPTURE_OK,
        operationId: operationIdOf(payload) ?? args.id,
        balanceAfter: usableBalanceOf(payload),
      };
    } catch (err) {
      return classify(err as ChargebeeError, args.id);
    }
  }

  /**
   * Capture, with a pre-flight existence check as the safety net.
   *
   * Chargebee's own replay behaviour for a reused ledger operation id is implied
   * by the docs but not stated. Until it is confirmed against the test site,
   * check first: if an operation with our id already exists, the money has
   * already moved and we must not send it again.
   *
   * Check-then-act would race on its own. It does not race here because the
   * caller holds a one-pending-batch-per-tenant unique index and the workflow
   * runs with maxRuns: 1.
   */
  async function captureIdempotent(args: CaptureArgs): Promise<CaptureResult> {
    try {
      const existing = await findOperation(args.id, args.subscriptionId);
      if (existing) {
        return { kind: CAPTURE_REPLAYED, operationId: existing.id, balanceAfter: null };
      }
    } catch (err) {
      // A failed pre-check must not block the capture — the unique indexes are
      // still holding, and refusing to bill on a transient read error would
      // wedge the pipeline. Fall through and let capture() classify.
      if (!(err as ChargebeeError).retryable) throw err;
    }

    return capture(args);
  }

  /**
   * Find a capture we previously recorded under `id`.
   *
   * MEASURED, NOT ASSUMED: Chargebee's /ledger_operations list endpoint IGNORES
   * the `id[is]` filter. A query for a made-up id returns whatever operations
   * the subscription has — typically the `allocation` from the credit grant.
   *
   * Trusting that response made `captureIdempotent` believe every first capture
   * had already happened, so it skipped the charge while the window was marked
   * billed. Silent revenue loss, and the "safety net" was the cause.
   *
   * So the filtering is done here, client-side, on two axes:
   *   - the id must actually match ours
   *   - the type must be a capture, never an `allocation` (a grant is not a
   *     charge, and matching one would suppress a real capture forever)
   */
  async function findOperation(id: string, subscriptionId: string) {
    const payload = await withRetry(() =>
      request("GET", "/ledger_operations", {
        "subscription_id[is]": subscriptionId,
        limit: 100,
      }),
    );

    const operations: Array<Record<string, any>> = (payload.list ?? [])
      .map((entry: Record<string, any>) => entry.ledger_operation)
      .filter(Boolean);

    const match = operations.find(
      (op) => String(op.id) === String(id) && String(op.type ?? "").includes("capture"),
    );

    return match ? { id: String(match.id) } : null;
  }

  async function balance(subscriptionId: string): Promise<LedgerBalance | null> {
    try {
      const payload = await withRetry(() =>
        request("GET", "/ledger_account_balances", {
          "subscription_id[is]": subscriptionId,
          limit: 1,
        }),
      );
      const entry = payload.list?.[0]?.ledger_account_balance;
      if (!entry) return null;
      return {
        unitId: entry.unit_id,
        unitName: entry.unit_external_name ?? entry.unit_id,
        usable: decimal(String(entry.provisioned_balance?.usable_balance ?? 0)),
        onHold: decimal(String(entry.provisioned_balance?.hold_amount ?? 0)),
      };
    } catch (err) {
      if (NO_LEDGER_CODES.has((err as ChargebeeError).apiErrorCode ?? "")) return null;
      throw err;
    }
  }

  /**
   * Total credits issued to a subscription, summed across grant blocks.
   *
   * Summed rather than read from one block because a subscription accumulates
   * one per term plus any rollover, and the budget must reflect everything
   * still spendable.
   *
   * We do NOT call /ledger_operations/allocate to create these: the item price's
   * Credit Grant configuration issues them automatically on subscription
   * creation. allocate is for ad-hoc grants, requires a mandatory expires_at,
   * and has no documented client-supplied id.
   */
  async function grantedCredits(subscriptionId: string, unitId?: string) {
    const payload = await withRetry(() =>
      request("GET", "/grant_blocks", { "subscription_id[is]": subscriptionId, limit: 100 }),
    );

    const blocks: Array<Record<string, any>> = (payload.list ?? [])
      .map((entry: Record<string, any>) => entry.grant_block)
      .filter((block: Record<string, any>) => !unitId || block.unit_id === unitId);

    let total = "0";
    for (const block of blocks) {
      total = decimal(Number(total) + Number(block.granted_amount ?? 0));
    }

    return { credits: total, blocks: blocks.length };
  }

  /**
   * A hosted checkout page bound to OUR customer.
   *
   * This is why the attribute drop-in cannot be used. The snippet form
   * (`data-cb-type="checkout" data-cb-item-0="..."`) sends no customer, so
   * Chargebee creates a NEW one for every checkout. The subscription would then
   * belong to a customer our webhook cannot map back to a tenant — the money
   * arrives and the credits go nowhere.
   *
   * Creating the page server-side also keeps the item price out of markup the
   * browser can edit: linking to
   * `/hosted_pages/checkout?subscription_items[item_price_id][0]=…` puts the
   * plan in a query string anyone can rewrite.
   */
  async function checkoutPage({
    customerId,
    itemPriceId,
    quantity = 1,
  }: {
    customerId: string;
    itemPriceId: string;
    quantity?: number;
  }) {
    const payload = await withRetry(() =>
      request("POST", "/hosted_pages/checkout_new_for_items", {
        "customer[id]": customerId,
        "subscription_items[item_price_id][0]": itemPriceId,
        "subscription_items[quantity][0]": quantity,
        // Deliberately NO redirect_url: setting one makes Chargebee navigate
        // away instead of calling openCheckout's success callback in place.
      }),
    );
    return payload.hosted_page as Record<string, unknown>;
  }

  /** Chargebee's self-serve portal, scoped to one customer. */
  async function portalSession({
    customerId,
    redirectUrl,
  }: {
    customerId: string;
    redirectUrl: string;
  }) {
    const payload = await withRetry(() =>
      request("POST", "/portal_sessions", {
        "customer[id]": customerId,
        redirect_url: redirectUrl,
      }),
    );
    return payload.portal_session as Record<string, unknown>;
  }

  /**
   * Active subscriptions for a customer, newest first.
   *
   * The pull half of subscription sync. The webhook is the push half, and it is
   * the one that cannot be relied on alone: Chargebee cannot reach a developer
   * machine at all, and even in production a delivery can be delayed, dropped,
   * or arrive while we are redeploying. A customer who has paid must not be
   * left looking at "No subscription" because a notification went missing.
   */
  async function activeSubscriptions(customerId: string) {
    const payload = await withRetry(() =>
      request("GET", "/subscriptions", {
        "customer_id[is]": customerId,
        "status[in]": JSON.stringify(["active", "in_trial", "non_renewing"]),
        limit: 10,
      }),
    );

    return (payload.list ?? [])
      .map((entry: Record<string, any>) => entry.subscription)
      .filter(Boolean)
      .sort((a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0));
  }

  /**
   * Add credits to a subscription's ledger — the top-up primitive.
   *
   * Unlike /capture, allocate accepts NO client-supplied id: Chargebee generates
   * the operation id itself. So a retry after a lost response would allocate a
   * SECOND time and hand out free credits. The only lever available is the
   * `chargebee-idempotency-key` header, whose replay window is 30 minutes —
   * adequate for a top-up retried within seconds, and the reason the caller
   * must also key its ledger entry on the returned operation id.
   *
   * `expires_at` is mandatory, which is what makes credits reset rather than
   * accumulate for ever.
   */
  async function allocate({
    subscriptionId,
    unitId,
    amount,
    expiresAt,
    idempotencyKey,
  }: {
    subscriptionId: string;
    unitId: string;
    amount: string;
    expiresAt: number;
    idempotencyKey: string;
  }) {
    const payload = await withRetry(() =>
      request(
        "POST",
        "/ledger_operations/allocate",
        {
          subscription_id: subscriptionId,
          unit_id: unitId,
          amount: decimal(amount),
          expires_at: expiresAt,
        },
        idempotencyKey,
      ),
    );

    const op = payload.ledger_operations?.[0] ?? payload.ledger_operation ?? {};
    return {
      operationId: String(op.id ?? idempotencyKey),
      balanceAfter: usableBalanceOf(payload),
    };
  }

  /** Hosted page for a ONE-TIME charge — the credit pack a customer tops up with. */
  async function checkoutOneTime({
    customerId,
    itemPriceId,
  }: {
    customerId: string;
    itemPriceId: string;
  }) {
    const payload = await withRetry(() =>
      request("POST", "/hosted_pages/checkout_one_time_for_items", {
        "customer[id]": customerId,
        "item_prices[item_price_id][0]": itemPriceId,
        "item_prices[quantity][0]": 1,
      }),
    );
    return payload.hosted_page as Record<string, unknown>;
  }

  /**
   * Paid invoices for a customer containing a given item price.
   *
   * This is the proof of payment a top-up needs. The invoice id becomes the
   * ledger entry's source_ref, so one paid invoice can grant credits exactly
   * once no matter how often the sync runs.
   */
  async function paidInvoicesFor(customerId: string, itemPriceId: string) {
    const payload = await withRetry(() =>
      request("GET", "/invoices", {
        "customer_id[is]": customerId,
        "status[is]": "paid",
        limit: 20,
      }),
    );

    return (payload.list ?? [])
      .map((entry: Record<string, any>) => entry.invoice)
      .filter(Boolean)
      .filter((inv: any) =>
        (inv.line_items ?? []).some((li: any) => li.entity_id === itemPriceId),
      );
  }

  async function subscription(id: string) {
    try {
      const payload = await withRetry(() => request("GET", `/subscriptions/${encodeURIComponent(id)}`));
      return payload.subscription ?? null;
    } catch (err) {
      if (NO_LEDGER_CODES.has((err as ChargebeeError).apiErrorCode ?? "")) return null;
      throw err;
    }
  }

  return {
    createCustomer,
    capture,
    captureIdempotent,
    findOperation,
    balance,
    grantedCredits,
    subscription,
    activeSubscriptions,
    allocate,
    checkoutOneTime,
    paidInvoicesFor,
    checkoutPage,
    portalSession,
  };
}

/**
 * Turn a thrown Chargebee error into an outcome the sync loop can act on.
 *
 * The distinction that matters: `retryable` leaves the batch pending so the same
 * id replays, `terminal` stops and asks for a human, `replayed` means our id was
 * already used and the money has therefore already moved.
 */
export function classify(err: ChargebeeError, id: string): CaptureResult {
  if (DUPLICATE_CODES.has(err.apiErrorCode ?? "")) {
    return { kind: CAPTURE_REPLAYED, operationId: id, error: err };
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
  return { kind: CAPTURE_TERMINAL, error: err };
}

function operationIdOf(payload: Record<string, any>): string | null {
  return payload.ledger_operation?.id ?? payload.ledger_operations?.[0]?.id ?? null;
}

function usableBalanceOf(payload: Record<string, any>): string | null {
  const usable = payload.ledger_account_balance?.provisioned_balance?.usable_balance;
  return usable == null ? null : decimal(String(usable));
}
