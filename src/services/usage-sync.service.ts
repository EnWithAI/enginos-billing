/**
 * Usage billing: ClickHouse → Chargebee, one time window at a time.
 *
 *   billing_account.last_processed_ingested_at            where the worker is
 *        │
 *   window = (cursor, min(now − lag, cursor + maxRange)]
 *        │
 *   SELECT count(), sum(cost) … GROUP BY TraceId:SpanId       the usage in it
 *        │
 *   INSERT chargebee_sync (PENDING, id = the operation id)
 *        │
 *   POST /ledger_operations/capture  id = that row's id           the charge
 *        │
 *   status → SUCCESS, and only then the cursor moves to the window's end
 *
 * TWO RESPONSIBILITIES, TWO PLACES
 *
 *   billing_account.last_processed_ingested_at   WHERE THE WORKER IS
 *   chargebee_sync.status                        WHAT CHARGEBEE SAID
 *
 * The cursor is a progress checkpoint and nothing else. It moves only when the
 * window in front of it has been RESOLVED, which is the whole restart story:
 * whatever a crashed worker left unfinished is still in front of the cursor
 * when it comes back, so it is picked up rather than skipped.
 *
 * That is the safety argument in four parts:
 *
 *   - Nothing is skipped. An unresolved window leaves the cursor where it was,
 *     so the same usage is offered again next minute. An `OUT_OF_CREDITS` sync
 *     clears itself the moment the customer tops up; there is no requeue step
 *     because the usage was never taken off the queue.
 *   - Nothing is charged twice. The row's id IS the Chargebee ledger operation
 *     id, written before the send. After a lost response the next tick asks
 *     `GET /ledger_operations/{id}` and settles on the answer — it never sends
 *     the same usage under a second id.
 *   - No second row can open the same window. `chargebee_sync_window_uq` is on
 *     (tenant_id, from_ingested_at), and the cursor only ever advances with a
 *     compare-and-set against the value the window opened at. A window is
 *     written only while the cursor still sits at its start, and an empty
 *     window is passed only while no row owns it — both under the account
 *     row's lock — so workers with different window lengths cannot overlap.
 *   - No second caller sends a row that is already being sent. Every send
 *     CLAIMS its row first (a compare-and-set on status and attempt count), a
 *     PROCESSING row is left to its sender for a lease longer than any send
 *     can take, and the answer is written only under the claim that sent it —
 *     so a caller that lost its claim can never turn a SUCCESS back into
 *     anything else. This is what makes the manual sync route, a second
 *     replica and an old worker mid-rollout safe beside the cron.
 *   - Events sharing an end time are not skipped, and re-sent spans are
 *     not counted twice. The window boundary is a TIME, so it cannot fall
 *     inside a millisecond; identity is TraceId:SpanId and lives in the query.
 *     Two jobs, two mechanisms — see integrations/clickhouse/usage-source.ts.
 *
 * The windows are on when each LLM call ended (`Timestamp + duration_ms`).
 * The columns keep their `ingested_at` names (`last_processed_ingested_at`,
 * `from_ingested_at`, `to_ingested_at`) from when they held ClickHouse's
 * ingest time; they now hold call end times.
 *
 * A tenant hours behind (worker down) catches up in ranges of at most
 * maxRange (an hour) — one Chargebee charge each — as many as the run's time
 * budget allows; what a run does not reach, the next one does.
 */

import { isUniqueViolation, type PrismaClient } from "../db/prisma";
import {
  isAuthFailure,
  isSiteBlocked,
  CAPTURE_INSUFFICIENT,
  CAPTURE_NO_LEDGER,
  CAPTURE_OK,
  CAPTURE_RATE_LIMITED,
  CAPTURE_REPLAYED,
  CAPTURE_RETRYABLE,
  type CaptureArgs,
  type CaptureResult,
} from "../integrations/chargebee";
import type { UsageSource, UsageWindow } from "../integrations/clickhouse/usage-source";
import { ACCOUNT, type BlockReason } from "../models/account-status";
import { decimal } from "../models/decimal";
import { isBillable, usdToCredits } from "../models/rate";
import { SYNC, isSettled, retryDelayMs } from "../models/sync-status";
import {
  createBillingAccountRepository,
  type BillingAccount,
  type BillingAccountRepository,
} from "../repositories/billing-account.repository";
import {
  createChargebeeSyncRepository,
  type ChargebeeSync,
  type ChargebeeSyncRepository,
} from "../repositories/chargebee-sync.repository";
import { errorMessage } from "../shared/errors";
import type { Logger } from "../shared/logger";

/** Sixty seconds: a span lands within ~45 s of its call's end (config.ts MIN_LAG_MS). */
const DEFAULT_LAG_MS = 60 * 1000;

/** Alert well before ClickHouse's 90-day TTL turns unbilled usage into lost usage. */
const DEFAULT_BEHIND_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The longest range one charge covers: an hour. An ordinary tick bills the
 * minute since the last one; this only bounds a catch-up. Chargebee refuses a
 * capture larger than the balance WHOLE — it cannot bill part of one — so an
 * org that ran out part-way through a long outage has at most this much held,
 * not the whole outage.
 */
const DEFAULT_MAX_RANGE_MS = 60 * 60 * 1000;

/**
 * How long one pass may keep STARTING ranges. The sweep's executionTimeout is
 * five minutes and the gate check runs after it; a run killed mid-capture
 * leaves a PROCESSING row that waits out its lease. So a pass stops starting
 * new ranges — and new tenants — past this, and the next minute's run goes on
 * from each tenant's cursor. On an ordinary minute it is never reached.
 */
export const DEFAULT_RUN_BUDGET_MS = 3 * 60 * 1000;

/** What one tenant's run did. Also the workflow's output shape. */
export const OUTCOME = {
  IDLE: "idle", // windows read, nothing billable in them
  SYNCED: "synced",
  REPLAYED: "replayed", // a sync we had lost the answer to had in fact landed
  UNKNOWN: "unknown", // outcome unknown; resolved by lookup next tick
  RATE_LIMITED: "rate_limited", // Chargebee throttled us; backing off
  OUT_OF_CREDITS: "out_of_credits", // usage kept, cursor held, retried once credits come back
  INVALID: "invalid", // Chargebee refused the request itself; a human is needed
  HOLDING: "holding", // an unresolved sync exists but is not due for retry yet
  EXHAUSTED: "exhausted", // credits used up: team blocked, nothing sent or read until credits come back
  LOCKED: "locked", // another worker is on this window
  NOT_BILLABLE: "not_billable", // no subscription, cancelled, or a currency switch moving the credits
  WRITTEN_OFF: "written_off", // refused, and its subscription has ended: given up, once
} as const;

export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

/** Outcomes the cursor may move past. Everything else holds the tenant. */
const RESOLVED_OUTCOMES: readonly Outcome[] = [
  OUTCOME.SYNCED,
  OUTCOME.REPLAYED,
  OUTCOME.IDLE,
  OUTCOME.NOT_BILLABLE,
  OUTCOME.WRITTEN_OFF,
];

/** Chargebee's answer → the state we record for it. The whole of §17, in one table. */
const STATUS_FOR: Record<string, string> = {
  [CAPTURE_OK]: SYNC.SUCCESS,
  [CAPTURE_REPLAYED]: SYNC.SUCCESS,
  [CAPTURE_RATE_LIMITED]: SYNC.RATE_LIMITING,
  [CAPTURE_RETRYABLE]: SYNC.UNKNOWN,
  [CAPTURE_INSUFFICIENT]: SYNC.OUT_OF_CREDITS,
  // Nothing was charged and nothing will be until someone configures a prepaid
  // ledger on the subscription. It HOLDS the cursor: the usage waits here, and
  // bills the moment the configuration is fixed. It used to be skipped past,
  // which moved billing over revenue that was never collected.
  [CAPTURE_NO_LEDGER]: SYNC.INVALID,
  terminal: SYNC.INVALID,
};

const OUTCOME_FOR: Record<string, Outcome> = {
  [SYNC.SUCCESS]: OUTCOME.SYNCED,
  [SYNC.RATE_LIMITING]: OUTCOME.RATE_LIMITED,
  [SYNC.UNKNOWN]: OUTCOME.UNKNOWN,
  [SYNC.OUT_OF_CREDITS]: OUTCOME.OUT_OF_CREDITS,
  [SYNC.INVALID]: OUTCOME.INVALID,
};

export interface TenantResult {
  tenantSlug: string;
  outcome: Outcome;
  reason?: string;
  /** Windows resolved this tick. */
  windows?: number;
  events?: number;
  amount?: string;
  billedUsd?: string;
  newCursor?: string;
  /**
   * Where the cursor ACTUALLY ended up, as committed to the database — which is
   * not always the window end the caller asked for. `null` means it did not
   * move at all. The loop must follow this rather than its own arithmetic: see
   * processWindows.
   */
  nextCursorMs?: number | null;
  syncId?: string;
  attempts?: number;
  error?: string;
}

export interface UsageSyncDeps {
  /** Builds both repositories when they are not given. Tests pass a fake here. */
  prisma?: PrismaClient;
  accounts?: BillingAccountRepository;
  syncs?: ChargebeeSyncRepository;
  usage: UsageSource;
  chargebee: {
    /** Send without asking first. Only ever used on an id that has never been on the wire. */
    capture(args: CaptureArgs): Promise<CaptureResult>;
    /** Retrieve the id first, and send only on a definite 404. Every retry uses this. */
    captureIdempotent(args: CaptureArgs): Promise<CaptureResult>;
  };
  usdPerCredit: string;
  /** Only usage ingested at least this long ago is read. */
  lagMs?: number;
  /** The longest range one charge covers (BILLING_MAX_RANGE_MS). An ordinary tick bills far less. */
  maxRangeMs?: number;
  /**
   * Unresolved syncs past this many attempts log as errors. The row STAYS
   * unresolved — counting attempts never turns an unknown into a failure.
   */
  maxAttempts?: number;
  clock?: () => number;
  logger?: Logger;
  hatchetRunId?: string;
  /** Blocks the tenant's LiteLLM team once its Chargebee credits are used up (gateway-budget.service.ts). */
  blockBudget?: (tenantId: string, reason?: BlockReason) => Promise<void>;
  /** Hands the team back to its plan — used when a cancellation lands while this is blocking it. */
  releaseBudget?: (tenantId: string) => Promise<void>;
}

type Account = BillingAccount;
type Sync = ChargebeeSync;

export function createUsageSyncService(deps: UsageSyncDeps) {
  const accounts = deps.accounts ?? createBillingAccountRepository(deps.prisma);
  const syncs = deps.syncs ?? createChargebeeSyncRepository(deps.prisma);
  const lagMs = deps.lagMs ?? DEFAULT_LAG_MS;
  const maxRangeMs = deps.maxRangeMs ?? DEFAULT_MAX_RANGE_MS;
  const maxAttempts = deps.maxAttempts ?? 10;
  const clock = deps.clock ?? (() => Date.now());
  const log = deps.logger ?? console;

  /** `deadline` (this service's clock): no new range is started past it. */
  async function runTenant(tenantSlug: string, deadline: number = Number.POSITIVE_INFINITY): Promise<TenantResult> {
    const account = await accounts.findBySlug(tenantSlug);
    if (!account) return { tenantSlug, outcome: OUTCOME.NOT_BILLABLE, reason: "no billing account" };
    if (!account.chargebeeSubscriptionId || !account.ledgerUnitId) {
      return { tenantSlug, outcome: OUTCOME.NOT_BILLABLE, reason: "no subscription linked" };
    }

    // 0. Out of credits: the whole tenant waits for credits to come back.
    //
    //    Chargebee could only refuse again, so nothing is sent — not the held
    //    window, not a lookup — and nothing new is read. The usage waits in
    //    ClickHouse in front of a cursor that has not moved. A top-up, a
    //    renewal or the daily resync is what moves the account out of
    //    `exhausted` (activate()); the next tick then resolves the held window
    //    first and bills on from there.
    if (account.status === ACCOUNT.EXHAUSTED) return holdExhausted(account);

    // A currency switch is moving the tenant's credits to a subscription in
    // another currency. Nothing is sent and nothing new is read: the usage
    // waits in ClickHouse in front of a cursor the switch never moves, and is
    // billed to the new subscription once it is linked. The repository
    // refuses every step of a sync while the account is `switching` anyway —
    // a window (openWindow), an empty-window step (advancePastEmptyWindow),
    // a send (claim), a write-off (writeOff) — so this is the fast path, not
    // the guard: it saves the tick its queries, and the log the warnings of a
    // claim refused every minute for as long as the switch runs. A held row
    // is not resolved here either: it could not be sent, and the switch
    // re-pins it to the new subscription if it never landed.
    if (account.status === ACCOUNT.SWITCHING) return switching(tenantSlug);

    log.log?.({ metric: "billing.sync.started", tenantSlug }, "Billing sync started");

    // 1. Resolve whatever is unresolved, BEFORE reading anything new.
    //
    //    This is the recovery path and the ordering guarantee in one. An
    //    unresolved sync sits in front of the cursor, so reading past it would
    //    offer the same usage under a second id — and if the first one landed,
    //    the customer pays twice.
    const held = await syncs.oldestUnresolved(account.tenantId);
    let recovered: TenantResult | null = null;
    let current = account;
    if (held) {
      const result = await resolveHeld(held, account);
      if (!isResolved(result.outcome)) {
        // A held tenant is the one whose cursor is NOT moving, so it is the
        // one the behind-alarm exists for. It used to live only in
        // processWindows, which a held tenant never reaches — so a window held
        // INVALID or OUT_OF_CREDITS for weeks never raised it, and the first
        // sign would have been ClickHouse's TTL taking the unbilled spans.
        // Not for a cancelled account: nothing after its cursor is billable,
        // so there is nothing for the TTL to take.
        if (account.status !== ACCOUNT.CANCELLED) warnIfBehind(account, clock());
        return result;
      }
      // A recovery that WORKED is the most interesting thing that can happen to
      // a tenant, and the read that follows it usually finds nothing new.
      // Carried forward so the tick does not report `idle` and hide it from the
      // one operator looking for it.
      recovered = result;
      // And re-read the account, because the recovery just MOVED THE CURSOR.
      // Reading on from the stale value would re-offer the window that was
      // recovered, which the window index refuses — correctly, but it would
      // cost the tenant its tick every time a recovery succeeded.
      current = (await accounts.findByTenantId(account.tenantId)) ?? account;
    }

    // Usage after cancellation is not ours to charge. An unresolved sync from
    // before it (above) still gets recovered.
    if (current.status === ACCOUNT.CANCELLED) {
      return recovered ?? { tenantSlug, outcome: OUTCOME.NOT_BILLABLE, reason: "subscription cancelled" };
    }
    // A currency switch started while the recovery ran: nothing new is read.
    if (current.status === ACCOUNT.SWITCHING) return recovered ?? switching(tenantSlug);

    return processWindows(current, recovered, deadline);
  }

  /** A tenant whose credits a currency switch is moving: not billable this tick, and nothing lost by it. */
  function switching(tenantSlug: string): TenantResult {
    return { tenantSlug, outcome: OUTCOME.NOT_BILLABLE, reason: "currency switch in progress" };
  }

  /**
   * An exhausted tenant's tick: keep its LiteLLM team blocked, and nothing else.
   *
   * The block is re-asserted every tick — one team read while it is in place —
   * so a block that failed when the credits ran out lands on the next tick
   * rather than waiting for a top-up. The one row settled here is a refusal on
   * a subscription the account no longer bills: no top-up can reach it, and
   * writing it off asks Chargebee nothing.
   */
  async function holdExhausted(account: Account): Promise<TenantResult> {
    const tenantSlug = account.routingSlug;
    const held = await syncs.oldestUnresolved(account.tenantId);
    if (held && abandoned(held, account)) return writeOff(held, account);

    await blockExhausted(account.tenantId, tenantSlug);
    warnIfBehind(account, clock());
    return {
      tenantSlug,
      outcome: OUTCOME.EXHAUSTED,
      reason: "credits used up; held until a top-up",
      ...(held ? { syncId: held.id, amount: decimal(held.amount), attempts: held.attemptCount } : {}),
    };
  }

  /**
   * Read the cursor, then bill forward one window at a time.
   *
   * `recovered` is a sync that resolved earlier this tick; it becomes the
   * reported outcome unless a fresh window is billed after it.
   */
  async function processWindows(
    account: Account,
    recovered: TenantResult | null = null,
    deadline: number = Number.POSITIVE_INFINITY,
  ): Promise<TenantResult> {
    const tenantSlug = account.routingSlug;

    const started = await startingCursor(account, tenantSlug);
    if (started == null) return locked(tenantSlug, clock());
    let cursor: number = started;

    const now = await deps.usage.now();
    const until = now - lagMs;

    warnIfBehind({ ...account, lastProcessedIngestedAt: new Date(cursor) }, now);

    // A written-off window was not billed, so it is not counted as one; it
    // stays the reported outcome only if nothing is billed after it.
    const billed = recovered != null && recovered.outcome !== OUTCOME.NOT_BILLABLE && recovered.outcome !== OUTCOME.WRITTEN_OFF;
    let windows = billed ? 1 : 0;
    let events = billed ? (recovered?.events ?? 0) : 0;
    let last: TenantResult | null = recovered;

    for (let i = 0; ; i += 1) {
      // Everything settled since the cursor, up to maxRange: the minute since
      // the last tick, ordinarily; an hour at a time after an outage.
      //
      // Two workers reading the same cursor a moment apart compute DIFFERENT
      // ends, and that is safe: a row is opened, and an empty range passed,
      // only while the cursor still sits at its start, under the account row's
      // lock (chargebee-sync.repository.ts openWindow, and
      // billing-account.repository.ts advancePastEmptyWindow). So of two
      // ranges from one start, exactly one is billed or passed; the other
      // finds the cursor gone and backs off. A retry never recomputes a range:
      // it re-sends the row it stored, under that row's id.
      const to = Math.min(until, cursor + maxRangeMs);
      if (to <= cursor) break;
      // Past the run's budget, the range in hand is the last: the next run
      // carries on from the cursor.
      if (i > 0 && clock() >= deadline) break;

      const usage = await deps.usage.readWindow(tenantSlug, { fromMs: cursor, toMs: to });

      log.log?.(
        {
          metric: "billing.sync.window_read",
          tenantSlug,
          from: new Date(cursor).toISOString(),
          to: new Date(to).toISOString(),
          events: usage.eventCount,
        },
        "Billing window read",
      );

      if (usage.eventCount === 0) {
        // No usage, so nothing to synchronise and no row worth keeping — a log
        // of empty minutes is noise. The window is still RESOLVED, because the
        // aggregate covered the whole range rather than a page of it, so the
        // cursor moves past it.
        //
        // Safe without a row: the lag guarantees the range has settled, and a
        // worker that read the same `from` with a LATER end may have found
        // usage further on and written a row at this same start — which is
        // why the move is refused while a row owns the window. A settled one
        // is stepped over, as syncWindow does.
        const step = await accounts.advancePastEmptyWindow(account.tenantId, new Date(cursor), new Date(to));
        if (step.moved) {
          cursor = to;
          continue;
        }
        if (!step.owner || !isSettled(step.owner.status)) return locked(tenantSlug, cursor);
        const repaired = await stepOverSettled(account, cursor, step.owner);
        if (repaired.nextCursorMs == null) return locked(tenantSlug, cursor);
        cursor = repaired.nextCursorMs;
        continue;
      }

      const result = await syncWindow(account, cursor, to, usage);
      if (!isResolved(result.outcome)) return { ...result, windows, events };

      // Follow the cursor the database COMMITTED, not the `to` we asked for.
      //
      // They differ whenever the repair path fires: a settled row written by
      // another worker, which read a different end for the same start, moves
      // the cursor to ITS end, not to ours.
      // Carrying on from `to` would leave the in-memory cursor permanently
      // ahead of the stored one, and every window after that would overlap a
      // range already billed. That is a double charge, and it is silent.
      if (result.nextCursorMs == null) return { ...result, windows, events };

      windows += 1;
      events += usage.eventCount;
      cursor = result.nextCursorMs;
      last = result;
    }

    const summary: TenantResult = last
      ? { ...last, windows, events, newCursor: new Date(cursor).toISOString() }
      : { tenantSlug, outcome: OUTCOME.IDLE, windows, events, newCursor: new Date(cursor).toISOString() };

    log.log?.(
      { metric: "billing.sync.completed", tenantSlug, processed: events, windows, newCursor: summary.newCursor },
      "Billing sync completed",
    );
    return summary;
  }

  /**
   * Write the sync row for a window, then send it.
   *
   * The row commits BEFORE Chargebee is called. After that, whatever happens —
   * timeout, crash, a second worker — the window belongs to this row and to no
   * other, and the operation id is fixed.
   */
  async function syncWindow(account: Account, fromMs: number, toMs: number, usage: UsageWindow): Promise<TenantResult> {
    const tenantSlug = account.routingSlug;
    const billedUsd = decimal(usage.billedUsd);
    const amount = usdToCredits(billedUsd, deps.usdPerCredit);

    // Zero-cost usage never reaches Chargebee — it rejects a zero amount — but
    // it is still recorded, so the window that contained it is visible.
    const billable = isBillable(amount);
    const settledAt = billable ? null : new Date(clock());

    let row: Sync | null;
    try {
      row = await syncs.openWindow({
        tenantId: account.tenantId,
        chargebeeSubscriptionId: account.chargebeeSubscriptionId,
        ledgerUnitId: account.ledgerUnitId,
        fromIngestedAt: new Date(fromMs),
        toIngestedAt: new Date(toMs),
        eventCount: usage.eventCount,
        amount,
        billedUsd,
        status: billable ? SYNC.PENDING : SYNC.SUCCESS,
        error: billable ? null : "no billable amount in this window",
        settledAt,
        hatchetRunId: deps.hatchetRunId ?? null,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;

      // The window index refused this: a row for this window already exists.
      //
      // If it is still owed, backing off is right — it covers the range, and
      // the next tick's recovery pass picks it up before anything else.
      //
      // If it is RESOLVED, the cursor is behind a window that is already paid
      // for, and backing off would wedge the tenant here for ever: every tick
      // would read the same window, collide again, and give up. This is the one
      // way the cursor and the log can disagree, so this is where they are put
      // back together.
      const existing = await syncs.findByWindowStart(account.tenantId, new Date(fromMs));
      if (!existing || !isSettled(existing.status)) return locked(tenantSlug, fromMs);
      return stepOverSettled(account, fromMs, existing);
    }

    // The cursor moved on while this window was being read: another worker is
    // ahead of us, and a window opened from the old position could overlap
    // what it bills next. Nothing was written, so there is nothing to undo.
    if (!row) return locked(tenantSlug, fromMs);

    if (!billable) {
      if (!(await advanceCursor(account.tenantId, fromMs, toMs))) return locked(tenantSlug, fromMs);
      return {
        tenantSlug,
        outcome: OUTCOME.IDLE,
        reason: "no billable amount",
        amount,
        billedUsd,
        events: usage.eventCount,
        syncId: row.id,
        nextCursorMs: toMs,
      };
    }

    // `capture`, not `captureIdempotent`: this id has never been on the wire,
    // so there is nothing for a lookup to find and the extra round trip would
    // be paid on every tenant every minute. Every path that CAN have sent it —
    // PROCESSING, UNKNOWN, and every retry — goes through `recover()` below,
    // which always asks first.
    return send(row, account, { verify: false });
  }

  /**
   * The cursor is behind a window that is already paid for: move it to that
   * row's end.
   *
   * This is the one way the cursor and the log can disagree — a worker that
   * died between settling a row and moving the cursor, or a row written by a
   * worker with a different window length — and backing off here would wedge
   * the tenant for ever: every tick would meet the same settled row and give
   * up. The result carries the settled row's end, NOT this window's end; they
   * can differ, and that difference is the reason this exists.
   */
  async function stepOverSettled(
    account: Account,
    fromMs: number,
    existing: Pick<Sync, "id" | "toIngestedAt" | "eventCount">,
  ): Promise<TenantResult> {
    const tenantSlug = account.routingSlug;
    const repairedTo = existing.toIngestedAt.getTime();
    const repaired = await advanceCursor(account.tenantId, fromMs, repairedTo);
    log.warn?.(
      { metric: "billing.sync.cursor_repaired", tenantSlug, syncId: existing.id, to: existing.toIngestedAt.toISOString() },
      "This window was already billed but the cursor had not followed; moving it past the settled row",
    );
    return {
      tenantSlug,
      outcome: OUTCOME.IDLE,
      reason: "window already billed",
      events: existing.eventCount,
      syncId: existing.id,
      nextCursorMs: repaired ? repairedTo : null,
    };
  }

  /**
   * The held row, resolved: written off if it is a refusal whose subscription
   * has ended — before a send, or straight after one that ended that way —
   * and otherwise recovered as ever.
   */
  async function resolveHeld(held: Sync, account: Account): Promise<TenantResult> {
    if (abandoned(held, account)) return writeOff(held, account);

    const result = await recover(held, account);
    if (result.outcome !== OUTCOME.OUT_OF_CREDITS && result.outcome !== OUTCOME.INVALID) return result;

    // The send just answered with a refusal. On an ended subscription that is
    // final; the row as it now stands is what the write-off compares against.
    const refused = await syncs.findByWindowStart(held.tenantId, held.fromIngestedAt);
    return refused != null && abandoned(refused, account) ? writeOff(refused, account) : result;
  }

  /**
   * Is this a refusal that can never clear?
   *
   * A refused capture waits for credits — a top-up, a renewal. Neither can
   * reach a subscription that has ended, so once the row's subscription is no
   * longer the account's live one (the account is cancelled, or it has moved
   * to another subscription) the refusal is final. Left held, it never ended:
   * every minute the tenant was visited, the capture re-sent, the team of a
   * cancelled customer blocked again as `exhausted`, and after seven days a
   * `billing.sync.behind` error every minute for ever. On an account that had
   * moved to a new subscription it was worse — the new subscription's billing
   * never started, and its team was blocked every minute.
   *
   * Only DEFINITE refusals. PENDING, PROCESSING, UNKNOWN and RATE_LIMITING may
   * yet land and are recovered as ever, against the subscription pinned on
   * them; if that answers with a refusal, this then applies.
   */
  function abandoned(row: Sync, account: Account): boolean {
    const refused = row.status === SYNC.OUT_OF_CREDITS || row.status === SYNC.INVALID;
    if (!refused) return false;
    return account.status === ACCOUNT.CANCELLED || !pinnedToLinked(row, account);
  }

  /** Is the row billed against the subscription the account is linked to now? */
  function pinnedToLinked(row: Sync, account: Account): boolean {
    return row.chargebeeSubscriptionId == null || row.chargebeeSubscriptionId === account.chargebeeSubscriptionId;
  }

  /**
   * Give the row up — once, logged as an error with what was lost — and move
   * the cursor past it, as for a settled row: it is resolved, and the cursor
   * of an account that has moved to a new subscription must not stay behind
   * it.
   */
  async function writeOff(row: Sync, account: Account): Promise<TenantResult> {
    const tenantSlug = account.routingSlug;
    const reason =
      account.status === ACCOUNT.CANCELLED
        ? `written off: ${row.status} and the subscription has ended (account cancelled)`
        : `written off: ${row.status} on ${row.chargebeeSubscriptionId}, which the account no longer bills`;
    if (!(await syncs.writeOff(row, reason))) return locked(tenantSlug, row.fromIngestedAt.getTime());

    log.error?.(
      {
        metric: "billing.sync.written_off",
        tenantSlug,
        syncId: row.id,
        was: row.status,
        amount: row.amount,
        billedUsd: row.billedUsd,
        subscriptionId: row.chargebeeSubscriptionId,
        accountStatus: account.status,
        window: `${row.fromIngestedAt.toISOString()} → ${row.toIngestedAt.toISOString()}`,
      },
      "Refused usage on a subscription that has ended; it can never be charged and is written off",
    );

    const moved = await advanceCursor(row.tenantId, row.fromIngestedAt.getTime(), row.toIngestedAt.getTime());
    return {
      tenantSlug,
      outcome: OUTCOME.WRITTEN_OFF,
      reason: row.status,
      amount: decimal(row.amount),
      events: row.eventCount,
      syncId: row.id,
      nextCursorMs: moved ? row.toIngestedAt.getTime() : null,
    };
  }

  /**
   * Resolve a sync that is holding its tenant.
   *
   * The status says what is safe to do, and this is the only place that
   * distinction is made:
   *
   *   PENDING         written but never sent. Nothing to ask about.
   *   PROCESSING      on the wire. Left to its sender until the lease runs
   *                   out; after that its sender is dead, and we ask.
   *   UNKNOWN         Chargebee may or may not have applied it.
   *   RATE_LIMITING   refused before it was applied, on a backoff.
   *   OUT_OF_CREDITS  a definite refusal; clears itself on a top-up.
   *   INVALID         a definite refusal; needs a person, on a long backoff.
   *
   * Everything except a never-sent PENDING is re-sent through
   * `captureIdempotent`, which retrieves the id and only sends on a definite
   * 404. That is §25 rule 8 — an UNKNOWN is never retried blind — and the
   * definite refusals go the same way because one cheap GET is worth more than
   * reasoning about whether "definite" was really definite.
   */
  async function recover(row: Sync, account: Account): Promise<TenantResult> {
    const tenantSlug = account.routingSlug;

    // An OUT_OF_CREDITS row gets here only once the account has left
    // `exhausted` (holdExhausted), so it is due at once.
    const waitMs = retryDelayMs(row.status, row.attemptCount);
    const dueAt = row.updatedAt.getTime() + waitMs;
    if (waitMs > 0 && clock() < dueAt) {
      // Backing off, not stuck. The cursor stays where it is, so nothing is
      // lost by waiting — §7's "do not blindly retry forever".
      log.warn?.(
        {
          metric: "billing.sync.backoff",
          tenantSlug,
          syncId: row.id,
          status: row.status,
          attempts: row.attemptCount,
          dueAt: new Date(dueAt).toISOString(),
        },
        "An unresolved sync is backing off; billing holds here until it is due",
      );
      return { tenantSlug, outcome: OUTCOME.HOLDING, reason: row.status, syncId: row.id, attempts: row.attemptCount };
    }

    log.warn?.(
      {
        metric: "billing.sync.recover",
        tenantSlug,
        syncId: row.id,
        was: row.status,
        attempts: row.attemptCount,
        amount: row.amount,
        window: `${row.fromIngestedAt.toISOString()} → ${row.toIngestedAt.toISOString()}`,
      },
      "Recovering an unresolved sync before reading anything new",
    );

    return send(row, account, { verify: row.status !== SYNC.PENDING });
  }

  /**
   * Claim the sync, send it, and record what came back — under the claim.
   *
   * PROCESSING is written and COMMITTED before the request leaves, and that
   * ordering is what makes the PENDING/PROCESSING distinction true rather than
   * decorative: a row still reading PENDING has provably never been sent, so
   * `recover()` may send it without a lookup. A crash anywhere after this
   * update leaves PROCESSING, which is resolved by asking Chargebee.
   *
   * The claim is a compare-and-set against the row as it was READ. Two callers
   * that read the same row — the cron and a manual sync, two replicas — both
   * try it and exactly one sends; the other is told the row is taken. The
   * answer is then written only if the claim is still ours, so a caller whose
   * claim was taken over (it outlived its lease) cannot overwrite what the new
   * owner recorded — in particular, cannot turn a SUCCESS into an INVALID.
   */
  async function send(row: Sync, account: Account, opts: { verify: boolean }): Promise<TenantResult> {
    const tenantSlug = account.routingSlug;
    // Plain strings from the repository (chargebee-sync.repository.ts), and
    // decimal() takes exponent notation too — so no amount, however small,
    // can throw here before the claim and wedge the tenant (C44).
    const amount = decimal(row.amount);
    const billedUsd = decimal(row.billedUsd);

    const claim = await syncs.claim(row);
    if (!claim) return locked(tenantSlug, row.fromIngestedAt.getTime());

    const args: CaptureArgs = {
      id: row.id,
      subscriptionId: row.chargebeeSubscriptionId!,
      unitId: row.ledgerUnitId!,
      amount,
      metadata: {
        tenant_slug: tenantSlug,
        ingested_from: row.fromIngestedAt.toISOString(),
        ingested_to: row.toIngestedAt.toISOString(),
        event_count: row.eventCount,
        billed_usd: billedUsd,
      },
      now: clock(),
    };

    const result = opts.verify
      ? await deps.chargebee.captureIdempotent(args)
      : await deps.chargebee.capture(args);

    const status = STATUS_FOR[result.kind] ?? SYNC.INVALID;

    if (status === SYNC.SUCCESS) {
      if (!(await syncs.markSuccess(claim, new Date(clock())))) return claimLost(row, tenantSlug, result.kind);

      // §17: the window is resolved, so and only so the cursor moves.
      const moved = await advanceCursor(row.tenantId, row.fromIngestedAt.getTime(), row.toIngestedAt.getTime());
      if (!moved) {
        log.warn?.(
          { metric: "billing.sync.cursor_race", tenantSlug, syncId: row.id },
          "The sync settled but the cursor had already moved; leaving it where it is",
        );
      }

      // The LiteLLM cap normally stops spend first, but it counts only what
      // reaches the team; Chargebee is what the customer actually bought.
      // Only the LINKED subscription's balance says anything about the
      // account: an old row settling against a subscription the account has
      // left must not mark the new one exhausted.
      if (result.balanceAfter != null && !isBillable(result.balanceAfter) && pinnedToLinked(row, account)) {
        await markExhausted(row.tenantId, tenantSlug);
      }

      return {
        tenantSlug,
        outcome: result.kind === CAPTURE_OK ? OUTCOME.SYNCED : OUTCOME.REPLAYED,
        amount,
        billedUsd,
        events: row.eventCount,
        syncId: row.id,
        // Null when the compare-and-set found someone else had already moved
        // it. The caller must then stop rather than assume its own position.
        nextCursorMs: moved ? row.toIngestedAt.getTime() : null,
      };
    }

    const err = result.error;
    if (!(await syncs.markUnresolved(claim, status, err?.message ?? `unresolved: ${result.kind}`))) {
      return claimLost(row, tenantSlug, result.kind);
    }

    const exhausted = status === SYNC.OUT_OF_CREDITS && pinnedToLinked(row, account);
    if (exhausted) await markExhausted(row.tenantId, tenantSlug);

    log[status === SYNC.RATE_LIMITING ? "warn" : "error"]?.(
      {
        metric: metricFor(status, result, claim.attemptCount, maxAttempts),
        tenantSlug,
        syncId: row.id,
        status,
        attempts: claim.attemptCount,
        amount,
        window: `${row.fromIngestedAt.toISOString()} → ${row.toIngestedAt.toISOString()}`,
        subscriptionId: row.chargebeeSubscriptionId,
        // Null: an exhausted tenant is not retried on a timer; credits coming back release it.
        retryInMs: exhausted ? null : retryDelayMs(status, claim.attemptCount),
        err: err?.message,
      },
      REASON[status] ?? "Chargebee did not accept this window; billing holds here",
    );

    return {
      tenantSlug,
      outcome: OUTCOME_FOR[status] ?? OUTCOME.INVALID,
      reason: status,
      amount,
      syncId: row.id,
      attempts: claim.attemptCount,
      error: err?.message,
    };
  }

  /**
   * Where this tenant's billing starts, laying the cursor down if it has none.
   *
   * A tenant whose subscription was linked before this service kept a cursor
   * starts at now(), never at epoch: ClickHouse holds 90 days of spans and a
   * cursor at zero would invoice a quarter of free-plan usage on the first tick.
   *
   * Create-only, and the `IS NULL` is what makes it so. If it matches nothing,
   * another worker laid one down first and THAT is the value to carry on with —
   * using ours would make every compare-and-set below miss.
   */
  async function startingCursor(account: Account, tenantSlug: string): Promise<number | null> {
    const stored = account.lastProcessedIngestedAt?.getTime();
    if (stored != null) return stored;

    const at = clock();
    if (await accounts.layCursorIfMissing(account.tenantId, new Date(at))) {
      log.warn?.(
        { metric: "billing.sync.cursor_created", tenantSlug, at: new Date(at).toISOString() },
        "Tenant had no billing cursor; starting from now rather than from ClickHouse's retention",
      );
      return at;
    }

    const fresh = await accounts.findByTenantId(account.tenantId);
    return fresh?.lastProcessedIngestedAt?.getTime() ?? null;
  }

  /**
   * Move the cursor — compare-and-set, never a blind write.
   *
   * `from` is where the window opened, so an update that matches nothing means
   * someone else has already moved it. That is the whole defence against a
   * worker resumed after a long pause rewinding a tenant's billing to where it
   * remembers rather than where it is.
   */
  function advanceCursor(tenantId: string, fromMs: number, toMs: number): Promise<boolean> {
    return accounts.advanceCursor(tenantId, new Date(fromMs), new Date(toMs));
  }

  /**
   * Our answer arrived after the row stopped being ours: another caller took
   * it over once our lease ran out, and it is theirs to record. Nothing is
   * written — whatever we learnt, they learn by lookup — and the cursor is
   * theirs to move.
   */
  function claimLost(row: Sync, tenantSlug: string, kind: string): TenantResult {
    log.warn?.(
      { metric: "billing.sync.claim_lost", tenantSlug, syncId: row.id, answer: kind },
      "Another caller took this sync over while our request was out; leaving the outcome to them",
    );
    return { tenantSlug, outcome: OUTCOME.LOCKED, syncId: row.id };
  }

  /**
   * Not a lookback and not a filter — an alarm. Tenant tables drop spans after
   * 90 days, so a cursor this far behind is revenue about to become unbillable.
   */
  function warnIfBehind(account: Account, nowMs: number) {
    const cursor = account.lastProcessedIngestedAt?.getTime();
    if (cursor == null || nowMs - cursor <= DEFAULT_BEHIND_MS) return;
    log.error?.(
      { metric: "billing.sync.behind", tenantSlug: account.routingSlug, cursor: new Date(cursor).toISOString() },
      "Billing has not moved in more than 7 days; usage may age out of ClickHouse",
    );
  }

  function locked(tenantSlug: string, fromMs: number): TenantResult {
    log.warn?.(
      { metric: "billing.sync.raced", tenantSlug, from: new Date(fromMs).toISOString() },
      "Another worker already holds this window; leaving it to them",
    );
    return { tenantSlug, outcome: OUTCOME.LOCKED };
  }

  function isResolved(outcome: Outcome): boolean {
    return RESOLVED_OUTCOMES.includes(outcome);
  }

  /**
   * Chargebee says the credits are gone: mark the account and block the
   * tenant's LiteLLM team so no more usage accrues. From the next tick the
   * tenant is held (holdExhausted) until credits come back.
   */
  async function markExhausted(tenantId: string, tenantSlug: string) {
    // A cancelled account's team has been handed back to its plan: blocking
    // it would take the free plan away too, and nothing would lift it. A
    // switching one belongs to the currency switch, which decides what it is
    // once its credits have moved. Either way: nothing.
    if (!(await accounts.markExhaustedUnlessCancelled(tenantId))) return;
    if (await blockExhausted(tenantId, tenantSlug)) {
      log.warn?.({ metric: "billing.budget.exhausted_blocked", tenantSlug }, "Credits used up; LiteLLM team blocked until a top-up");
    }
  }

  /**
   * Block the team as `exhausted` via /team/update. Best effort — a failure is
   * loud, and the next tick tries again (holdExhausted). True when it landed.
   */
  async function blockExhausted(tenantId: string, tenantSlug: string): Promise<boolean> {
    if (!deps.blockBudget) return false;
    try {
      await deps.blockBudget(tenantId, "exhausted");
    } catch (err) {
      log.error?.(
        { metric: "billing.budget.block_failed", tenantSlug, reason: "exhausted", err: errorMessage(err) },
        "Credits used up but the LiteLLM team could not be blocked",
      );
      return false;
    }
    // A cancellation that landed between the status write and the block has
    // already handed the team back — and this block undid that. cancel()
    // writes its status before it releases, so looking now is enough.
    const now = await accounts.findByTenantId(tenantId);
    if (now?.status === ACCOUNT.CANCELLED && deps.releaseBudget) {
      try {
        await deps.releaseBudget(tenantId);
      } catch (err) {
        log.error?.(
          { metric: "billing.budget.release_failed", tenantSlug, err: errorMessage(err) },
          "Cancelled while being blocked, and the team could not be handed back; the daily resync retries it",
        );
      }
    }
    return true;
  }

  /**
   * One pass across every billable tenant. Per-tenant failures are caught and
   * counted, never allowed to abort the pass — one broken subscription must not
   * stop everyone else's billing.
   */
  async function runOnce(slugs?: string[], { deadline }: { deadline?: number } = {}) {
    const budgetEnds = deadline ?? clock() + DEFAULT_RUN_BUDGET_MS;
    // Plus any tenant holding an unresolved sync, whatever its account status
    // now: it must be resolved even after the account cancelled, or a charge
    // that landed never gets recorded and the tenant never moves again.
    const visit = slugs?.length
      ? await accounts.listBySlugs(slugs)
      : await accounts.listBillable(await syncs.tenantIdsWithUnresolved());

    const results: TenantResult[] = [];
    const errors: Array<{ tenantSlug: string; error: string }> = [];

    let reached = 0;
    for (const account of visit) {
      // Out of budget: the tenants not reached are billed from their cursors
      // next minute. Nothing is skipped — a cursor only moves past a range
      // that was billed.
      if (clock() >= budgetEnds) break;
      reached += 1;
      try {
        results.push(await runTenant(account.routingSlug, budgetEnds));
      } catch (err) {
        errors.push({ tenantSlug: account.routingSlug, error: errorMessage(err) });
        log.error?.(
          { metric: "billing.sync.tenant_error", tenantSlug: account.routingSlug, err: errorMessage(err) },
          "Usage sync failed for tenant; nothing resolved, continuing",
        );
      }
    }

    const count = (outcome: Outcome) => results.filter((r) => r.outcome === outcome).length;
    if (reached < visit.length) {
      log.warn?.(
        { metric: "billing.sync.budget_spent", reached, tenants: visit.length },
        "The pass used its time budget; the tenants not reached are billed next minute, from their cursors",
      );
    }
    const summary = {
      tenantsScanned: reached,
      synced: count(OUTCOME.SYNCED),
      replayed: count(OUTCOME.REPLAYED),
      idle: count(OUTCOME.IDLE),
      unknown: count(OUTCOME.UNKNOWN),
      rateLimited: count(OUTCOME.RATE_LIMITED),
      outOfCredits: count(OUTCOME.OUT_OF_CREDITS),
      invalid: count(OUTCOME.INVALID),
      holding: count(OUTCOME.HOLDING),
      exhausted: count(OUTCOME.EXHAUSTED),
      locked: count(OUTCOME.LOCKED),
      writtenOff: count(OUTCOME.WRITTEN_OFF),
      errors,
      results,
    };
    log.log?.({ metric: "billing.sync.pass", ...summary, results: undefined }, "Usage sync pass complete");
    return summary;
  }

  return { runOnce, runTenant };
}

export type UsageSyncService = ReturnType<typeof createUsageSyncService>;

/** One sentence per state, so the log says what to do about it and not just what happened. */
const REASON: Record<string, string> = {
  [SYNC.UNKNOWN]:
    "Sync outcome unknown; the row is resolved by lookup on the next tick, never by re-sending",
  [SYNC.RATE_LIMITING]: "Chargebee is throttling us; the same window is sent again after a backoff",
  [SYNC.OUT_OF_CREDITS]:
    "Customer is out of credits; the usage is retained and the tenant held — nothing sent or read — until a top-up or renewal brings credits back",
  [SYNC.INVALID]: "Chargebee refused the request itself; billing holds here until it is fixed",
};

/**
 * Three different jobs for whoever is paged.
 *
 * A blocked site and a bad key stop EVERY tenant and are fixed by a person;
 * `stuck` is one sync Chargebee has not answered about in a long time. They
 * arrive as the same `retryable` classification, so the error itself is what
 * tells them apart.
 */
function metricFor(status: string, result: CaptureResult, attempts: number, maxAttempts: number): string {
  const err = result.error;
  if (status === SYNC.UNKNOWN) {
    if (err && isSiteBlocked(err)) return "billing.sync.site_disabled";
    if (err && isAuthFailure(err)) return "billing.sync.unauthenticated";
    return attempts >= maxAttempts ? "billing.sync.stuck" : "billing.sync.unknown_outcome";
  }
  if (status === SYNC.RATE_LIMITING) return "billing.sync.rate_limited";
  if (status === SYNC.OUT_OF_CREDITS) return "billing.sync.out_of_credits";
  return result.kind === CAPTURE_NO_LEDGER ? "billing.sync.no_ledger" : "billing.sync.invalid";
}
