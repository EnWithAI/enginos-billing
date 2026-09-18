# enginos-billing

Prepaid token billing. A tenant subscribes to one prepaid plan and receives a
grant of credits; every minute a Hatchet cron reads what they actually spent
from ClickHouse, draws it down through an append-only ledger and Chargebee's
prepaid ledger, and the LiteLLM gateway refuses service once the grant is gone.

Two processes from one image:

```bash
npm run dev      # API on :4300  (webhooks + internal reads)
npm run worker   # Hatchet worker (the cron sweep)
npm test         # 38 tests, no external services needed
```

## Why a separate service

Billing reads ClickHouse, writes the master Postgres, calls Chargebee, and runs
a cron. It shares no request path with anything else, and an outage in it must
never take down the gateway. Keeping it separate also keeps the Chargebee API
key out of every other service's process.

## What it does NOT do

**It performs no pricing arithmetic.** LiteLLM stamps the customer-facing cost
onto each span as `gen_ai.cost.total_cost`; this service sums that column. There
is exactly one pricing system and it is the gateway's.

**It does not create credit grants.** The item price carries a Credit Grant
configuration and Chargebee issues credits automatically on subscription
creation. `/ledger_operations/allocate` is for ad-hoc grants, requires a
mandatory `expires_at`, and has no client-supplied id — we read what Chargebee
granted and mirror it.

**It does not block LLM requests.** Enforcement is the LiteLLM team's
`max_budget`, set from the grant's dollar value at subscription time and metered
by the gateway in real time. Driving it from the ledger balance instead would
let a tenant overspend for a whole sync interval before the gate noticed.

## The three things that prevent double-charging

Two are database constraints and one is an API property. In
`prisma/migrations/20260916120000_billing_prepaid_credits/migration.sql`:

| Guard | What it stops |
| --- | --- |
| `UNIQUE (tenant_id, window_start) WHERE kind='window'` | A time window billing twice |
| `UNIQUE (tenant_id) WHERE status='pending'` | Two captures in flight for one tenant |
| `UNIQUE (tenant_id, source_ref)` on the ledger | A replayed webhook granting credits twice, and a replayed batch consuming twice |

Plus the Chargebee operation `id` — the batch UUID — so a replay after a crash
settles instead of re-charging.

**Those partial indexes are why the migration is hand-authored.** `prisma
migrate dev` reconciles against `schema.prisma`, sees objects it did not model
as drift, and drops them. Apply with `prisma migrate deploy`, never `migrate
dev`.

## Reading usage

One query per tenant against that tenant's own database:

```sql
FROM tenant_<slug>.span_nodes FINAL
WHERE SpanName = 'litellm_request' AND attrs['gen_ai.cost.total_cost'] != ''
  AND Timestamp >= {from} AND Timestamp < {to}
```

Three things about that are load-bearing:

- **`span_nodes`, not `otel_traces`.** The raw table is a plain MergeTree whose
  dedup the platform's own migration calls "best-effort by design… not an
  idempotency guarantee". `span_nodes` is a ReplacingMergeTree on
  `(TraceId, SpanId)` — a real per-span dedup key.
- **One tenant database, never `merge()` across `otel_landing` and `tenant_*`.**
  The tenant table is a *copy* of landing, so a union counts every routed span
  twice.
- **Half-open `[from, to)`.** Adjacent windows share a boundary instant.

## Cadence is not freshness

The cron runs every minute but bills a window that closed `BILLING_LAG_MS` ago —
closing a window the instant it ends would miss spans still inside the
collector's 5-second batch. Freshness comes from the lag buffer, not the cron.

Note the platform already walked back from a tight cron once: `outbox-poller`
went from 30 s to 2 min because at 500 tenants the former meant 60,000
tenant-database probes an hour. If the minute proves expensive, widening it
costs nothing operationally — enforcement is the gateway's real-time budget.

## Before this bills anyone

1. **Confirm `USD_PER_CREDIT`.** The default makes 1,000 credits worth $1.00. A
   credit is a *billing* unit with a fixed dollar rate, not an LLM token.
2. **Confirm `gen_ai.cost.total_cost` is inclusive of margin.** If
   `total - original - margin ≈ 0` it is, and billing it alone is correct.
   Adding `margin_total` separately would charge the markup twice.
3. **Confirm a repeated capture `id` does not create a second operation.** The
   docs imply it; they do not state it. `captureIdempotent()` checks for an
   existing operation first as the safety net, but confirm it directly.
4. **Confirm no deployment is unpriced.** `verify-litellm-gateway.ts` in
   enginos-platform already detects this: an unpriced target records spend 0,
   which is both a revenue leak and a hole in the hard block.
5. **Settle the plan reconciler.**
   `litellm-plan-reconcile.scheduler.ts` runs every 60 s and adopts LiteLLM team
   metadata into `OrgLlmGateway.plan`. If Chargebee becomes authoritative, that
   sweep will revert paid subscriptions unless it is inverted or disabled.

## Layout

```
src/lib/decimal.ts     fixed-point money on BigInt, 10 places
src/lib/rate.ts        the one place dollars and credits convert
src/lib/window.ts      half-open window arithmetic, gap detection
src/lib/clickhouse.ts  the usage query
src/lib/chargebee.ts   ledger capture with a client-supplied id
src/lib/ledger.ts      append-only entries, balance derived
src/lib/account.ts     customer creation, grant mirroring, budget push
src/lib/sync.ts        the state machine
worker/                Hatchet cron registration
```
