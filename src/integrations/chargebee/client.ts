/**
 * Chargebee prepaid credit ledger.
 *
 * The pinned SDK (2.x) has no binding for these endpoints, so they are called
 * over plain REST — the same approach the existing chargebee-checkout prototype
 * takes for balances.
 *
 * Two things here are the difference between billing correctly and billing twice:
 *
 * 1. Every capture carries a client-supplied `id` — the `chargebee_sync` row's
 *    own id, committed BEFORE the call. Chargebee
 *    documents that for external ledger operations "the same value should be
 *    reused across retries". Without it, a crash between Chargebee accepting the
 *    charge and us recording it charges the customer again on the next tick.
 *    The prototype route omits this, which is a live bug.
 *
 * 2. Errors are classified, not just thrown. A timeout is NOT a failure: it says
 *    nothing about whether the charge landed, so the id stays pending and the
 *    next tick asks about it. Treating it as failure loses the usage; treating
 *    it as success loses the money.
 *
 * Deliberately NOT used: the `chargebee-idempotency-key` header. Its replay
 * window is 30 minutes, far shorter than a batch stuck behind an outage.
 */

import { getConfig } from "../../config/config";
import { add, decimal } from "../../models/decimal";
import {
  CAPTURE_OK,
  CAPTURE_RATE_LIMITED,
  CAPTURE_REPLAYED,
  CAPTURE_RETRYABLE,
  NO_LEDGER_CODES,
  classify,
  isRateLimited,
  isResourceNotFound,
  isUnreachable,
  type CaptureResult,
  type ChargebeeError,
} from "./errors";
import { grantBlockInvoiceRefs, isLiveGrantBlock } from "./ledger";
import type {
  CaptureArgs,
  ChargebeeClient,
  ChargedInvoice,
  ChargebeeOptions,
  GrantBlock,
  InvoiceDownload,
  InvoiceRef,
  ItemPrice,
  LedgerBalance,
  PaymentSource,
  Transaction,
  UnpaidInvoice,
} from "./types";

export function createChargebee(options: ChargebeeOptions = {}): ChargebeeClient {
  const site = options.site ?? getConfig().chargebee.site;
  const apiKey = options.apiKey ?? getConfig().chargebee.apiKey;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = options.logger ?? console;

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

    // ONE timer for the whole exchange, body included. It used to be cleared
    // as soon as the headers arrived, so a body that stalled after them held
    // the caller for as long as the socket stayed open — past the PROCESSING
    // lease that models/sync-status.ts sizes from this timeout.
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
      clearTimeout(timer);
      // A network failure or abort says nothing about whether the request was
      // applied, so it is retryable rather than failed.
      throw Object.assign(new Error(`Chargebee ${path} unreachable: ${(cause as Error).message}`), {
        retryable: true,
        cause,
      }) as ChargebeeError;
    }

    let payload: Record<string, any>;
    try {
      payload = (await response.json()) as Record<string, any>;
    } catch (cause) {
      // A refusal is still a refusal without its body: the status says enough.
      // An ACCEPTED request whose body never arrived (the timer fired, or it
      // was cut off) is a different thing — reading it as `{}` would turn a
      // lost answer into "no such subscription", "no ledger", or a capture
      // with no balance — so it is an unknown, exactly like a timeout.
      if (response.ok) {
        throw Object.assign(new Error(`Chargebee ${path} response unreadable: ${(cause as Error).message}`), {
          status: response.status,
          retryable: true,
          cause,
        }) as ChargebeeError;
      }
      payload = {};
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw Object.assign(new Error(payload.message || `Chargebee ${path} failed (${response.status})`), {
        status: response.status,
        apiErrorCode: payload.api_error_code,
        errorCode: payload.error_code,
        // 5xx and 429 may succeed on retry; 4xx will not.
        retryable: response.status >= 500 || response.status === 429,
      }) as ChargebeeError;
    }

    return payload;
  }

  /** Retry only what a retry could fix, with a bounded backoff. */
  async function withRetry<T>(
    run: () => Promise<T>,
    shouldRetry: (err: ChargebeeError) => boolean = (err) => err.retryable === true,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await run();
      } catch (err) {
        lastError = err;
        if (!shouldRetry(err as ChargebeeError) || attempt === maxAttempts) throw err;
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
   * `ledger_operation_timestamp` is always now, never the usage's own time: the
   * API rejects anything older than ten minutes, and a capture is a balance
   * drawdown rather than a dated invoice line. The range it covers travels in
   * metadata so the operation stays auditable.
   */
  async function capture(args: CaptureArgs): Promise<CaptureResult> {
    const amount = decimal(args.amount);
    const now = args.now ?? Date.now();

    try {
      // Re-sent in place only on a 429, which Chargebee refuses before applying.
      // A timeout, dropped connection or 5xx may have landed, so it returns
      // retryable instead: the batch stays pending and the next tick retrieves
      // the id before sending anything again.
      const payload = await withRetry(
        () =>
          request("POST", "/ledger_operations/capture", {
            id: args.id,
            subscription_id: args.subscriptionId,
            unit_id: args.unitId,
            amount,
            ledger_operation_timestamp: Math.floor(now / 1000),
            ...(args.metadata ? { "metadata[json]": JSON.stringify(args.metadata) } : {}),
          }),
        (err) => err.status === 429,
      );

      return {
        kind: CAPTURE_OK,
        operationId: operationIdOf(payload) ?? args.id,
        balanceAfter: usableBalanceOf(payload),
      };
    } catch (err) {
      const result = classify(err as ChargebeeError, args.id);
      return result.kind === CAPTURE_REPLAYED ? confirmReplay(args, result.error!) : result;
    }
  }

  /**
   * Chargebee refused our id as a duplicate: believe it only once we have seen
   * the capture.
   *
   * The duplicate answer means SOMETHING holds this id. The only thing that
   * should is our own capture of this row, sent by another caller a moment
   * earlier — but settling a window as paid is not something to do on an error
   * code alone, so it is retrieved first, exactly as a recovery would. Found:
   * replayed, and the money moved once. Not found, or the lookup fails: an
   * unknown, which the next tick resolves by the same lookup — never a terminal
   * refusal, which is what held charged windows INVALID before the code was
   * pinned.
   */
  async function confirmReplay(args: CaptureArgs, error: ChargebeeError): Promise<CaptureResult> {
    try {
      const existing = await findOperation(args.id, args.subscriptionId);
      if (existing) {
        return {
          kind: CAPTURE_REPLAYED,
          operationId: existing.id,
          balanceAfter: await usableNow(args.subscriptionId, args.unitId),
          error,
        };
      }
    } catch (lookupError) {
      return { kind: CAPTURE_RETRYABLE, error: lookupError as ChargebeeError };
    }
    return { kind: CAPTURE_RETRYABLE, error };
  }

  /**
   * The usable balance right now, for a capture that was settled by lookup
   * rather than by its own response.
   *
   * A replay has no response body to read the post-capture balance from, and
   * returning none skipped the drain-to-zero check: when the capture that
   * emptied the balance was the one whose answer got lost, the account stayed
   * `active` until a LATER capture was refused. One GET, on a path that only a
   * lost response or a concurrent caller reaches. A failed read is not
   * evidence of anything, so it answers null and the next capture decides.
   *
   * The CAPTURE'S unit, never "the first balance": a subscription holding two
   * units (a top-up whose item carries its own grant) lists them in no order
   * we control, and the other unit's balance says nothing about this one.
   */
  async function usableNow(subscriptionId: string, unitId: string): Promise<string | null> {
    try {
      const entry = unitBalance(await readBalances(subscriptionId, unitId, false), unitId);
      const usable = entry?.provisioned_balance?.usable_balance;
      return usable == null ? null : decimal(String(usable));
    } catch {
      return null;
    }
  }

  /**
   * Capture, but only once Chargebee has said our id does not exist yet.
   *
   * After a timeout the capture's outcome is unknown, and asking is the only
   * way to learn it: if an operation with our id exists, the money has already
   * moved and we must not send it again.
   *
   * A lookup that itself fails is ALSO an unknown, so it returns retryable
   * rather than capturing blind. That cannot wedge the pipeline: the batch stays
   * pending and the next tick asks again.
   *
   * Check-then-act races on its own, and the id alone does not stop it: a
   * second caller that recovers a row while the first caller's POST is still
   * on the wire gets a 404 here and sends the same id again. What keeps that
   * from happening is the row, not this function — the usage sync claims it
   * with a compare-and-set before sending, and a PROCESSING row is left to its
   * sender for a lease longer than any send (models/sync-status.ts). If both
   * are ever beaten, a paused worker waking up late say, Chargebee refuses the
   * second POST as a duplicate and `capture()` settles it as the replay it is.
   */
  async function captureIdempotent(args: CaptureArgs): Promise<CaptureResult> {
    try {
      const existing = await findOperation(args.id, args.subscriptionId);
      if (existing) {
        return {
          kind: CAPTURE_REPLAYED,
          operationId: existing.id,
          balanceAfter: await usableNow(args.subscriptionId, args.unitId),
        };
      }
    } catch (err) {
      const e = err as ChargebeeError;
      // Throttled BEFORE the others, which it would otherwise satisfy: the
      // lookup was refused, so nothing was learnt and nothing was sent. That is
      // a wait, not an unknown.
      if (isRateLimited(e)) return { kind: CAPTURE_RATE_LIMITED, error: e };
      // The rest are "we could not find out": a flaky lookup, a rejected
      // credential, or a site Chargebee has switched off. Either way the
      // capture stays unresolved and the next tick asks again — never a throw,
      // which would leave no record of why this tenant stopped.
      if (e.retryable || isUnreachable(e)) return { kind: CAPTURE_RETRYABLE, error: e };
      throw err;
    }

    return capture(args);
  }

  /**
   * Find the capture we sent under `id`, by retrieving it directly.
   *
   * MEASURED against the test site: `GET /ledger_operations/{id}` returns the
   * operation under the id we supplied on capture (our batch UUID), and an
   * unknown id is a 404 with `api_error_code: resource_not_found`. That 404 is
   * the only answer that means "never captured".
   *
   * This replaced a scan of `GET /ledger_operations?limit=100`, which ignores
   * `id[is]` and so had to be filtered client-side — and once a subscription had
   * more than 100 operations (under two hours at one capture a minute), a
   * capture that had landed could fall off the page and be sent again.
   *
   * The type must still be a capture: a grant is not a charge, and matching one
   * would suppress a real capture forever.
   */
  async function findOperation(id: string, subscriptionId: string) {
    let payload: Record<string, any>;
    try {
      payload = await withRetry(() => request("GET", `/ledger_operations/${encodeURIComponent(id)}`));
    } catch (err) {
      if (isResourceNotFound(err as ChargebeeError)) return null;
      throw err;
    }

    const op = payload.ledger_operation as Record<string, any> | undefined;
    const matches =
      op != null &&
      String(op.id) === String(id) &&
      String(op.type ?? "").includes("capture") &&
      (op.subscription_id == null || String(op.subscription_id) === String(subscriptionId));

    return matches ? { id: String(op.id) } : null;
  }

  /**
   * The balance of ONE credit unit on a subscription.
   *
   * With `unitId` — the account's `ledger_unit_id`, which every caller that
   * has one passes — that unit's balance and no other; null when the
   * subscription has no ledger in it. It used to read "the first balance"
   * (`limit=1`, no unit filter), and a subscription can hold two units: MEASURED
   * on the test site, a top-up whose charge item carries its own Credit Grant
   * into unit `token` put a second ledger account beside the plan's
   * `token-test`, listed FIRST. activate() then read the top-up's 1,000 as the
   * account's balance and opened an exhausted account, and a relink could move
   * `ledger_unit_id` onto the wrong unit (C57b).
   *
   * Without `unitId` — only a FIRST link, before any unit is known — the
   * subscription's OLDEST ledger account: the plan's grant creates it when the
   * subscription is created, and anything added later (a top-up grant in
   * another unit) is newer. `unitCount` says how many there were, so the
   * caller can say out loud that it chose.
   *
   * A `unitId` the subscription does NOT hold answers null like a subscription
   * with no ledger at all — but it is not the same fact, so when the
   * subscription does have ledger accounts it is said out loud
   * (`billing.balance.unit_missing`, naming the units it has): captures
   * against that unit will be refused, and an account's stored unit is never
   * silently re-pointed (see syncSubscription).
   */
  async function balance(subscriptionId: string, unitId?: string | null): Promise<LedgerBalance | null> {
    try {
      const entries = await withRetry(() => readBalances(subscriptionId, unitId ?? null, true));
      const entry = unitId ? unitBalance(entries, unitId) : oldestUnit(entries);
      if (!entry) {
        if (unitId) await reportMissingUnit(subscriptionId, unitId);
        return null;
      }
      return {
        unitId: String(entry.unit_id),
        unitName: entry.unit_external_name ?? entry.unit_id,
        usable: decimal(String(entry.provisioned_balance?.usable_balance ?? 0)),
        onHold: decimal(String(entry.provisioned_balance?.hold_amount ?? 0)),
        unitCount: entries.length,
      };
    } catch (err) {
      if (NO_LEDGER_CODES.has((err as ChargebeeError).apiErrorCode ?? "")) return null;
      throw err;
    }
  }

  /**
   * Every ledger account on the subscription — or only `unitId`'s, asked for
   * with `unit_id[is]` and checked again here, since the list endpoints do not
   * honour every filter (see ledgerOperations).
   */
  async function readBalances(subscriptionId: string, unitId: string | null, all: boolean) {
    const payload = await request("GET", "/ledger_account_balances", {
      "subscription_id[is]": subscriptionId,
      ...(unitId ? { "unit_id[is]": unitId } : {}),
      limit: all ? 100 : 10,
    });
    return (payload.list ?? [])
      .map((e: Record<string, any>) => e.ledger_account_balance)
      .filter(Boolean)
      .filter((e: Record<string, any>) => String(e.subscription_id ?? subscriptionId) === String(subscriptionId)) as Array<
      Record<string, any>
    >;
  }

  /** Every unit the subscription holds a ledger account in; empty when it has none. */
  async function ledgerUnits(subscriptionId: string): Promise<string[]> {
    try {
      const entries = await withRetry(() => readBalances(subscriptionId, null, true));
      return [...new Set(entries.map((e) => String(e.unit_id)))];
    } catch (err) {
      if (NO_LEDGER_CODES.has((err as ChargebeeError).apiErrorCode ?? "")) return [];
      throw err;
    }
  }

  /**
   * The unit asked for is not on the subscription. Said only when the
   * subscription HAS ledger accounts — none at all is the ordinary
   * no-ledger case. A diagnostic: a failed read here changes nothing.
   */
  async function reportMissingUnit(subscriptionId: string, unitId: string) {
    let units: string[];
    try {
      units = await ledgerUnits(subscriptionId);
    } catch {
      return;
    }
    if (units.length === 0) return;
    log.error?.(
      { metric: "billing.balance.unit_missing", subscriptionId, unitId, units },
      "The subscription holds no ledger account in this credit unit; its balance reads as unknown and captures against it will be refused. Check the account's ledger_unit_id",
    );
  }

  function unitBalance(entries: Array<Record<string, any>>, unitId: string) {
    return entries.find((e) => String(e.unit_id) === String(unitId)) ?? null;
  }

  function oldestUnit(entries: Array<Record<string, any>>) {
    if (entries.length <= 1) return entries[0] ?? null;
    return [...entries].sort((a, b) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0))[0]!;
  }

  /**
   * Credits currently issued to a subscription, summed across grant blocks.
   *
   * Summed rather than read from one block because a subscription accumulates
   * one per term plus any rollover and any top-up, and the LiteLLM cap must
   * reflect everything still spendable.
   *
   * EXPIRED BLOCKS ARE EXCLUDED, and that exclusion is load-bearing. This sum
   * is what the gateway cap is built from; the local ledger used to do the same
   * arithmetic as `allocated - expired`, with an explicit `expiry` entry written
   * at every renewal. With the ledger gone, Chargebee's own view of which blocks
   * are still live is the only thing keeping last term's credits out of this
   * term's cap. A block that has been fully SPENT still counts: the gateway cap
   * is `baseline + everything granted`, and the team's own cumulative spend is
   * what consumes it.
   *
   * MEASURED: `grant_block.status` is `available` on a live block. The other
   * values are not documented; anything that is not plainly still live is
   * treated as gone, and `expires_at` in the past is honoured whatever the
   * status says. Pin the real values against the site.
   *
   * We do NOT call /ledger_operations/allocate to create these: the item price's
   * Credit Grant configuration issues them automatically on subscription
   * creation. allocate is for ad-hoc grants, requires a mandatory expires_at,
   * and has no documented client-supplied id.
   */
  async function grantedCredits(subscriptionId: string, unitId?: string, now: number = Date.now()) {
    const payload = await withRetry(() =>
      request("GET", "/grant_blocks", { "subscription_id[is]": subscriptionId, limit: 100 }),
    );

    const blocks: Array<Record<string, any>> = (payload.list ?? [])
      .map((entry: Record<string, any>) => entry.grant_block)
      .filter((block: Record<string, any>) => !unitId || block.unit_id === unitId)
      .filter((block: Record<string, any>) => isLiveGrantBlock(block, now));

    // Summed exactly. It used to add floats (Number(total) + Number(amount)),
    // which drifts on fractional grants and prints exponents on tiny ones.
    const total = add("0", ...blocks.map((block) => String(block.granted_amount ?? 0)));

    return { credits: total, blocks: blocks.length };
  }

  /**
   * Every grant block on a subscription, oldest first, with the invoice that
   * created each one — read by the top-up guard.
   *
   * MEASURED on the test site (2026-09-24): a block Chargebee issues from an
   * item price's own Credit Grant carries `billing_metadata` naming the
   * invoice and its line item (`{"line_items":[{"id":"li_…","invoice_number":
   * "85",…}],"item_price_id":"test-top-up-INR"}`), so a pack whose item grants
   * credits by itself can be recognised as ALREADY GRANTED. A block made by
   * `/ledger_operations/allocate` carries `{"line_items":null,
   * "item_price_id":null}` and a `metadata` of only `{"done_by":"<api key
   * name>"}` — the metadata we send on allocate is dropped, which is why the
   * guard keeps its own record (topup-grant.repository.ts).
   *
   * Paginated to the end (`next_offset`), up to a bound; `complete` is false
   * only if the bound was hit, and a caller must then not treat "not found"
   * as "never happened".
   */
  async function grantBlocks(subscriptionId: string): Promise<{ blocks: GrantBlock[]; complete: boolean }> {
    const blocks: GrantBlock[] = [];
    let offset: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const payload = await withRetry(() =>
        request("GET", "/grant_blocks", { "subscription_id[is]": subscriptionId, limit: 100, offset }),
      );
      for (const entry of payload.list ?? []) {
        const block = entry?.grant_block as Record<string, any> | undefined;
        if (!block || String(block.subscription_id ?? subscriptionId) !== String(subscriptionId)) continue;
        const refs = grantBlockInvoiceRefs(block);
        blocks.push({
          id: String(block.id),
          subscriptionId: String(block.subscription_id ?? subscriptionId),
          unitId: String(block.unit_id),
          grantedAmount: decimal(String(block.granted_amount ?? 0)),
          status: String(block.status ?? "available"),
          source: block.grant_source == null ? null : String(block.grant_source),
          createdAtMs: typeof block.created_at === "number" ? block.created_at * 1000 : null,
          invoices: refs.invoices,
          itemPriceId: refs.itemPriceId,
          doneBy: refs.doneBy,
        });
      }
      offset = payload.next_offset == null ? undefined : String(payload.next_offset);
      if (!offset) {
        return { blocks: blocks.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0)), complete: true };
      }
    }
    return { blocks: blocks.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0)), complete: false };
  }

  /**
   * One ledger operation, retrieved by id — null only on a definite 404.
   *
   * Read by the top-up guard for an allocation recorded before its time was
   * (a row applied by operation id with no `operation_at`): the operation's
   * `created_at` is its grant block's, which is what lets the guard tell
   * that row's block from another's (see account.service.ts findAllocation).
   */
  async function ledgerOperation(id: string) {
    let payload: Record<string, any>;
    try {
      payload = await withRetry(() => request("GET", `/ledger_operations/${encodeURIComponent(id)}`));
    } catch (err) {
      if (isResourceNotFound(err as ChargebeeError)) return null;
      throw err;
    }
    const op = payload.ledger_operation as Record<string, any> | undefined;
    if (!op || String(op.id) !== String(id)) return null;
    return {
      id: String(op.id),
      type: String(op.type ?? ""),
      subscriptionId: op.subscription_id == null ? null : String(op.subscription_id),
      unitId: op.unit_id == null ? null : String(op.unit_id),
      amount: op.amount == null ? null : decimal(String(op.amount)),
      createdAtMs: operationTimeMs(op),
    };
  }

  /**
   * Ledger operations on a subscription, newest first — one page.
   *
   * NOT a top-up guard any more. It used to be scanned for an allocation
   * carrying `metadata.invoice_id`, but Chargebee never returns operation
   * metadata, and one page of a ledger that gains a capture a minute holds
   * under two hours of history. The guard is a local record now
   * (topup-grant.repository.ts), plus grantBlocks() for packs Chargebee grants
   * itself.
   *
   * Filtered by subscription client-side as well as in the query: the list
   * endpoint's filters are not uniformly honoured (it ignores `id[is]`, which
   * is why `findOperation` retrieves by id instead), and a page of another
   * subscription's operations must never be rendered as this customer's.
   */
  async function ledgerOperations(subscriptionId: string, limit = 50) {
    const payload = await withRetry(() =>
      request("GET", "/ledger_operations", { "subscription_id[is]": subscriptionId, limit }),
    );

    return (payload.list ?? [])
      .map((entry: Record<string, any>) => entry.ledger_operation)
      .filter(Boolean)
      .filter((op: Record<string, any>) => String(op.subscription_id ?? subscriptionId) === String(subscriptionId))
      .sort((a: any, b: any) => Number(b.sequence_number ?? 0) - Number(a.sequence_number ?? 0)) as Array<
      Record<string, any>
    >;
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
    redirectUrl,
  }: {
    customerId: string;
    itemPriceId: string;
    quantity?: number;
    redirectUrl?: string;
  }) {
    const payload = await withRetry(() =>
      request("POST", "/hosted_pages/checkout_new_for_items", {
        "customer[id]": customerId,
        "subscription_items[item_price_id][0]": itemPriceId,
        "subscription_items[quantity][0]": quantity,
        // Only for a page the browser is SENT to. With Chargebee.js's
        // openCheckout it must be left out: a redirect_url makes Chargebee
        // navigate away instead of calling the success callback in place.
        ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
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
   * Chargebee's Manage Payment Sources page: the customer adds, replaces or
   * removes a card — and nothing else. Unlike the portal it offers no
   * cancellation, which is why it can be shown while the portal stays shut.
   *
   * MEASURED: `redirect_url` must be on port 80, 443, 8080 or 8443 — Chargebee
   * refuses `http://localhost:4200` with UNSUPPORTED_PORT.
   */
  async function managePaymentSourcesPage({
    customerId,
    redirectUrl,
  }: {
    customerId: string;
    redirectUrl: string;
  }) {
    const payload = await withRetry(() =>
      request("POST", "/hosted_pages/manage_payment_sources", {
        "customer[id]": customerId,
        redirect_url: redirectUrl,
      }),
    );
    return payload.hosted_page as Record<string, unknown>;
  }

  /**
   * Subscribe an existing customer to a plan with no checkout and no card —
   * only ever the free plan (checkout.provisionFreePlan checks its price is
   * zero first). Carries `chargebee-idempotency-key`, so the sign-up hook and a
   * billing page opened in the same moment create ONE subscription: a repeat
   * of the same request inside the key's window is answered with the first.
   */
  async function subscribeCustomer({
    customerId,
    itemPriceId,
    idempotencyKey,
  }: {
    customerId: string;
    itemPriceId: string;
    idempotencyKey: string;
  }) {
    const payload = await withRetry(() =>
      request(
        "POST",
        `/customers/${encodeURIComponent(customerId)}/subscription_for_items`,
        {
          "subscription_items[item_price_id][0]": itemPriceId,
          "subscription_items[quantity][0]": 1,
        },
        idempotencyKey,
      ),
    );
    return payload.subscription as Record<string, unknown>;
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
   * `chargebee-idempotency-key` header, whose replay window is 30 minutes, and
   * a replay must be the SAME request — MEASURED: a second call under the same
   * key with a different `expires_at` is refused ("The idempotency key provided
   * has already been used for a different request"). So the caller stores
   * every parameter before the first send and re-sends exactly those
   * (account.service.ts applyPaidTopUps, topup_grant).
   *
   * The metadata is sent for the audit trail of anyone reading the request
   * log; Chargebee does not return it (see grantBlockInvoiceRefs()).
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
    metadata,
  }: {
    subscriptionId: string;
    unitId: string;
    amount: string;
    expiresAt: number;
    idempotencyKey: string;
    /** Accepted and never returned by Chargebee — informational only. */
    metadata?: Record<string, unknown>;
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
          ...(metadata ? { "metadata[json]": JSON.stringify(metadata) } : {}),
        },
        idempotencyKey,
      ),
    );

    const op = payload.ledger_operations?.[0] ?? payload.ledger_operation ?? {};
    return {
      operationId: String(op.id ?? idempotencyKey),
      balanceAfter: usableBalanceOf(payload),
      // When Chargebee made the grant — its grant block's `created_at`. A
      // replay under the same key answers with the ORIGINAL operation, so this
      // is the first send's time even when the answer came from a retry.
      createdAtMs: operationTimeMs(op),
    };
  }

  /**
   * Charge `quantity` units of a charge item to a subscription, now, against
   * the card on file — the top-up. The API form of the admin UI's Subscription
   * > Billing Actions > Add Charge.
   *
   * Not a hosted checkout, because the pack's charge carries its own Credit
   * Grant, and MEASURED on the test site (2026-09-28) Chargebee refuses a
   * grant-carrying charge on every hosted or subscription-update route
   * mid-term: `checkout_one_time_for_items` ("Charges with grants are not
   * supported for customer one off charges"), `checkout_existing_for_items`
   * and `update_for_items` (`mid_term_grant_subscription_change_not_allowed`).
   * Invoicing it onto the subscription is accepted, the invoice is collected at
   * once, and Chargebee issues the grant block itself about a second after
   * `paid_at`.
   *
   * NEVER retried. The call moves money, and a timeout says nothing about
   * whether the card was charged — a second send could charge it twice.
   */
  async function chargeItem({
    subscriptionId,
    itemPriceId,
    quantity = 1,
  }: {
    subscriptionId: string;
    itemPriceId: string;
    quantity?: number;
  }): Promise<ChargedInvoice> {
    const payload = await request("POST", "/invoices/create_for_charge_items_and_charges", {
      subscription_id: subscriptionId,
      "item_prices[item_price_id][0]": itemPriceId,
      "item_prices[quantity][0]": quantity,
      // The customer has just confirmed "charge my card now", so collect now
      // whatever the account says. Without it the invoice takes the
      // subscription's (else the customer's) auto_collection. MEASURED
      // 2026-09-28: with that off, the charge came back `payment_due`, with
      // its Credit Grant already issued — credits for nothing. With `on`, paid.
      auto_collection: "on",
    });
    return toChargedInvoice(payload.invoice);
  }

  /**
   * Charge the card on file for an invoice left unpaid — a top-up whose card
   * declined, now in Chargebee's dunning. Adding a card does not do this by
   * itself (MEASURED 2026-09-28: the invoice stayed `payment_due` with the new
   * card on file); Chargebee's own retry would, a day later.
   *
   * NEVER retried, like chargeItem: it moves money. MEASURED: a card that
   * declines again answers HTTP 400 `payment_processing_failed`.
   */
  async function collectInvoice(invoiceId: string): Promise<ChargedInvoice> {
    const payload = await request("POST", `/invoices/${encodeURIComponent(invoiceId)}/collect_payment`, {});
    return toChargedInvoice(payload.invoice);
  }

  /**
   * The customer's top-up invoices Chargebee has not collected, oldest first.
   * `payment_due` while it retries the card; `not_paid` once its retries ran
   * out. Either is still owed.
   */
  async function unpaidInvoicesFor(customerId: string, itemPriceId: string): Promise<UnpaidInvoice[]> {
    const payload = await withRetry(() =>
      request("GET", "/invoices", {
        "customer_id[is]": customerId,
        "status[in]": '["payment_due","not_paid"]',
        "sort_by[asc]": "date",
        limit: 20,
      }),
    );
    return (payload.list ?? [])
      .map((entry: Record<string, any>) => entry.invoice)
      .filter((invoice: Record<string, any> | undefined) => hasLineFor(invoice, itemPriceId))
      .map((invoice: Record<string, any>) => ({
        id: String(invoice.id),
        status: String(invoice.status),
        amountDueMinor: typeof invoice.amount_due === "number" ? invoice.amount_due : 0,
        currencyCode: invoice.currency_code == null ? null : String(invoice.currency_code),
        nextRetryAt: fromUnixSeconds(invoice.next_retry_at),
        date: fromUnixSeconds(invoice.date),
      }));
  }

  /**
   * Credits Chargebee has granted for top-ups that are NOT paid, on this
   * subscription's unit — for the caller to hold back from the balance the
   * page shows and from the gateway cap.
   *
   * Chargebee issues a top-up's grant block with the INVOICE, not with the
   * payment (MEASURED 2026-09-28): a declined card left invoice 126
   * `payment_due` with its 50 credits already `available`, and voiding an
   * invoice left its block too. So a top-up's credits count only once its
   * invoice is paid. The live blocks of every top-up invoice still owed
   * (`payment_due`), abandoned by dunning (`not_paid`), voided or `pending`
   * are summed here, over the same page of blocks `grantedCredits` counts.
   * One call when nothing is unsettled — the usual case.
   */
  async function unpaidTopUpCredits({
    customerId,
    subscriptionId,
    unitId,
    itemPriceId,
    now = Date.now(),
  }: {
    customerId: string;
    subscriptionId: string;
    unitId?: string;
    itemPriceId: string;
    now?: number;
  }): Promise<string> {
    const invoices = await withRetry(() =>
      request("GET", "/invoices", {
        "customer_id[is]": customerId,
        "status[in]": '["payment_due","not_paid","voided","pending"]',
        limit: 100,
      }),
    );
    const unsettled = new Set<string>(
      (invoices.list ?? [])
        .map((entry: Record<string, any>) => entry.invoice)
        .filter((invoice: Record<string, any> | undefined) => hasLineFor(invoice, itemPriceId))
        .map((invoice: Record<string, any>) => String(invoice.id)),
    );
    if (unsettled.size === 0) return "0";

    const payload = await withRetry(() =>
      request("GET", "/grant_blocks", { "subscription_id[is]": subscriptionId, limit: 100 }),
    );
    const held: Array<Record<string, any>> = (payload.list ?? [])
      .map((entry: Record<string, any>) => entry.grant_block)
      .filter((block: Record<string, any> | undefined) => block != null)
      .filter((block: Record<string, any>) => !unitId || block.unit_id === unitId)
      .filter((block: Record<string, any>) => isLiveGrantBlock(block, now))
      .filter((block: Record<string, any>) => {
        const refs = grantBlockInvoiceRefs(block);
        return (
          refs.itemPriceId === itemPriceId &&
          refs.invoices.some((ref) => ref.invoiceId != null && unsettled.has(ref.invoiceId))
        );
      });
    return add("0", ...held.map((block) => String(block.granted_amount ?? 0)));
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
        // Newest first: a pack paid a moment ago must be on this page, and a
        // customer with 20 renewals behind it would otherwise push it off.
        "sort_by[desc]": "date",
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

  /**
   * The customer's payments, newest first.
   *
   * Transactions rather than invoices, because this answers "did my money
   * move", and only a transaction can say no. An invoice that was never paid
   * looks the same as one whose payment is still in flight; the transaction
   * that failed carries the reason.
   *
   * Sorted by Chargebee rather than by us: `sort_by[desc]=date` is documented,
   * and sorting a truncated page client-side would put the newest payment below
   * the fold exactly when the customer is looking for it.
   *
   * Refunds are included deliberately. A customer who was refunded and does not
   * see it here will conclude the refund never happened.
   */
  async function transactionsFor(customerId: string, limit = 20): Promise<Transaction[]> {
    return (await transactionsPage(customerId, { limit })).transactions;
  }

  /**
   * One page of the customer's payments, newest first, and the cursor for the
   * next. Chargebee pages a list by an opaque `next_offset`, not by number, so
   * the page after this one is reached only through it; null once nothing
   * older is left. The cursor says WHERE in the list, never whose — the
   * customer filter is sent again with every page.
   */
  async function transactionsPage(
    customerId: string,
    { limit = 10, offset }: { limit?: number; offset?: string } = {},
  ): Promise<{ transactions: Transaction[]; nextOffset: string | null }> {
    const payload = await withRetry(() =>
      request("GET", "/transactions", {
        "customer_id[is]": customerId,
        "sort_by[desc]": "date",
        limit,
        offset,
      }),
    );

    const transactions = (payload.list ?? [])
      .map((entry: Record<string, any>) => entry.transaction)
      .filter(Boolean)
      .map((t: Record<string, any>): Transaction => ({
        id: String(t.id),
        type: String(t.type ?? "payment"),
        status: String(t.status ?? "success"),
        amountMinor: Number(t.amount ?? 0),
        currencyCode: t.currency_code ?? null,
        // Epoch SECONDS on the wire. Converted once, here, so that every caller
        // cannot make the same mistake separately.
        atMs: typeof t.date === "number" ? t.date * 1000 : null,
        method: t.payment_method ?? null,
        maskedCardNumber: t.masked_card_number ?? null,
        errorText: t.error_text ?? null,
        invoiceIds: (t.linked_invoices ?? [])
          .map((l: Record<string, any>) => (l.invoice_id == null ? null : String(l.invoice_id)))
          .filter(Boolean),
      }));
    return { transactions, nextOffset: payload.next_offset == null ? null : String(payload.next_offset) };
  }

  /**
   * The card Chargebee will charge next.
   *
   * Rendered so a customer can tell at a glance whether a failed payment is
   * their expired card — which is the single most common cause and the one they
   * can fix themselves, in the portal, without contacting anyone.
   *
   * Only the primary source is returned. A customer with several is rare here
   * (checkout adds one), and showing a list invites the question "which one will
   * you actually charge", which this API does not answer cleanly.
   */
  async function paymentSource(customerId: string): Promise<PaymentSource | null> {
    const payload = await withRetry(() =>
      request("GET", "/payment_sources", { "customer_id[is]": customerId, limit: 1 }),
    );
    const source = payload.list?.[0]?.payment_source;
    if (!source) return null;
    const card = source.card ?? {};
    return {
      id: String(source.id),
      type: String(source.type ?? "card"),
      status: String(source.status ?? "valid"),
      brand: card.brand ?? null,
      last4: card.last4 ?? null,
      expiryMonth: typeof card.expiry_month === "number" ? card.expiry_month : null,
      expiryYear: typeof card.expiry_year === "number" ? card.expiry_year : null,
    };
  }

  /**
   * One invoice, for the single purpose of checking who owns it.
   *
   * MEASURED: an unknown id is HTTP 404 with `api_error_code:
   * resource_not_found`, which is returned as null rather than thrown — the
   * caller turns both "no such invoice" and "not yours" into the same 404, and
   * a throw would make those two paths differ.
   */
  async function invoice(invoiceId: string): Promise<InvoiceRef | null> {
    try {
      const payload = await withRetry(() => request("GET", `/invoices/${encodeURIComponent(invoiceId)}`));
      const inv = payload.invoice;
      if (!inv) return null;
      return {
        id: String(inv.id),
        customerId: inv.customer_id == null ? null : String(inv.customer_id),
        status: inv.status == null ? null : String(inv.status),
      };
    } catch (err) {
      if (isResourceNotFound(err as ChargebeeError)) return null;
      throw err;
    }
  }

  /**
   * A download link for the invoice PDF.
   *
   * MEASURED against the live site: `POST /invoices/{id}/pdf` returns
   * `download.download_url`, a PRE-SIGNED S3 link that expires. That is why it
   * is minted on demand and never stored, cached, or embedded in a page
   * payload — a link rendered with the page would be dead by the time a
   * customer who left the tab open clicked it.
   *
   * It also means the URL is a bearer credential for that one invoice while it
   * lives, so the caller must establish ownership BEFORE calling this. There is
   * no ownership check here on purpose: this function mints, the route decides.
   */
  async function invoicePdfUrl(invoiceId: string): Promise<InvoiceDownload | null> {
    try {
      const payload = await withRetry(() => request("POST", `/invoices/${encodeURIComponent(invoiceId)}/pdf`));
      const url = payload.download?.download_url;
      if (!url) return null;
      const validTill = payload.download?.valid_till;
      return {
        url: String(url),
        validTillMs: typeof validTill === "number" ? validTill * 1000 : null,
      };
    } catch (err) {
      if (isResourceNotFound(err as ChargebeeError)) return null;
      throw err;
    }
  }

  async function itemPrice(id: string): Promise<ItemPrice | null> {
    try {
      const payload = await withRetry(() => request("GET", `/item_prices/${encodeURIComponent(id)}`));
      const entry = payload.item_price;
      if (!entry) return null;
      return {
        id: String(entry.id ?? id),
        name: String(entry.external_name || entry.name || id),
        priceMinor: typeof entry.price === "number" ? entry.price : null,
        currencyCode: entry.currency_code ?? null,
        period: typeof entry.period === "number" ? entry.period : null,
        periodUnit: entry.period_unit ?? null,
        pricingModel: entry.pricing_model ?? null,
      };
    } catch (err) {
      // An id in the allowlist that Chargebee does not know is a configuration
      // mistake, not a failure to answer: report it as absent so the page still
      // renders the plan by id rather than breaking on one bad entry.
      if (NO_LEDGER_CODES.has((err as ChargebeeError).apiErrorCode ?? "")) return null;
      throw err;
    }
  }

  /**
   * One subscription, any status. Null ONLY for Chargebee's definite "no such
   * subscription" (404 `resource_not_found`).
   *
   * It used to answer null for `invalid_request` too — Chargebee's generic
   * 400 — and for a 200 with no subscription in it, and cancelIfEnded reads
   * null as "the subscription has ended". Anything that is not a definite
   * answer now throws, so the caller changes nothing.
   */
  async function subscription(id: string) {
    let payload: Record<string, any>;
    try {
      payload = await withRetry(() => request("GET", `/subscriptions/${encodeURIComponent(id)}`));
    } catch (err) {
      if (isResourceNotFound(err as ChargebeeError)) return null;
      throw err;
    }
    if (!payload.subscription) {
      throw Object.assign(new Error(`Chargebee /subscriptions/${id} answered with no subscription`), {
        retryable: true,
      }) as ChargebeeError;
    }
    return payload.subscription as Record<string, unknown>;
  }

  /**
   * One customer. Null only for a definite 404 `resource_not_found`.
   *
   * Asked for one reason: to tell a subscription that was DELETED (its
   * customer is still there) from a site or key that is simply the wrong one
   * (nothing is there) before a missing subscription is taken as an ended one.
   */
  async function customer(id: string): Promise<{ id: string } | null> {
    let payload: Record<string, any>;
    try {
      payload = await withRetry(() => request("GET", `/customers/${encodeURIComponent(id)}`));
    } catch (err) {
      if (isResourceNotFound(err as ChargebeeError)) return null;
      throw err;
    }
    if (!payload.customer) {
      throw Object.assign(new Error(`Chargebee /customers/${id} answered with no customer`), {
        retryable: true,
      }) as ChargebeeError;
    }
    return { id: String(payload.customer.id ?? id) };
  }

  /**
   * Every subscription the customer has ever had, whatever its status — ids
   * only.
   *
   * Read by the top-up guard: a paid pack allocated to an EARLIER subscription
   * is recorded in that subscription's ledger, not the current one's, and a
   * guard that looked only at the current one would allocate it again after a
   * resubscription.
   */
  async function subscriptionIdsOf(customerId: string): Promise<string[]> {
    const payload = await withRetry(() =>
      request("GET", "/subscriptions", { "customer_id[is]": customerId, limit: 100 }),
    );
    return (payload.list ?? [])
      .map((entry: Record<string, any>) => entry.subscription?.id)
      .filter((id: unknown): id is string => id != null)
      .map(String);
  }

  return {
    createCustomer,
    capture,
    captureIdempotent,
    findOperation,
    balance,
    ledgerUnits,
    grantedCredits,
    grantBlocks,
    ledgerOperations,
    ledgerOperation,
    subscription,
    customer,
    subscriptionIdsOf,
    itemPrice,
    activeSubscriptions,
    subscribeCustomer,
    allocate,
    chargeItem,
    collectInvoice,
    paidInvoicesFor,
    unpaidInvoicesFor,
    unpaidTopUpCredits,
    transactionsFor,
    transactionsPage,
    paymentSource,
    invoice,
    invoicePdfUrl,
    checkoutPage,
    portalSession,
    managePaymentSourcesPage,
  };
}

function toChargedInvoice(raw: unknown): ChargedInvoice {
  const invoice = (raw ?? {}) as Record<string, any>;
  return {
    id: String(invoice.id),
    status: String(invoice.status ?? "unknown"),
    totalMinor: typeof invoice.total === "number" ? invoice.total : null,
    amountDueMinor: typeof invoice.amount_due === "number" ? invoice.amount_due : null,
    currencyCode: invoice.currency_code == null ? null : String(invoice.currency_code),
    nextRetryAt: fromUnixSeconds(invoice.next_retry_at),
  };
}

function hasLineFor(invoice: Record<string, any> | undefined, itemPriceId: string): boolean {
  return (invoice?.line_items ?? []).some((line: Record<string, any>) => line?.entity_id === itemPriceId);
}

function fromUnixSeconds(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;
}

function operationIdOf(payload: Record<string, any>): string | null {
  return payload.ledger_operation?.id ?? payload.ledger_operations?.[0]?.id ?? null;
}

/** An operation's time in ms: `created_at`, else `ledger_operation_timestamp` (both unix seconds). */
function operationTimeMs(op: Record<string, any>): number | null {
  const seconds = op.created_at ?? op.ledger_operation_timestamp;
  return typeof seconds === "number" && Number.isFinite(seconds) ? seconds * 1000 : null;
}

function usableBalanceOf(payload: Record<string, any>): string | null {
  const usable = payload.ledger_account_balance?.provisioned_balance?.usable_balance;
  return usable == null ? null : decimal(String(usable));
}
