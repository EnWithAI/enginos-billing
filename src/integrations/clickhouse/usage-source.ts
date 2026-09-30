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
 * TIME WINDOWS, ON WHEN THE LLM CALL ENDED
 *
 *   ended_at = Timestamp + duration_ms
 *   WHERE ended_at > :from AND ended_at <= :to
 *
 * `Timestamp` is when the call STARTED (MEASURED 2026-09-30 against LiteLLM's
 * own spend log: equal to its startTime within 0.1 s) and `duration_ms` is how
 * long it ran; both are read from span_nodes as they are — billing adds no
 * column and changes nothing in ClickHouse. The window is on the END because
 * that is when a span is written: a window on the start would have to wait out
 * the longest call (LiteLLM's 600 s request_timeout) before it was complete.
 *
 * Half-open, and both ends are TIMES the worker chose. Several spans routinely
 * share a millisecond, but that is only a hazard when a boundary can fall
 * INSIDE one — which is what happened when the boundary was "the last event of
 * a page". A time boundary cannot: every millisecond belongs whole to exactly
 * one window, so consecutive windows lose nothing between them and overlap
 * nowhere.
 *
 * THE LAG IS WHAT MAKES A WINDOW COMPLETE
 *
 * A span is written once its call has ended, then batched by the collector
 * and inserted. A window is read only once it is BILLING_LAG_MS in the past
 * (60 s by default, never under 30), so the calls that ended in it have
 * landed. MEASURED 2026-09-30 over 421 local spans: p50 23 s and p99 44 s from
 * the call's end to the row; 3 took over 45 s and 1 over 60 s. A span that
 * lands later than the lag is behind the cursor and is never billed.
 *
 * DEDUPLICATION IS A SEPARATE JOB FROM THE CURSOR
 *
 * The window says WHICH events; `GROUP BY concat(TraceId, ':', SpanId)` says
 * which of them are the same event. That pair is the identity span_nodes itself
 * is keyed on — it is a ReplacingMergeTree ORDER BY (TraceId, SpanId) — so the
 * grouping agrees with the table rather than guessing at it.
 *
 * A span the collector re-sends carries the SAME Timestamp and duration, so it falls in the
 * same window as the first copy: inside a window not yet billed the GROUP BY
 * counts it once, and after the window is billed it is behind the cursor and
 * never read again. Exactly once across windows, with no billing state.
 *
 * Why these rows and not others:
 *
 *   - `span_nodes FINAL`, not `otel_traces`: span_nodes collapses a re-sent
 *     span to one row. The GROUP BY is what counts it once, and it does not
 *     rely on FINAL having collapsed anything.
 *   - One tenant database, never merged with otel_landing: the tenant table is
 *     a copy of its slice of landing, and a union counts every span twice.
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
  /** Exclusive lower bound on when the call ended — the cursor. */
  fromMs: number;
  /** Inclusive upper bound — the safe processing time. */
  toMs: number;
}

export interface UsageSource {
  /** ClickHouse's clock, epoch ms — the lag is measured against it. */
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
 * span_nodes is partitioned by toDate(Timestamp), so `Timestamp` is bounded
 * too: a call that ended in the window started at most an hour before it (the
 * gateway gives up after 600 s, retries included well inside an hour), which
 * prunes the read to one or two day partitions. A duration that is missing or
 * not a number counts as zero.
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
        AND Timestamp >  {from:DateTime64(3)} - INTERVAL 1 HOUR
        AND Timestamp <= {to:DateTime64(3)}
        AND addMilliseconds(Timestamp, if(isFinite(duration_ms) AND duration_ms > 0, toInt64(duration_ms), 0)) >  {from:DateTime64(3)}
        AND addMilliseconds(Timestamp, if(isFinite(duration_ms) AND duration_ms > 0, toInt64(duration_ms), 0)) <= {to:DateTime64(3)}
      GROUP BY event_key
    )
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
