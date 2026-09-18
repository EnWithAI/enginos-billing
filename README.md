# enginos-billing

Prepaid token billing. A tenant subscribes to one prepaid plan and receives a
grant of credits; every minute a Hatchet cron reads what they actually spent
from ClickHouse, draws it down through an append-only ledger and Chargebee's
prepaid ledger, and the LiteLLM gateway refuses service once the grant is gone.

Two processes from one image:

```bash
npm run dev      # API on :4300  (webhooks + internal reads)
npm run worker   # Hatchet worker (the cron sweep)
npm test         # vitest, no external services needed
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

## What prevents double-charging

Database constraints and one API property. The capture log and ledger are in
`prisma/migrations/20260916120000_billing_prepaid_credits/migration.sql`; the
cursor and event keys in `20260918190000_billing_cursor/migration.sql`:

| Guard | What it stops |
| --- | --- |
| `billing_cursor` — one row per tenant, `(last_processed_at, last_event_id)` | Usage behind the cursor being read again |
| `PRIMARY KEY (tenant_id, event_key)` on `billed_usage_event` | One span (`TraceId:SpanId`) billing twice, even if ClickHouse re-sends it after the cursor |
| `UNIQUE (tenant_id) WHERE status='pending'` | Two captures in flight for one tenant |
| `UNIQUE (tenant_id, source_ref)` on the ledger | A replayed webhook granting credits twice, and a replayed capture consuming twice |

Plus the Chargebee operation `id` — the capture's `usage_sync_batch` UUID — so
a capture whose response was lost is looked up (`GET /ledger_operations/{id}`)
and settled instead of re-sent. The cursor only moves in the same transaction
that records the capture as settled.

**Those partial indexes are why the migration is hand-authored.** `prisma
migrate dev` reconciles against `schema.prisma`, sees objects it did not model
as drift, and drops them. Apply with `prisma migrate deploy`, never `migrate
dev`.

## Reading usage

One query per tenant against that tenant's own database, strictly after the
tenant's cursor (`src/lib/usage-events.ts`):

```sql
SELECT concat(TraceId, ':', SpanId) AS event_key, ingested_at, gen_ai.cost.total_cost …
FROM tenant_<slug>.span_nodes FINAL
WHERE SpanName = 'litellm_request' AND attrs['gen_ai.cost.total_cost'] != ''
  AND <not a LiteLLM cache hit>
  AND Timestamp >= {sync_from}
  AND ingested_at <= {safe_until}
  AND (ingested_at, event_key) > ({cursor_at}, {cursor_event_id})
ORDER BY ingested_at, event_key
LIMIT {max_events_per_capture}
```

Things about that are load-bearing:

- **`span_nodes`, not `otel_traces`.** The raw table is a plain MergeTree whose
  dedup the platform's own migration calls "best-effort by design… not an
  idempotency guarantee". `span_nodes` is a ReplacingMergeTree on
  `(TraceId, SpanId)` — a real per-span dedup key, and the event key here.
- **One tenant database, never `merge()` across `otel_landing` and `tenant_*`.**
  The tenant table is a *copy* of landing, so a union counts every routed span
  twice.
- **The cursor is on `ingested_at`, not `Timestamp`.** `ingested_at` is stamped
  by ClickHouse on insert (tenant migration `029_span_nodes_ingested_at.sql`),
  so a span that arrives late still lands after the cursor. A cursor on span
  time would skip it for good.
- **`(ingested_at, event_key)` is a total order.** Many spans share one
  millisecond; the key breaks the tie, so a page can end mid-millisecond and
  the next read resumes exactly after it. Postgres stores the key `COLLATE "C"`
  so it compares byte-wise, like ClickHouse.
- **Cache hits are not billed.** LiteLLM records spend 0 for them.
- **A re-inserted span is recognised, not re-billed.** A span that lands in
  `span_nodes` again — a collector re-send, or a platform migration that
  rebuilds the table from `otel_traces` (migration 005 did) — gets a fresh
  `ingested_at` and so appears after the cursor. Within the key horizon
  (`BILLING_EVENT_KEY_RETENTION_MS`, 7 days) its `billed_usage_event` key skips
  it; the read also floors `Timestamp` at `cursor − horizon`, so an older copy
  is never read at all. Keys are pruned per tenant only once their span is
  below that floor, so the two always agree. A platform rebuild should still
  carry `ingested_at` across where it can.

## Cadence is not freshness

The cron runs every minute and reads only what ClickHouse ingested before
`now − BILLING_LAG_MS` (`safe_until`, taken from ClickHouse's own clock) —
reading up to the instant would race rows still being inserted. One tick
records at most one capture of up to `BILLING_MAX_EVENTS_PER_CAPTURE` events
per page, and keeps paging (up to 20 captures) so a worker that was down for
hours catches up in a few ticks. An empty tick moves the cursor to
`safe_until` and writes nothing else.

A tenant is processed by one worker at a time: `billing_cursor.locked_until` is
a lease (PgBouncer runs in transaction mode, so advisory locks and held row
locks are not available). An unresolved capture holds that tenant's cursor —
nothing after it is billed until Chargebee confirms or denies it.

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
   docs imply it; they do not state it. `captureIdempotent()` retrieves
   `GET /ledger_operations/{batch id}` before every capture and sends only on a
   404, so this matters only for a capture that lands between the lookup and
   the send — but confirm it directly.
4. **Confirm no deployment is unpriced.** `verify-litellm-gateway.ts` in
   enginos-platform already detects this: an unpriced target records spend 0,
   which is both a revenue leak and a hole in the hard block.
5. **Settle the plan reconciler.**
   `litellm-plan-reconcile.scheduler.ts` runs every 60 s and adopts LiteLLM team
   metadata into `OrgLlmGateway.plan`. If Chargebee becomes authoritative, that
   sweep will revert paid subscriptions unless it is inverted or disabled.

## Layout

```
src/lib/decimal.ts       fixed-point money on BigInt, 10 places
src/lib/rate.ts          the one place dollars and credits convert
src/lib/usage-events.ts  the ClickHouse event read, strictly after a cursor
src/lib/usage-sync.ts    cursor, lease, capture, settle — the one usage path
src/lib/chargebee.ts     ledger capture with a client-supplied id + lookup
src/lib/ledger.ts        append-only entries, balance derived
src/lib/account.ts       customer creation, grant mirroring, budget push
src/lib/retention.ts     prunes event keys older than the re-send horizon
src/lib/reconcile.ts     cross-checks captures, ledger and cursor
scripts/cutover-billing-cursor.ts  one-off: window era → cursor
worker/                  Hatchet cron registration
```
