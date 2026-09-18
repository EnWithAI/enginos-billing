/**
 * Usage billing: ClickHouse usage → Chargebee capture → ledger, behind ONE
 * PostgreSQL cursor.
 *
 *   billing_cursor (last_processed_at, last_event_id)        where billing has reached
 *        │
 *   ClickHouse span_nodes WHERE (ingested_at, key) > cursor
 *                          AND ingested_at <= now − lag      new usage, in order
 *        │
 *   billed_usage_event (key)                                 skip anything already charged
 *        │
 *   usage_sync_batch (pending) + keys, one transaction       the capture, recorded before it is sent
 *        │
 *   Chargebee capture, id = batch id, looked up first        the charge
 *        │
 *   ledger + batch captured + cursor advance, one txn        only now does the cursor move
 *
 * The invariants, and what holds each:
 *
 *   - Nothing charged twice. Every usage event has a deterministic key
 *     (TraceId:SpanId), recorded against its capture BEFORE the capture is
 *     sent; a key is a primary key, so a range read twice — after a crash, a
 *     timeout, or by a second worker — finds it and skips. The capture id is
 *     the batch id, looked up in Chargebee before any send.
 *   - Nothing skipped. The cursor is a position in ingestion order, which only
 *     moves forward, and it advances only in the transaction that settles the
 *     capture covering everything before it. Ties on ingested_at are broken by
 *     the key, so events sharing an instant are never skipped.
 *   - An unknown outcome blocks progress. A pending capture is resolved first,
 *     every tick, before anything new is read.
 *   - One worker per tenant. A lease on the cursor row; see acquire().
 *   - A re-inserted span is never charged twice. A copy that lands again in
 *     span_nodes (a collector re-send, or a platform rebuild of the table)
 *     gets a NEW ingested_at, after the cursor. Within the key horizon its key
 *     skips it; beyond it, the read floor (Timestamp >= cursor − horizon) never
 *     reads it — and a key is pruned only once below that floor (retention.ts).
 *
 * A tenant hours behind (worker down) catches up in one tick, a page of up to
 * maxEventsPerCapture events per capture, up to maxCapturesPerTick captures.
 */

import {
  CAPTURE_INSUFFICIENT,
  CAPTURE_NO_LEDGER,
  CAPTURE_OK,
  CAPTURE_REPLAYED,
  CAPTURE_RETRYABLE,
  type CaptureArgs,
  type CaptureResult,
} from "./chargebee";
import { ACCOUNT, BATCH, ENTRY, KIND, prisma as defaultPrisma } from "./db";
import { add, decimal } from "./decimal";
import { appendEntry } from "./ledger";
import { DEFAULT_EVENT_KEY_RETENTION_MS } from "./retention";
import { isBillable, splitWholeCredits, usdToCredits } from "./rate";
import { AFTER_ALL, type UsageEvent, type UsageSource } from "./usage-events";

/** Two minutes: ClickHouse async inserts and the collector's batch settle well inside it. */
export const DEFAULT_LAG_MS = 2 * 60 * 1000;

/** Alert well before ClickHouse's 90-day TTL turns unbilled usage into lost usage. */
export const DEFAULT_BEHIND_MS = 7 * 24 * 60 * 60 * 1000;

/** What one tenant's run did. Also the workflow's output shape. */
export const OUTCOME = {
  IDLE: "idle", // nothing new — cursor moved to safe_until, no billing operation
  CAPTURED: "captured",
  REPLAYED: "replayed", // our id was already used; money already moved
  PENDING: "pending", // unknown outcome, resolved first next tick
  FAILED: "failed", // Chargebee refused (insufficient credits, or needs a human)
  HELD: "held", // a failed capture holds billing, or the tenant awaits cutover
  LOCKED: "locked", // another worker holds this tenant
  NOT_BILLABLE: "not_billable", // no subscription, cancelled, or no prepaid ledger
} as const;

export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

export interface TenantResult {
  tenantSlug: string;
  outcome: Outcome;
  reason?: string;
  captures?: number;
  events?: number;
  consumeCredits?: string;
  billedUsd?: string;
  balanceAfter?: string | null;
  attempts?: number;
  error?: string;
}

export interface Logger {
  log?(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
  error?(obj: unknown, msg?: string): void;
}

export interface UsageSyncDeps {
  prisma?: typeof defaultPrisma;
  usage: UsageSource;
  chargebee: { captureIdempotent(args: CaptureArgs): Promise<CaptureResult> };
  usdPerCredit: string;
  wholeCreditsOnly?: boolean;
  /** Only usage ingested at least this long ago is read. */
  lagMs?: number;
  maxEventsPerCapture?: number;
  maxCapturesPerTick?: number;
  /** Unknown capture outcomes past this many attempts log as errors (the batch stays pending). */
  maxAttempts?: number;
  /**
   * The key horizon: spans that started more than this far behind the cursor
   * are never read. MUST equal the retention pruneBilledEventKeys() is given.
   */
  eventKeyRetentionMs?: number;
  /** How long a tenant lease lasts; renewed per capture. */
  leaseMs?: number;
  clock?: () => number;
  logger?: Logger;
  hatchetRunId?: string;
  /** Identifies this worker in the tenant lease. */
  workerId?: string;
  /** Blocks the tenant's LiteLLM team once its Chargebee credits are used up (gateway.ts). */
  blockBudget?: (tenantId: string, reason?: "exhausted") => Promise<void>;
}

interface Position {
  at: number;
  id: string;
}

type Account = NonNullable<Awaited<ReturnType<typeof defaultPrisma.billingAccount.findUnique>>>;
type Batch = NonNullable<Awaited<ReturnType<typeof defaultPrisma.usageSyncBatch.findFirst>>>;

export function createUsageSync(deps: UsageSyncDeps) {
  const prisma = deps.prisma ?? defaultPrisma;
  const lagMs = deps.lagMs ?? DEFAULT_LAG_MS;
  const maxEvents = deps.maxEventsPerCapture ?? 5000;
  const maxCaptures = deps.maxCapturesPerTick ?? 20;
  const maxAttempts = deps.maxAttempts ?? 10;
  const leaseMs = deps.leaseMs ?? 5 * 60 * 1000;
  const keyHorizonMs = deps.eventKeyRetentionMs ?? DEFAULT_EVENT_KEY_RETENTION_MS;
  const clock = deps.clock ?? (() => Date.now());
  const log = deps.logger ?? console;
  const workerId = deps.workerId ?? `${deps.hatchetRunId ?? "worker"}:${Math.random().toString(36).slice(2, 10)}`;

  async function runTenant(tenantSlug: string): Promise<TenantResult> {
    const account = await prisma.billingAccount.findUnique({ where: { routingSlug: tenantSlug } });
    if (!account) return { tenantSlug, outcome: OUTCOME.NOT_BILLABLE, reason: "no billing account" };
    if (!account.chargebeeSubscriptionId || !account.ledgerUnitId) {
      return { tenantSlug, outcome: OUTCOME.NOT_BILLABLE, reason: "no subscription linked" };
    }

    const lease = await acquire(account);
    if (lease === "locked") return { tenantSlug, outcome: OUTCOME.LOCKED };
    if (lease === "needs_cutover") {
      log.error?.(
        { metric: "billing.sync.needs_cutover", tenantSlug },
        "Tenant has window-era billing history but no cursor; run scripts/cutover-billing-cursor.ts",
      );
      return { tenantSlug, outcome: OUTCOME.HELD, reason: "awaiting cursor cutover" };
    }

    try {
      return await processTenant(account, lease);
    } finally {
      await release(account.tenantId);
    }
  }

  async function processTenant(account: Account, start: Position): Promise<TenantResult> {
    const tenantSlug = account.routingSlug;
    let cursor = start;
    let captures = 0;
    let eventsBilled = 0;
    /** The most telling outcome of the run, for the result. */
    let last = null as TenantResult | null;
    const record = (result: TenantResult, events: number) => {
      if (result.outcome === OUTCOME.CAPTURED || result.outcome === OUTCOME.REPLAYED) {
        captures += 1;
        eventsBilled += events;
        last = result;
      } else if (result.outcome !== OUTCOME.IDLE) {
        last ??= result;
      }
    };

    // 1. An unknown outcome first. Nothing new is read until it is resolved.
    const pending = await prisma.usageSyncBatch.findFirst({
      where: { tenantId: account.tenantId, status: BATCH.PENDING },
    });
    if (pending) {
      const settled = await settle(pending, account);
      if (!isResolved(settled)) return settled;
      record(settled, Number(pending.spanCount));
      cursor = (await readCursor(account.tenantId)) ?? cursor;
    }

    // 2. A failed capture holds billing for this tenant: insufficient credits
    //    until a top-up requeues it, anything else until a human does.
    const failed = await prisma.usageSyncBatch.findFirst({
      where: { tenantId: account.tenantId, status: BATCH.FAILED },
    });
    if (failed) {
      log.warn?.(
        { metric: "billing.sync.held", tenantSlug, batchId: failed.id, reason: failed.lastError },
        "Billing held behind a failed capture",
      );
      return { tenantSlug, outcome: OUTCOME.HELD, reason: failed.lastError ?? "failed capture" };
    }

    // Usage after cancellation is not ours to charge. Pending captures (above)
    // still settle.
    if (account.status === ACCOUNT.CANCELLED) {
      return { tenantSlug, outcome: OUTCOME.NOT_BILLABLE, reason: "subscription cancelled", captures };
    }

    // 3. Read new usage up to safe_until, one capture per page.
    const now = await deps.usage.now();
    const safeUntil = now - lagMs;
    if (now - cursor.at > DEFAULT_BEHIND_MS) {
      // An error line, not a warning: tenant tables drop data after 90 days.
      log.error?.(
        { metric: "billing.sync.behind", tenantSlug, cursor: new Date(cursor.at).toISOString() },
        "Billing cursor is more than 7 days behind; usage may age out of ClickHouse",
      );
    }

    for (let page = 0; page < maxCaptures; page += 1) {
      if (cursor.at > safeUntil || (cursor.at === safeUntil && cursor.id === AFTER_ALL)) break;

      const events = await deps.usage.readEvents(tenantSlug, {
        afterMs: cursor.at,
        afterKey: cursor.id,
        untilMs: safeUntil,
        // The floor trails the cursor, not the clock: a stalled tenant still
        // bills everything after its cursor when the hold lifts.
        minTimestampMs: Math.max(account.syncFrom.getTime(), cursor.at - keyHorizonMs),
        limit: maxEvents,
      });
      const full = events.length === maxEvents;
      // A short page means everything up to safe_until has been read.
      const to: Position = full
        ? { at: events[events.length - 1]!.ingestedAtMs, id: events[events.length - 1]!.key }
        : { at: safeUntil, id: AFTER_ALL };

      const fresh = await unbilled(account.tenantId, events);

      if (fresh.length === 0) {
        // Empty, or every event already charged (a re-read, or a re-sent span):
        // no billing operation, just move on.
        await advanceCursor(prisma, account.tenantId, to);
        cursor = to;
        if (!full) break;
        continue;
      }

      await renewLease(account.tenantId);
      const result = await captureEvents(account, fresh, cursor, to);
      if (!isResolved(result)) return { ...result, captures, events: eventsBilled };
      record(result, fresh.length);
      cursor = to;
      if (!full) break;
    }

    return last ? { ...last, captures, events: eventsBilled } : { tenantSlug, outcome: OUTCOME.IDLE };
  }

  /** Events whose key is not yet recorded against any capture. */
  async function unbilled(tenantId: string, events: UsageEvent[]): Promise<UsageEvent[]> {
    if (events.length === 0) return [];
    const seen = await prisma.billedUsageEvent.findMany({
      where: { tenantId, eventKey: { in: events.map((e) => e.key) } },
      select: { eventKey: true },
    });
    const billed = new Set(seen.map((s) => s.eventKey));
    // A page can carry the same key twice only if ClickHouse returned both
    // copies of a re-sent span before merging; charge it once.
    const unique = new Map<string, UsageEvent>();
    for (const e of events) if (!billed.has(e.key) && !unique.has(e.key)) unique.set(e.key, e);
    return [...unique.values()];
  }

  /**
   * Record the capture and its events, then send it.
   *
   * The batch and every event key are written in ONE transaction before
   * Chargebee is called. After that, whatever happens — timeout, crash, a
   * second worker — the events belong to this capture and to no other, and the
   * capture id is fixed.
   */
  async function captureEvents(account: Account, events: UsageEvent[], from: Position, to: Position): Promise<TenantResult> {
    const billedUsd = add(...events.map((e) => decimal(e.billedUsd)));
    const providerUsd = add(...events.map((e) => decimal(e.providerUsd)));
    const marginUsd = add(...events.map((e) => decimal(e.marginUsd)));
    const gross = usdToCredits(billedUsd, deps.usdPerCredit);

    // Any fraction the previous capture could not take rides along with this
    // one, so repeated small amounts are not each rounded away to nothing.
    const carried = deps.wholeCreditsOnly ? await lastResidual(account.tenantId) : "0";
    const { capture: consumeCredits } = deps.wholeCreditsOnly
      ? splitWholeCredits(add(gross, carried))
      : { capture: gross };

    // Zero-cost events never reach Chargebee — it rejects a zero amount — but
    // they are still recorded so the cursor can move past them.
    const billable = isBillable(consumeCredits);

    const batch = await prisma.$transaction(async (tx) => {
      const created = await tx.usageSyncBatch.create({
        data: {
          tenantId: account.tenantId,
          chargebeeSubscriptionId: account.chargebeeSubscriptionId,
          ledgerUnitId: account.ledgerUnitId,
          kind: KIND.WINDOW,
          windowStart: new Date(from.at),
          windowEnd: new Date(to.at),
          cursorToAt: new Date(to.at),
          cursorToEventId: to.id,
          spanCount: BigInt(events.length),
          billedUsd,
          providerUsd,
          marginUsd,
          consumeCredits,
          status: billable ? BATCH.PENDING : BATCH.SKIPPED,
          lastError: billable ? null : "no billable amount (below one credit, carried forward)",
          hatchetRunId: deps.hatchetRunId ?? null,
        },
      });
      await tx.billedUsageEvent.createMany({
        data: events.map((e) => ({
          tenantId: account.tenantId,
          eventKey: e.key,
          batchId: created.id,
          ingestedAt: new Date(e.ingestedAtMs),
        })),
      });
      if (!billable) await advanceCursor(tx as never, account.tenantId, to);
      return created;
    });

    if (!billable) {
      return { tenantSlug: account.routingSlug, outcome: OUTCOME.IDLE, reason: "no billable amount", events: events.length };
    }
    return settle(batch, account);
  }

  /**
   * Send the capture for a batch and record what came back.
   *
   * Reached both by a fresh batch and by the recovery path, with identical
   * behaviour — which is the point. A replay is not a special case; it is the
   * same call with the same id. The cursor moves in the SAME transaction that
   * records the charge: never before it, never without it.
   */
  async function settle(batch: Batch, account: Account): Promise<TenantResult> {
    const tenantSlug = account.routingSlug;
    const consumeCredits = decimal(String(batch.consumeCredits));
    const billedUsd = decimal(String(batch.billedUsd));
    const to: Position | null = batch.cursorToAt
      ? { at: batch.cursorToAt.getTime(), id: batch.cursorToEventId ?? AFTER_ALL }
      : null; // a window-era capture: nothing of the cursor's to move

    const result = await deps.chargebee.captureIdempotent({
      id: batch.id,
      subscriptionId: batch.chargebeeSubscriptionId!,
      unitId: batch.ledgerUnitId!,
      amount: consumeCredits,
      metadata: {
        tenant_slug: tenantSlug,
        ingested_from: batch.windowStart.toISOString(),
        ingested_to: batch.windowEnd.toISOString(),
        span_count: Number(batch.spanCount),
        billed_usd: billedUsd,
      },
      now: clock(),
    });

    if (result.kind === CAPTURE_OK || result.kind === CAPTURE_REPLAYED) {
      // Ledger entry, batch status and cursor commit together. A crash between
      // them would otherwise leave a charge with no audit row, or a cursor past
      // usage that was never charged.
      await prisma.$transaction(async (tx) => {
        await appendEntry(
          {
            tenantId: batch.tenantId,
            entryType: ENTRY.CONSUME,
            deltaCredits: `-${consumeCredits}`,
            sourceRef: batch.id, // the batch UUID — replay-safe by unique index
            billedUsd,
            chargebeeOperationId: result.operationId ?? null,
            occurredAt: batch.windowEnd,
          },
          tx as never,
        );

        await tx.usageSyncBatch.update({
          where: { id: batch.id },
          data: {
            status: BATCH.CAPTURED,
            chargebeeOperationId: result.operationId ?? null,
            balanceAfter: result.balanceAfter ?? null,
            capturedAt: new Date(clock()),
            lastError: null,
          },
        });

        if (result.balanceAfter != null) {
          await tx.billingAccount.update({
            where: { tenantId: batch.tenantId },
            data: {
              cachedBalanceCredits: result.balanceAfter,
              cachedBalanceAt: new Date(clock()),
              ...(isBillable(result.balanceAfter) ? {} : { status: ACCOUNT.EXHAUSTED }),
            },
          });
        }

        if (to) await advanceCursor(tx as never, batch.tenantId, to);
      });

      // The LiteLLM cap normally stops spend first, but it counts only what
      // reaches the team; Chargebee is what the customer actually bought. Once
      // that is gone, nothing more runs until a top-up or renewal.
      if (result.balanceAfter != null && !isBillable(result.balanceAfter)) {
        await blockExhausted(batch.tenantId, tenantSlug);
      }

      return {
        tenantSlug,
        outcome: result.kind === CAPTURE_OK ? OUTCOME.CAPTURED : OUTCOME.REPLAYED,
        consumeCredits,
        billedUsd,
        balanceAfter: result.balanceAfter ?? null,
      };
    }

    if (result.kind === CAPTURE_RETRYABLE) {
      // THE critical branch. We do not know whether the charge landed, so the
      // batch stays pending and the cursor does not move. The next tick looks
      // the id up in Chargebee: found settles it, not found re-sends it.
      //
      // An unknown is never turned into `failed` by counting: only Chargebee
      // can resolve it. A long outage stays pending and gets louder instead.
      const updated = await prisma.usageSyncBatch.update({
        where: { id: batch.id },
        data: { attempts: { increment: 1 }, lastError: result.error?.message ?? null },
      });
      if (updated.attempts >= maxAttempts) {
        log.error?.(
          { metric: "billing.sync.stuck", tenantSlug, batchId: batch.id, attempts: updated.attempts },
          "Capture outcome still unknown; batch stays pending until Chargebee answers",
        );
      } else {
        log.warn?.(
          { metric: "billing.sync.retryable", tenantSlug, batchId: batch.id, attempts: updated.attempts },
          "Capture outcome unknown; batch stays pending for replay",
        );
      }
      return { tenantSlug, outcome: OUTCOME.PENDING, attempts: updated.attempts };
    }

    if (result.kind === CAPTURE_INSUFFICIENT) {
      // Out of credits. The usage is NOT discarded: the capture stays recorded
      // (failed), billing holds behind it, and a top-up or renewal reopens it
      // (account.ts requeueHeldUsage — the lastError prefix is what finds it).
      //
      // Reaching this at all means the gateway budget and the grant drifted:
      // enforcement should have stopped the traffic before it was incurred.
      await prisma.usageSyncBatch.update({
        where: { id: batch.id },
        data: { status: BATCH.FAILED, lastError: `insufficient credits: ${result.error?.message}` },
      });
      await prisma.billingAccount.update({
        where: { tenantId: batch.tenantId },
        data: { status: ACCOUNT.EXHAUSTED },
      });
      log.error?.(
        { metric: "billing.sync.insufficient_credits", tenantSlug, batchId: batch.id, credits: consumeCredits },
        "Customer is out of credits; usage retained and billing held until topped up",
      );
      await blockExhausted(batch.tenantId, tenantSlug);
      return { tenantSlug, outcome: OUTCOME.FAILED, reason: "insufficient credits" };
    }

    if (result.kind === CAPTURE_NO_LEDGER) {
      // Nothing was charged and nothing will be, so the cursor may move past it.
      // Loud, though: a subscription serving traffic with no prepaid ledger is
      // a misconfiguration that is costing real provider money.
      await prisma.$transaction(async (tx) => {
        await tx.usageSyncBatch.update({
          where: { id: batch.id },
          data: { status: BATCH.SKIPPED, lastError: `no prepaid ledger: ${result.error?.message}` },
        });
        if (to) await advanceCursor(tx as never, batch.tenantId, to);
      });
      log.error?.(
        { metric: "billing.sync.no_ledger", tenantSlug, batchId: batch.id },
        "Subscription has no prepaid ledger; this usage will not be billed",
      );
      return { tenantSlug, outcome: OUTCOME.NOT_BILLABLE, reason: "no prepaid ledger" };
    }

    await prisma.usageSyncBatch.update({
      where: { id: batch.id },
      data: { status: BATCH.FAILED, lastError: result.error?.message ?? "unknown capture failure" },
    });
    log.error?.(
      { metric: "billing.sync.failed", tenantSlug, batchId: batch.id, err: result.error?.message },
      "Capture failed terminally; billing held pending investigation",
    );
    return { tenantSlug, outcome: OUTCOME.FAILED, error: result.error?.message };
  }

  function isResolved(r: TenantResult): boolean {
    return (
      r.outcome === OUTCOME.CAPTURED ||
      r.outcome === OUTCOME.REPLAYED ||
      r.outcome === OUTCOME.IDLE ||
      (r.outcome === OUTCOME.NOT_BILLABLE && r.reason === "no prepaid ledger")
    );
  }

  /**
   * Forward only: a replayed or requeued capture from further back must not
   * pull the cursor backwards over usage that has since been billed.
   */
  async function advanceCursor(client: typeof defaultPrisma, tenantId: string, to: Position) {
    await client.billingCursor.updateMany({
      where: {
        tenantId,
        OR: [
          { lastProcessedAt: { lt: new Date(to.at) } },
          { lastProcessedAt: new Date(to.at), lastEventId: { lt: to.id } },
        ],
      },
      data: { lastProcessedAt: new Date(to.at), lastEventId: to.id },
    });
  }

  async function readCursor(tenantId: string): Promise<Position | null> {
    const row = await prisma.billingCursor.findUnique({ where: { tenantId } });
    return row ? { at: row.lastProcessedAt.getTime(), id: row.lastEventId } : null;
  }

  /**
   * Take the tenant lease; return the cursor, or why not.
   *
   * A lease rather than a lock: billing reaches Postgres through PgBouncer in
   * transaction mode, where a session advisory lock is not reliably held, and
   * SELECT … FOR UPDATE would keep a transaction open across the Chargebee
   * call. The UPDATE's WHERE is re-checked under the row lock, so of two
   * workers racing for an expired lease exactly one gets it. A crashed
   * worker's lease simply expires.
   *
   * A missing cursor is created at sync_from — but only for a tenant with no
   * billing history. One billed by the window era must be cut over first
   * (scripts/cutover-billing-cursor.ts), or everything it already paid for
   * would be read and charged again.
   */
  async function acquire(account: Account): Promise<Position | "locked" | "needs_cutover"> {
    if (!(await prisma.billingCursor.findUnique({ where: { tenantId: account.tenantId } }))) {
      const history = await prisma.usageSyncBatch.findFirst({
        where: { tenantId: account.tenantId, cursorToAt: null },
        select: { id: true },
      });
      if (history) return "needs_cutover";
      await prisma.billingCursor
        .create({ data: { tenantId: account.tenantId, lastProcessedAt: account.syncFrom, lastEventId: "" } })
        .catch((err: { code?: string }) => {
          if (err?.code !== "P2002") throw err; // another worker created it first — same row either way
        });
    }

    const now = new Date(clock());
    const { count } = await prisma.billingCursor.updateMany({
      where: { tenantId: account.tenantId, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
      data: { lockedUntil: new Date(now.getTime() + leaseMs), lockedBy: workerId },
    });
    if (count === 0) return "locked";
    return (await readCursor(account.tenantId))!;
  }

  async function renewLease(tenantId: string) {
    await prisma.billingCursor.updateMany({
      where: { tenantId, lockedBy: workerId },
      data: { lockedUntil: new Date(clock() + leaseMs) },
    });
  }

  async function release(tenantId: string) {
    await prisma.billingCursor.updateMany({
      where: { tenantId, lockedBy: workerId },
      data: { lockedUntil: null, lockedBy: null },
    });
  }

  async function lastResidual(tenantId: string): Promise<string> {
    const row = await prisma.usageSyncBatch.findFirst({
      where: { tenantId, status: { in: [BATCH.CAPTURED, BATCH.SKIPPED] } },
      orderBy: { windowEnd: "desc" },
      select: { consumeCredits: true, billedUsd: true },
    });
    if (!row) return "0";
    // Whatever the gross conversion produced minus what was actually captured.
    const gross = usdToCredits(String(row.billedUsd), deps.usdPerCredit);
    return decimal(Number(gross) - Number(row.consumeCredits));
  }

  /**
   * Chargebee says the credits are gone: block the tenant's LiteLLM team so no
   * more usage accrues. Best effort — a failed block is loud, and the next
   * capture that finds the balance empty tries again.
   */
  async function blockExhausted(tenantId: string, tenantSlug: string) {
    if (!deps.blockBudget) return;
    try {
      await deps.blockBudget(tenantId, "exhausted");
      log.warn?.({ metric: "billing.budget.exhausted_blocked", tenantSlug }, "Credits used up; LiteLLM team blocked until a top-up");
    } catch (err) {
      log.error?.(
        { metric: "billing.budget.block_failed", tenantSlug, reason: "exhausted", err: (err as Error).message },
        "Credits used up but the LiteLLM team could not be blocked",
      );
    }
  }

  /**
   * One pass across every billable tenant. Per-tenant failures are caught and
   * counted, never allowed to abort the pass — one broken subscription must not
   * stop everyone else's billing.
   */
  async function runOnce(slugs?: string[]) {
    // Plus any tenant with a capture pending, whatever its status now: an
    // unknown outcome must be resolved even after the account cancelled or
    // went activating, or a charge that landed never reaches the ledger.
    const unresolved = slugs?.length
      ? []
      : (await prisma.usageSyncBatch.findMany({ where: { status: BATCH.PENDING }, select: { tenantId: true } })).map((b) => b.tenantId);
    const accounts = slugs?.length
      ? await prisma.billingAccount.findMany({ where: { routingSlug: { in: slugs } } })
      : await prisma.billingAccount.findMany({
          where: {
            OR: [
              { status: { in: [ACCOUNT.ACTIVE, ACCOUNT.EXHAUSTED] }, chargebeeSubscriptionId: { not: null } },
              { tenantId: { in: unresolved } },
            ],
          },
        });

    const results: TenantResult[] = [];
    const errors: Array<{ tenantSlug: string; error: string }> = [];

    for (const account of accounts) {
      try {
        results.push(await runTenant(account.routingSlug));
      } catch (err) {
        errors.push({ tenantSlug: account.routingSlug, error: (err as Error).message });
        log.error?.(
          { metric: "billing.sync.tenant_error", tenantSlug: account.routingSlug, err: (err as Error).message },
          "Usage sync failed for tenant; cursor unchanged, continuing",
        );
      }
    }

    const count = (outcome: Outcome) => results.filter((r) => r.outcome === outcome).length;
    const summary = {
      tenantsScanned: accounts.length,
      captured: count(OUTCOME.CAPTURED),
      replayed: count(OUTCOME.REPLAYED),
      idle: count(OUTCOME.IDLE),
      pending: count(OUTCOME.PENDING),
      failed: count(OUTCOME.FAILED),
      held: count(OUTCOME.HELD),
      locked: count(OUTCOME.LOCKED),
      errors,
      results,
    };
    log.log?.({ metric: "billing.sync.pass", ...summary, results: undefined }, "Usage sync pass complete");
    return summary;
  }

  return { runOnce, runTenant };
}
