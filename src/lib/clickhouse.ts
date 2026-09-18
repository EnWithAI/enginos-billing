/**
 * Reads what a tenant spent, from that tenant's own ClickHouse database.
 *
 * Three things here are deliberate and easy to get wrong:
 *
 * 1. `span_nodes`, not `otel_traces`. The raw trace table is a plain MergeTree,
 *    and the tenant migration that added block deduplication says so outright:
 *    it is "bounded and best-effort by design... not an idempotency guarantee",
 *    and a real one "needs a dedup key carried on the span itself".
 *    `span_nodes` is a ReplacingMergeTree ordered by (TraceId, SpanId) — that
 *    key — so FINAL collapses a span the collector re-sent. Its materialised
 *    view has no WHERE clause and carries the whole attribute bag as `attrs`,
 *    so nothing is lost by reading it instead.
 *
 * 2. One tenant database, never merge() across otel_landing and tenant_*. The
 *    tenant table is populated by `SELECT * FROM otel_landing.otel_traces WHERE
 *    crewpe.tenant_id = '<slug>'` — a copy, not a slice. A union over both
 *    counts every routed span twice, doubling every invoice.
 *
 * 3. Half-open [from, to). Adjacent windows share a boundary instant, and >=
 *    with < puts it in exactly one of them.
 *
 * Retries are billable. LiteLLM runs num_retries: 3; a failed attempt carries
 * no cost and is excluded by the empty-string check, but a fallback that
 * succeeded on a second model did make a second provider call and should be
 * billed. Sum every costed span — do not collapse a trace to one row.
 */

import { createClient, type ClickHouseClient } from "@clickhouse/client";

import { getConfig } from "./config";
import { decimal } from "./decimal";
import type { Window } from "./window";

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

export interface WindowUsage {
  spans: number;
  billedUsd: string;
  providerUsd: string;
  marginUsd: string;
  inputTokens: number;
  outputTokens: number;
}

export function emptyUsage(): WindowUsage {
  return {
    spans: 0,
    billedUsd: "0",
    providerUsd: "0",
    marginUsd: "0",
    inputTokens: 0,
    outputTokens: 0,
  };
}

interface UsageRow {
  spans: string | number;
  billed_usd: string | number;
  provider_usd: string | number;
  margin_usd: string | number;
  in_tok: string | number;
  out_tok: string | number;
}

/** Built here rather than inline so a test can assert its shape without a server. */
export function usageQuery(slug: string): string {
  assertSlug(slug);
  return `
    SELECT
      count()                                                        AS spans,
      sum(toFloat64OrZero(attrs['gen_ai.cost.total_cost']))          AS billed_usd,
      sum(toFloat64OrZero(attrs['gen_ai.cost.original_cost']))       AS provider_usd,
      sum(toFloat64OrZero(attrs['gen_ai.cost.margin_total_amount'])) AS margin_usd,
      sum(input_tokens)                                              AS in_tok,
      sum(output_tokens)                                             AS out_tok
    FROM tenant_${slug}.span_nodes FINAL
    WHERE SpanName = {span:String}
      AND attrs['gen_ai.cost.total_cost'] != ''
      AND Timestamp >= {from:DateTime64(3)}
      AND Timestamp <  {to:DateTime64(3)}
  `;
}

/**
 * One cheap query identifying which tenants produced costed spans in a window.
 *
 * Reading the landing table alone does NOT double-count — it is the source, and
 * every span passes through it exactly once; the duplication only appears when
 * landing is unioned with the tenant copies. Precision is not needed here, only
 * a candidate list, so the weaker dedup on this table is acceptable.
 *
 * This is what keeps a 1-minute cron affordable: without it the sweep is one
 * query per tenant per tick, most against tenants with no traffic at all.
 */
export function activeTenantsQuery(): string {
  return `
    SELECT DISTINCT SpanAttributes['crewpe.tenant_id'] AS tenant
    FROM otel_landing.otel_traces
    WHERE SpanName = {span:String}
      AND SpanAttributes['gen_ai.cost.total_cost'] != ''
      AND SpanAttributes['crewpe.tenant_id'] != ''
      AND Timestamp >= {from:DateTime64(3)}
      AND Timestamp <  {to:DateTime64(3)}
  `;
}

export interface UsageReader {
  readWindow(slug: string, window: Window): Promise<WindowUsage>;
  activeTenants(window: Window): Promise<string[]>;
  close(): Promise<void>;
}

export function createUsageReader(client?: ClickHouseClient): UsageReader {
  const ch = client ?? defaultClient();
  async function readWindow(slug: string, window: Window): Promise<WindowUsage> {
    const result = await ch.query({
      query: usageQuery(slug),
      query_params: {
        span: LLM_SPAN_NAME,
        from: new Date(window.start),
        to: new Date(window.end),
      },
      format: "JSONEachRow",
    });

    const rows = await result.json<UsageRow>();
    return rows[0] ? toUsage(rows[0]) : emptyUsage();
  }

  async function activeTenants(window: Window): Promise<string[]> {
    const result = await ch.query({
      query: activeTenantsQuery(),
      query_params: {
        span: LLM_SPAN_NAME,
        from: new Date(window.start),
        to: new Date(window.end),
      },
      format: "JSONEachRow",
    });

    const rows = await result.json<{ tenant: string }>();
    return rows.map((row) => row.tenant).filter(Boolean);
  }

  return { readWindow, activeTenants, close: () => ch.close() };
}

/**
 * Numeric sums arrive as JSON numbers (float64). They become decimal strings
 * immediately and are never handed onward as numbers, so the float
 * representation is pinned once, here, rather than drifting through the
 * conversion to credits.
 */
export function toUsage(row: UsageRow): WindowUsage {
  return {
    spans: Number(row.spans ?? 0),
    billedUsd: money(row.billed_usd),
    providerUsd: money(row.provider_usd),
    marginUsd: money(row.margin_usd),
    inputTokens: Number(row.in_tok ?? 0),
    outputTokens: Number(row.out_tok ?? 0),
  };
}

/**
 * Convert one ClickHouse sum to a decimal string.
 *
 * The value is handed to `decimal()` as a NUMBER, never String()-ed first.
 * JavaScript renders anything below 1e-6 exponentially — `String(1e-7)` is
 * `"1e-7"` — and the decimal parser rejects that spelling from a string,
 * because a string is meant to already be in decimal form. Passing the number
 * lets `decimal()` expand the exponent itself.
 *
 * This is the hot path, not an edge case: a quiet window can easily total
 * fractions of a cent, and String()-ing it threw and killed the sweep for that
 * tenant.
 */
function money(value: string | number | null | undefined): string {
  if (value == null) return "0";
  return decimal(typeof value === "number" ? value : String(value));
}

function defaultClient(): ClickHouseClient {
  const { clickhouse } = getConfig();
  return createClient({
    url: clickhouse.url,
    username: clickhouse.user,
    password: clickhouse.password,
    clickhouse_settings: {
      // Mirrors the platform's dashboard reader: a billing read must never
      // wedge a worker behind a runaway scan.
      max_execution_time: Math.ceil(clickhouse.timeoutMs / 1000),
    },
  });
}
