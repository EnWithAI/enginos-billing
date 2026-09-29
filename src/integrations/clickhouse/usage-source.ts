/**
 * Usage for one billing window, from a tenant's ClickHouse database.
 *
 * The worker asks a single question — "what did this tenant use between these
 * two instants?" — and gets back a count and a dollar total. It does not read
 * the events themselves: nothing downstream needs them, and pulling thousands
 * of rows to add them up in JavaScript put a LIMIT on the read, which in turn
 * is what forced the cursor to carry an event id so a truncated page could be
 * resumed. Aggregating here removes all of that.
 *
 * TIME WINDOWS, AND WHY THE BOUNDARY IS SAFE
 *
 *   WHERE ingested_at > :from AND ingested_at <= :to
 *
 * Half-open, and both ends are TIMES the worker chose. `ingested_at` is
 * DateTime64(3) and several spans routinely share a millisecond, but that is
 * only a hazard when a boundary can fall INSIDE one — which is what happened
 * when the boundary was "the last event of a page". A time boundary cannot:
 * every millisecond belongs whole to exactly one window, so consecutive windows
 * lose nothing between them and overlap nowhere.
 *
 * DEDUPLICATION IS A SEPARATE JOB FROM THE CURSOR
 *
 * The window says WHICH events; `GROUP BY concat(TraceId, ':', SpanId)` says
 * which of them are the same event. That pair is the identity span_nodes itself
 * is keyed on — it is a ReplacingMergeTree ORDER BY (TraceId, SpanId) — so the
 * grouping agrees with the table rather than guessing at it.
 *
 * Grouping inside one window is not enough on its own: a span the collector
 * re-sends gets a second copy with a LATER ingested_at, possibly in a later
 * window, after the first copy's window has already been billed. What stops
 * that copy billing again is which copy FINAL keeps. Since tenant migration
 * 030 (enginos-platform, 030_span_nodes_first_copy_wins.sql) span_nodes keeps
 * the FIRST copy: its version column falls as ingested_at rises, so FINAL
 * returns each span once, at its earliest ingested_at, and a re-send's window
 * never sees it. That makes a span exactly-once across windows with no billing
 * state at all. (Before 030 the version was Timestamp, the LAST copy won, and
 * the re-send billed again: live case C12.)
 *
 * That only holds if the ingested_at filter is applied to the copy FINAL chose,
 * never to the copies before FINAL chooses. Two things would filter first, and
 * both were measured to bill the re-send again:
 *   - `use_skip_indexes_if_final_exact_mode = 0` lets the ingested_at skip index
 *     drop the granules holding the first copy, so FINAL sees only the re-send.
 *     Pinned to 1 below (the server default since 25.6, but not ours to trust;
 *     a server too old to know the setting now fails the read instead of
 *     double-billing quietly).
 *   - a PREWHERE on ingested_at, for the same reason. Keep it in WHERE.
 *
 * Why these rows and not others:
 *
 *   - `span_nodes FINAL`, not `otel_traces`: span_nodes collapses a re-sent
 *     span to one row, the first. FINAL decides WHICH window a span belongs to;
 *     the GROUP BY is what counts it once within that window, and it does not
 *     rely on FINAL having collapsed anything.
 *   - One tenant database, never merged with otel_landing: the tenant table is
 *     a copy of its slice of landing, and a union counts every span twice.
 *   - `ingested_at` (tenant migration 029), never `Timestamp`. The worker polls
 *     for usage that has BECOME AVAILABLE, not usage that happened: a span can
 *     land in ClickHouse long after the call it describes, and a cursor on span
 *     time that has already moved past it would skip it for good. There is no
 *     Timestamp predicate here at all — no billing floor, no sync_from, no
 *     lookback.
 *   - Cache hits are excluded. MEASURED: a response served from LiteLLM's Redis
 *     cache still carries the full `gen_ai.cost.total_cost` while LiteLLM
 *     records spend 0 for it. A cache hit is the span whose
 *     `hidden_params.cache_key` is set; a missing attribute bills.
 *
 * Retries are billable: LiteLLM runs num_retries: 3, a failed attempt carries
 * no cost (excluded by the empty-string check), but a fallback that succeeded
 * on a second model made a second provider call.
 */

import { createClient, type ClickHouseClient } from "@clickhouse/client";

import { getConfig } from "../../config/config";

/** The span LiteLLM emits carrying model, tokens and cost. */
export const LLM_SPAN_NAME = "litellm_request";

/** A slug becomes part of a database identifier, so it may only be these chars. */
const SAFE_SLUG = /^[a-zA-Z0-9_]+$/;

export function assertSlug(slug: string): string {
  if (!SAFE_SLUG.test(slug)) {
    throw new TypeError(`Unsafe ClickHouse tenant slug: ${JSON.stringify(slug)}`);
  }
  return slug;
}

/** What one billing window contains. */
export interface UsageWindow {
  /** Distinct TraceId:SpanId in the window — the number of billable calls. */
  eventCount: number;
  /** Their total `gen_ai.cost.total_cost`, in USD. */
  billedUsd: number;
}

export interface ReadWindowArgs {
  /** Exclusive lower bound on `ingested_at` — the cursor. */
  fromMs: number;
  /** Inclusive upper bound — the safe processing time. */
  toMs: number;
}

export interface UsageSource {
  /** ClickHouse's clock, epoch ms — ingested_at is stamped by it, so lag is measured against it. */
  now(): Promise<number>;
  readWindow(slug: string, args: ReadWindowArgs): Promise<UsageWindow>;
}

/**
 * Built here rather than inline so a test can assert its shape without a server.
 *
 * The inner query reduces the window to one row per event; the outer one counts
 * and totals those rows. Written as two levels rather than as
 * `uniqExact(...)` + `sum(...)` over the raw rows because the total has to be
 * summed over DEDUPLICATED events — summing first and counting distinctly
 * afterwards would charge twice for a span that appears twice.
 *
 * `any()` rather than `max()` on the cost: copies of one span carry the same
 * cost, and if they ever disagreed, taking the larger would be a quiet upward
 * bias on the invoice.
 *
 * The SETTINGS are part of the exactly-once guarantee, not tuning: see
 * "DEDUPLICATION" above for why exact mode is pinned.
 */
export function windowQuery(slug: string): string {
  assertSlug(slug);
  return `
    SELECT
      count()          AS event_count,
      sum(billed_usd)  AS billed_usd
    FROM (
      SELECT
        concat(TraceId, ':', SpanId)                           AS event_key,
        any(toFloat64OrZero(attrs['gen_ai.cost.total_cost']))  AS billed_usd
      FROM tenant_${slug}.span_nodes FINAL
      WHERE SpanName = {span:String}
        AND attrs['gen_ai.cost.total_cost'] != ''
        AND JSONExtractString(attrs['hidden_params'], 'cache_key') = ''
        AND ingested_at >  {from:DateTime64(3)}
        AND ingested_at <= {to:DateTime64(3)}
      GROUP BY event_key
    )
    SETTINGS use_skip_indexes_if_final = 1, use_skip_indexes_if_final_exact_mode = 1
  `;
}

interface WindowRow {
  event_count: string | number;
  billed_usd: string | number;
}

export function createUsageSource(client?: ClickHouseClient): UsageSource {
  const ch = client ?? defaultClient();

  return {
    async now() {
      const result = await ch.query({ query: "SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms", format: "JSONEachRow" });
      const [row] = await result.json<{ now_ms: string | number }>();
      return Number(row!.now_ms);
    },

    async readWindow(slug, args) {
      const result = await ch.query({
        query: windowQuery(slug),
        query_params: {
          span: LLM_SPAN_NAME,
          from: new Date(args.fromMs),
          to: new Date(args.toMs),
        },
        format: "JSONEachRow",
      });
      const [row] = await result.json<WindowRow>();
      // An aggregate over no rows still returns one row, with zeroes.
      return {
        eventCount: Number(row?.event_count ?? 0),
        // Float64 throughout, as it was when the sum was done per event in
        // JavaScript — each span's cost is already a float LiteLLM computed, so
        // there is no exact decimal to lose. Each value carries ~1e-16 relative
        // error, and a sum of n of them up to about n × that: for thousands of
        // spans in one window, a few units in the 10th USD decimal (measured:
        // 5,000 × $19.99 sums to 99949.9999999993). Unbiased, and far below a
        // cent; a sumKahan or Decimal sum would buy it back if it ever mattered.
        billedUsd: Number(row?.billed_usd ?? 0),
      };
    },
  };
}

function defaultClient(): ClickHouseClient {
  const { clickhouse } = getConfig();
  return createClient({
    url: clickhouse.url,
    username: clickhouse.user,
    password: clickhouse.password,
    clickhouse_settings: {
      // A billing read must never wedge a worker behind a runaway scan.
      max_execution_time: Math.ceil(clickhouse.timeoutMs / 1000),
    },
  });
}
