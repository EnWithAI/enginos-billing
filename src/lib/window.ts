/**
 * Billing window arithmetic.
 *
 * Reading usage from an analytics store means we cannot mark a row as billed,
 * so the unit of work is a half-open interval `[start, end)` instead. Two
 * properties make that safe, and both are enforced here rather than assumed:
 *
 *   contiguous  each window starts exactly where the last ended, so no span
 *               falls between two windows and goes unbilled
 *   half-open   the shared boundary instant belongs to the later window only,
 *               so no span is billed twice
 *
 * Everything is milliseconds since epoch. Dates go in and out at the edges; the
 * arithmetic stays integral so a DST-shifted local time cannot move a boundary.
 */

export interface Window {
  start: number;
  end: number;
}

/**
 * How long to wait before treating a window as closed.
 *
 * Spans do not arrive instantly: the collector batches for 5 seconds, then
 * ClickHouse flushes its async insert, and if the exporter's sending queue is
 * backed up the tail is unbounded. Two minutes covers the normal case; the
 * unbounded tail is covered by the late-arrival sweep, not by this number —
 * raising it would only delay revenue without closing the hole.
 */
export const DEFAULT_LAG_MS = 2 * 60 * 1000;

/**
 * Longest interval a single window may cover.
 *
 * Without a cap, a tenant whose sync stopped for a week returns as one enormous
 * window: a slow ClickHouse scan and a single capture impossible to reconcile
 * against anything. Capped, the backlog is worked off in independently
 * auditable pieces.
 */
export const DEFAULT_MAX_SPAN_MS = 60 * 60 * 1000;

/** Alert well before ClickHouse's 90-day TTL turns unbilled usage into lost usage. */
export const DEFAULT_BEHIND_MS = 7 * 24 * 60 * 60 * 1000;

export interface NextWindowArgs {
  lastWindowEnd?: number | null;
  syncFrom: number;
  now: number;
  lagMs?: number;
  maxSpanMs?: number;
}

/**
 * The next window to bill, or null when nothing has closed yet.
 *
 * Returning null is the normal steady state on a fast cron — the previous
 * window is billed and the next has not aged past the lag buffer. It is not an
 * error and must not be logged as one.
 */
export function nextWindow({
  lastWindowEnd,
  syncFrom,
  now,
  lagMs = DEFAULT_LAG_MS,
  maxSpanMs = DEFAULT_MAX_SPAN_MS,
}: NextWindowArgs): Window | null {
  if (!Number.isFinite(syncFrom)) throw new TypeError("syncFrom must be a timestamp");
  if (!Number.isFinite(now)) throw new TypeError("now must be a timestamp");

  // A cursor behind syncFrom would re-bill history the account was never meant
  // to cover — clamp rather than trust it.
  const start = Math.max(lastWindowEnd ?? syncFrom, syncFrom);
  const cutoff = now - lagMs;

  if (cutoff <= start) return null;

  return { start, end: Math.min(cutoff, start + maxSpanMs) };
}

/** Has the sync fallen far enough behind that usage is at risk of ageing out? */
export function isFallingBehind(
  lastWindowEnd: number | null | undefined,
  now: number,
  thresholdMs: number = DEFAULT_BEHIND_MS,
): boolean {
  if (lastWindowEnd == null) return false;
  return now - lastWindowEnd > thresholdMs;
}

/**
 * Check a tenant's billed windows form an unbroken chain from `syncFrom`.
 *
 * Cheap enough to run on every tick, and it catches most classes of bug this
 * design can have: a dropped window, a replayed one, a cursor rewound by a bad
 * migration. Returns every problem rather than the first, so one run shows the
 * whole picture.
 */
export function findWindowGaps(windows: Window[], syncFrom: number): string[] {
  const problems: string[] = [];
  const ordered = [...windows].sort((a, b) => a.start - b.start);

  for (const [index, window] of ordered.entries()) {
    if (window.end <= window.start) {
      problems.push(`window at ${iso(window.start)} ends before it starts`);
      continue;
    }

    const previous = ordered[index - 1];
    if (!previous) {
      if (window.start !== syncFrom) {
        problems.push(`first window starts at ${iso(window.start)}, expected ${iso(syncFrom)}`);
      }
      continue;
    }

    if (window.start > previous.end) {
      problems.push(`gap between ${iso(previous.end)} and ${iso(window.start)}`);
    } else if (window.start < previous.end) {
      problems.push(`overlap between ${iso(previous.end)} and ${iso(window.start)}`);
    }
  }

  return problems;
}

/** ClickHouse wants `YYYY-MM-DD HH:MM:SS.sss`, not an ISO `T`/`Z` string. */
export function toClickHouseTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
