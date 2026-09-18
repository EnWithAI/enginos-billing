/**
 * Usage events from a tenant's ClickHouse database, in cursor order.
 *
 * One row per costed LLM call (`litellm_request` span), ordered by
 * (ingested_at, TraceId:SpanId) — the same pair the billing cursor stores, so
 * a page always resumes exactly after the last event it returned, even when
 * many events share one ingested_at instant.
 *
 * Why these rows and not others:
 *
 *   - `span_nodes FINAL`, not `otel_traces`: span_nodes is a ReplacingMergeTree
 *     on (TraceId, SpanId), so a span the collector re-sent collapses to one row.
 *     The event key is that same pair, so billing's idempotency check lines up
 *     with ClickHouse's own dedup.
 *   - One tenant database, never merged with otel_landing: the tenant table is
 *     a copy of its slice of landing, and a union counts every span twice.
 *   - `ingested_at` (migration 029), not `Timestamp`: Timestamp is when the LLM
 *     span started and a span can land long after it; a cursor on it that has
 *     already moved on skips the span forever. ingested_at only moves forward.
 *   - `Timestamp >= syncFrom`: usage from before the account existed is never
 *     billed, whatever its ingestion time.
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

import { getConfig } from "./config";

/** The span LiteLLM emits carrying model, tokens and cost. */
export const LLM_SPAN_NAME = "litellm_request";

/**
 * Sorts after every real event key (hex and ':'), so a cursor of
 * (instant, AFTER_ALL) means "everything at this instant is done".
 */
export const AFTER_ALL = "~";

/** A slug becomes part of a database identifier, so it may only be these chars. */
const SAFE_SLUG = /^[a-zA-Z0-9_]+$/;

export function assertSlug(slug: string): string {
  if (!SAFE_SLUG.test(slug)) {
    throw new TypeError(`Unsafe ClickHouse tenant slug: ${JSON.stringify(slug)}`);
  }
  return slug;
}

export interface UsageEvent {
  /** TraceId:SpanId — deterministic, the idempotency key. */
  key: string;
  /** span_nodes.ingested_at, epoch ms. */
  ingestedAtMs: number;
  billedUsd: number;
  providerUsd: number;
  marginUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ReadEventsArgs {
  /** Exclusive lower bound: (afterMs, afterKey). */
  afterMs: number;
  afterKey: string;
  /** Inclusive upper bound on ingested_at. */
  untilMs: number;
  /** Never read a span that started before this: sync_from, or the key horizon behind the cursor. */
  minTimestampMs: number;
  limit: number;
}

export interface UsageSource {
  /** ClickHouse's clock, epoch ms — ingested_at is stamped by it, so lag is measured against it. */
  now(): Promise<number>;
  readEvents(slug: string, args: ReadEventsArgs): Promise<UsageEvent[]>;
}

/** Built here rather than inline so a test can assert its shape without a server. */
export function eventsQuery(slug: string): string {
  assertSlug(slug);
  return `
    SELECT
      concat(TraceId, ':', SpanId)                                   AS event_key,
      toUnixTimestamp64Milli(ingested_at)                            AS ingested_ms,
      toFloat64OrZero(attrs['gen_ai.cost.total_cost'])               AS billed_usd,
      toFloat64OrZero(attrs['gen_ai.cost.original_cost'])            AS provider_usd,
      toFloat64OrZero(attrs['gen_ai.cost.margin_total_amount'])      AS margin_usd,
      input_tokens                                                   AS in_tok,
      output_tokens                                                  AS out_tok
    FROM tenant_${slug}.span_nodes FINAL
    WHERE SpanName = {span:String}
      AND attrs['gen_ai.cost.total_cost'] != ''
      AND JSONExtractString(attrs['hidden_params'], 'cache_key') = ''
      AND Timestamp >= {minTimestamp:DateTime64(3)}
      AND ingested_at <= {until:DateTime64(3)}
      AND (ingested_at > {after:DateTime64(3)}
           OR (ingested_at = {after:DateTime64(3)} AND concat(TraceId, ':', SpanId) > {afterKey:String}))
    ORDER BY ingested_at, event_key
    LIMIT {limit:UInt32}
    SETTINGS use_skip_indexes_if_final = 1
  `;
}

interface EventRow {
  event_key: string;
  ingested_ms: string | number;
  billed_usd: string | number;
  provider_usd: string | number;
  margin_usd: string | number;
  in_tok: string | number;
  out_tok: string | number;
}

export function createUsageSource(client?: ClickHouseClient): UsageSource {
  const ch = client ?? defaultClient();

  return {
    async now() {
      const result = await ch.query({ query: "SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms", format: "JSONEachRow" });
      const [row] = await result.json<{ now_ms: string | number }>();
      return Number(row!.now_ms);
    },

    async readEvents(slug, args) {
      const result = await ch.query({
        query: eventsQuery(slug),
        query_params: {
          span: LLM_SPAN_NAME,
          minTimestamp: new Date(args.minTimestampMs),
          until: new Date(args.untilMs),
          after: new Date(args.afterMs),
          afterKey: args.afterKey,
          limit: args.limit,
        },
        format: "JSONEachRow",
      });
      const rows = await result.json<EventRow>();
      return rows.map((r) => ({
        key: r.event_key,
        ingestedAtMs: Number(r.ingested_ms),
        billedUsd: Number(r.billed_usd),
        providerUsd: Number(r.provider_usd),
        marginUsd: Number(r.margin_usd),
        inputTokens: Number(r.in_tok),
        outputTokens: Number(r.out_tok),
      }));
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
