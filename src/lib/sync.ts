/**
 * The sync loop: ClickHouse spend becomes a Chargebee credit drawdown.
 *
 * Order of operations, and why it is this order:
 *
 *   0  recover   a pending batch is replayed with ITS id before anything new is
 *                opened, because its outcome is unknown and opening a second
 *                batch would charge the same money twice
 *   1  read      ClickHouse, for one closed window — no side effects, so losing
 *                the race at step 2 costs only a wasted query
 *   2  open      insert the batch; the unique index IS the lock, so a concurrent
 *                run fails here rather than charging
 *   3  capture   exactly one call, carrying the batch id
 *   4  settle    ledger entry and batch status in ONE transaction
 *
 * The invariant worth holding on to: after any crash, at any point, the window
 * is either fully billed or not billed at all. There is no state in which part
 * of a window has been charged.
 *
 * Every dependency is injected. That is not ceremony — it is what lets the
 * idempotency scenarios run as ordinary unit tests with a fake Chargebee that
 * fails exactly when it matters.
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
import { ACCOUNT, BATCH, ENTRY, KIND, isUniqueViolation, prisma as defaultPrisma } from "./db";
import { appendEntry } from "./ledger";
import { add, decimal } from "./decimal";
import { isBillable, splitWholeCredits, usdToCredits } from "./rate";
import {
  DEFAULT_LAG_MS,
  DEFAULT_MAX_SPAN_MS,
  isFallingBehind,
  nextWindow,
  type Window,
} from "./window";
import type { WindowUsage } from "./clickhouse";

/** What one tenant's run did. Also the workflow's output shape. */
export const OUTCOME = {
  IDLE: "idle", // no closed window yet — the steady state
  SKIPPED: "skipped", // window had no billable spend
  CAPTURED: "captured",
  REPLAYED: "replayed", // our id was already used; money already moved
  PENDING: "pending", // unknown outcome, will replay next tick
  FAILED: "failed", // needs a human
  NOT_BILLABLE: "not_billable", // no subscription, or no prepaid ledger
  CONTENDED: "contended", // another run holds this window
} as const;

export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

export interface TenantResult {
  tenantSlug: string;
  outcome: Outcome;
  window?: Window;
  reason?: string;
  spans?: number;
  billedUsd?: string;
  consumeCredits?: string;
  balanceAfter?: string | null;
  attempts?: number;
  error?: string;
}

export interface Logger {
  log?(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
  error?(obj: unknown, msg?: string): void;
}

export interface SyncDeps {
  prisma?: typeof defaultPrisma;
  usage: { readWindow(slug: string, window: Window): Promise<WindowUsage> };
  chargebee: { captureIdempotent(args: CaptureArgs): Promise<CaptureResult> };
  usdPerCredit: string;
  wholeCreditsOnly?: boolean;
  lagMs?: number;
  maxWindowMs?: number;
  maxAttempts?: number;
  clock?: () => number;
  logger?: Logger;
  hatchetRunId?: string;
}

export function createSync(deps: SyncDeps) {
  const prisma = deps.prisma ?? defaultPrisma;
  const lagMs = deps.lagMs ?? DEFAULT_LAG_MS;
  const maxWindowMs = deps.maxWindowMs ?? DEFAULT_MAX_SPAN_MS;
  const maxAttempts = deps.maxAttempts ?? 10;
  const clock = deps.clock ?? (() => Date.now());
  const log = deps.logger ?? console;

  /**
   * Advance one tenant by at most one window.
   *
   * Deliberately one window per call, not a drain loop: a tenant hours behind
   * must not monopolise the tick, and each window is an independent, auditable
   * charge. The cron catches up over successive ticks.
   */
  async function runTenant(tenantSlug: string): Promise<TenantResult> {
    const account = await prisma.billingAccount.findUnique({ where: { routingSlug: tenantSlug } });

    if (!account) {
      return { tenantSlug, outcome: OUTCOME.NOT_BILLABLE, reason: "no billing account" };
    }
    if (!account.chargebeeSubscriptionId || !account.ledgerUnitId) {
      return { tenantSlug, outcome: OUTCOME.NOT_BILLABLE, reason: "no subscription linked" };
    }

    // Recovery first. A pending batch's outcome is unknown, so nothing new may
    // be opened until it settles.
    const pending = await prisma.usageSyncBatch.findFirst({
      where: { tenantId: account.tenantId, status: BATCH.PENDING },
    });
    if (pending) return settle(pending, account);

    // A cancelled account still drains what is pending (handled above) but stops
    // opening windows. Usage after cancellation is not ours to charge.
    if (account.status === ACCOUNT.CANCELLED) {
      return { tenantSlug, outcome: OUTCOME.NOT_BILLABLE, reason: "subscription cancelled" };
    }

    const now = clock();
    const cursor = await lastWindowEnd(account.tenantId);

    if (isFallingBehind(cursor, now)) {
      // An error line, not a warning: ClickHouse tenant tables drop data after
      // 90 days, so unbilled usage here is on a clock toward gone.
      log.error?.(
        { metric: "billing.sync.behind", tenantSlug, cursor, now },
        "Billing cursor is more than 7 days behind; usage may age out of ClickHouse",
      );
    }

    const window = nextWindow({
      lastWindowEnd: cursor,
      syncFrom: account.syncFrom.getTime(),
      now,
      lagMs,
      maxSpanMs: maxWindowMs,
    });

    if (!window) return { tenantSlug, outcome: OUTCOME.IDLE };

    // Read before locking. A ClickHouse failure here leaves nothing behind — no
    // batch, no cursor movement — so the next tick simply retries.
    const totals = await deps.usage.readWindow(tenantSlug, window);
    const gross = usdToCredits(totals.billedUsd, deps.usdPerCredit);

    // Any fraction the previous window could not capture rides along with this
    // one, so repeated small windows are not each rounded away to nothing.
    const carried = deps.wholeCreditsOnly ? await lastResidual(account.tenantId) : "0";
    const { capture: consumeCredits } = deps.wholeCreditsOnly
      ? splitWholeCredits(add(gross, carried))
      : { capture: gross };

    let batch;
    try {
      batch = await prisma.usageSyncBatch.create({
        data: {
          tenantId: account.tenantId,
          chargebeeSubscriptionId: account.chargebeeSubscriptionId,
          ledgerUnitId: account.ledgerUnitId,
          kind: KIND.WINDOW,
          windowStart: new Date(window.start),
          windowEnd: new Date(window.end),
          spanCount: BigInt(totals.spans),
          billedUsd: totals.billedUsd,
          providerUsd: totals.providerUsd,
          marginUsd: totals.marginUsd,
          consumeCredits,
          status: BATCH.PENDING,
          hatchetRunId: deps.hatchetRunId ?? null,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Either this window is already billed, or another run holds a capture
        // for this tenant. Both mean: do nothing, and do not charge.
        return { tenantSlug, outcome: OUTCOME.CONTENDED, window };
      }
      throw err;
    }

    // Zero-spend windows never reach Chargebee — it rejects a zero amount — but
    // the cursor must still advance or a quiet tenant wedges forever.
    if (!isBillable(consumeCredits)) {
      await prisma.usageSyncBatch.update({
        where: { id: batch.id },
        data: { status: BATCH.SKIPPED, lastError: "no billable usage in window" },
      });
      return { tenantSlug, outcome: OUTCOME.SKIPPED, window, spans: totals.spans };
    }

    return settle(batch, account);
  }

  /**
   * Send the capture for a batch and record what came back.
   *
   * Reached both by a fresh batch and by the recovery path, with identical
   * behaviour — which is the point. A replay is not a special case; it is the
   * same call with the same id.
   */
  async function settle(
    batch: { id: string; tenantId: string; windowStart: Date; windowEnd: Date; spanCount: bigint; billedUsd: unknown; consumeCredits: unknown; chargebeeSubscriptionId: string | null; ledgerUnitId: string | null; attempts: number },
    account: { routingSlug: string; status: string; tenantId: string },
  ): Promise<TenantResult> {
    const tenantSlug = account.routingSlug;
    const window = { start: batch.windowStart.getTime(), end: batch.windowEnd.getTime() };
    const consumeCredits = decimal(String(batch.consumeCredits));
    const billedUsd = decimal(String(batch.billedUsd));

    const result = await deps.chargebee.captureIdempotent({
      id: batch.id,
      subscriptionId: batch.chargebeeSubscriptionId!,
      unitId: batch.ledgerUnitId!,
      amount: consumeCredits,
      metadata: {
        tenant_slug: tenantSlug,
        window_start: batch.windowStart.toISOString(),
        window_end: batch.windowEnd.toISOString(),
        span_count: Number(batch.spanCount),
        billed_usd: billedUsd,
      },
      now: clock(),
    });

    if (result.kind === CAPTURE_OK || result.kind === CAPTURE_REPLAYED) {
      // Ledger entry and batch status commit together. A crash between them
      // would otherwise leave a charge with no audit row, or the reverse.
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
              // Display only — the gateway budget is the real gate and has
              // already stopped serving by the time this is reached.
              ...(isBillable(result.balanceAfter) ? {} : { status: ACCOUNT.EXHAUSTED }),
            },
          });
        }
      });

      return {
        tenantSlug,
        outcome: result.kind === CAPTURE_OK ? OUTCOME.CAPTURED : OUTCOME.REPLAYED,
        window,
        consumeCredits,
        billedUsd,
        balanceAfter: result.balanceAfter ?? null,
      };
    }

    if (result.kind === CAPTURE_RETRYABLE) {
      // THE critical branch. We do not know whether the charge landed, so the
      // batch stays pending and the cursor does not move. The next tick replays
      // the same id; Chargebee deduplicates if it already applied.
      const updated = await prisma.usageSyncBatch.update({
        where: { id: batch.id },
        data: { attempts: { increment: 1 }, lastError: result.error?.message ?? null },
      });

      if (updated.attempts >= maxAttempts) {
        await prisma.usageSyncBatch.update({
          where: { id: batch.id },
          data: { status: BATCH.FAILED, lastError: `gave up after ${updated.attempts} attempts` },
        });
        log.error?.(
          { metric: "billing.sync.exhausted", tenantSlug, batchId: batch.id, attempts: updated.attempts },
          "Capture never settled; cursor held pending investigation",
        );
        return { tenantSlug, outcome: OUTCOME.FAILED, window, attempts: updated.attempts };
      }

      log.warn?.(
        { metric: "billing.sync.retryable", tenantSlug, batchId: batch.id, attempts: updated.attempts },
        "Capture outcome unknown; batch stays pending for replay",
      );
      return { tenantSlug, outcome: OUTCOME.PENDING, window, attempts: updated.attempts };
    }

    if (result.kind === CAPTURE_INSUFFICIENT) {
      // The customer ran out of credits. Terminal, because a retry cannot fix
      // it — but the usage is NOT discarded: the cursor stays on this window so
      // it bills once the balance is topped up. Logged distinctly from a
      // malformed request, because the operational response is different
      // (dunning, not debugging).
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
        "Customer is out of credits; usage retained and cursor held until topped up",
      );
      return { tenantSlug, outcome: OUTCOME.FAILED, window, reason: "insufficient credits" };
    }

    if (result.kind === CAPTURE_NO_LEDGER) {
      // Nothing was charged and nothing will be, so the window may be released.
      // Loud, though: a subscription serving traffic with no prepaid ledger is
      // a misconfiguration that is costing real provider money.
      await prisma.usageSyncBatch.update({
        where: { id: batch.id },
        data: { status: BATCH.SKIPPED, lastError: `no prepaid ledger: ${result.error?.message}` },
      });
      log.error?.(
        { metric: "billing.sync.no_ledger", tenantSlug, batchId: batch.id },
        "Subscription has no prepaid ledger; usage in this window will not be billed",
      );
      return { tenantSlug, outcome: OUTCOME.NOT_BILLABLE, window, reason: "no prepaid ledger" };
    }

    await prisma.usageSyncBatch.update({
      where: { id: batch.id },
      data: { status: BATCH.FAILED, lastError: result.error?.message ?? "unknown capture failure" },
    });
    log.error?.(
      { metric: "billing.sync.failed", tenantSlug, batchId: batch.id, err: result.error?.message },
      "Capture failed terminally; cursor held pending investigation",
    );
    return { tenantSlug, outcome: OUTCOME.FAILED, window, error: result.error?.message };
  }

  /**
   * The cursor: where the next window starts.
   *
   * Only windows that reached a terminal non-failed state move it. A `failed`
   * window holds the cursor deliberately — moving past usage we could not bill
   * would lose it silently, and the 90-day ClickHouse TTL turns "later" into
   * "never".
   */
  async function lastWindowEnd(tenantId: string): Promise<number | null> {
    const row = await prisma.usageSyncBatch.aggregate({
      where: { tenantId, kind: KIND.WINDOW, status: { in: [BATCH.CAPTURED, BATCH.SKIPPED] } },
      _max: { windowEnd: true },
    });
    return row._max.windowEnd?.getTime() ?? null;
  }

  async function lastResidual(tenantId: string): Promise<string> {
    const row = await prisma.usageSyncBatch.findFirst({
      where: { tenantId, kind: KIND.WINDOW, status: { in: [BATCH.CAPTURED, BATCH.SKIPPED] } },
      orderBy: { windowEnd: "desc" },
      select: { consumeCredits: true, billedUsd: true },
    });
    if (!row) return "0";
    // The residual is whatever the gross conversion produced minus what was
    // actually captured for that window.
    const gross = usdToCredits(String(row.billedUsd), deps.usdPerCredit);
    return decimal(Number(gross) - Number(row.consumeCredits));
  }

  /**
   * One sweep across every billable tenant.
   *
   * Per-tenant failures are caught and counted, never allowed to abort the
   * sweep — one tenant with a broken subscription must not stop everyone else's
   * revenue. This mirrors `forEachActiveTenant` in enginos-platform, which
   * cannot be imported across the service boundary.
   */
  async function runOnce(slugs?: string[]) {
    const accounts = slugs?.length
      ? await prisma.billingAccount.findMany({ where: { routingSlug: { in: slugs } } })
      : await prisma.billingAccount.findMany({
          where: {
            status: { in: [ACCOUNT.ACTIVE, ACCOUNT.EXHAUSTED] },
            chargebeeSubscriptionId: { not: null },
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
          "Billing sweep failed for tenant; continuing",
        );
      }
    }

    const count = (outcome: Outcome) => results.filter((r) => r.outcome === outcome).length;

    const summary = {
      tenantsScanned: accounts.length,
      captured: count(OUTCOME.CAPTURED),
      replayed: count(OUTCOME.REPLAYED),
      skipped: count(OUTCOME.SKIPPED),
      pending: count(OUTCOME.PENDING),
      failed: count(OUTCOME.FAILED),
      errors,
      results,
    };

    log.log?.(
      { metric: "billing.sync.sweep", ...summary, results: undefined },
      "Billing sweep complete",
    );
    return summary;
  }

  return { runOnce, runTenant };
}
