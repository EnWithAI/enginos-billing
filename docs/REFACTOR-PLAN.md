# Refactor: a cursor column and a sync log

`LLM call → ClickHouse → 1-minute worker → Chargebee`, with PostgreSQL holding
the tenant↔Chargebee mapping, the worker's position, and one row per billing
window.

This is the third and last step of the table reduction. The first two are
history; they are recorded here because the reasoning for what was removed still
applies, and because the migrations are hand-authored and read in order.

## Where it started, and where it is

| Step | Migration | Tables carrying usage billing |
|---|---|---|
| 0 | `20260916120000_billing_prepaid_credits` | `billing_account`, `billing_cursor`, `usage_sync_batch`, `billed_usage_event`, `credit_ledger_entry`, `processed_billing_event` |
| 1 | `20260921120000_billing_two_table` | `billing_account`, `usage_sync` |
| 2 | `20260922060000_chargebee_capture_log` | `billing_account`, `chargebee_capture` |
| **3** | **`20260922130000_billing_cursor_and_sync`** | **`billing_account`, `chargebee_sync`** |

`processed_billing_event` survived every step above and was then removed in
`20260922150000_drop_processed_billing_event` — see the end.

## Step 3, table by table

| Old | What it did | Replaced by | Files affected |
|---|---|---|---|
| `chargebee_capture.cursor_to_at/_key`, read as `max()` over settled rows | the progress record | `billing_account.last_processed_ingested_at` | `usage-sync.ts`, `account.ts`, `billing/[tenantId]`, `e2e-prepaid.ts` |
| `chargebee_capture` status `origin` | the activation point, as a row | the cursor column itself, set create-only at activation | `account.ts` |
| `chargebee_capture` statuses `pending`/`captured`/`skipped`/`insufficient`/`failed` | five states, one of them generic | `chargebee_sync.status`, seven states, each with a defined response | `db.ts`, `usage-sync.ts`, `chargebee.ts` |
| `chargebee_capture.credits` | what was sent | `chargebee_sync.amount` | as above |
| `chargebee_capture.provider_usd`, `.margin_usd` | written, never read | **dropped** | — |
| `chargebee_capture.chargebee_operation_id` | a copy of the row's own id | **dropped** — the `id` IS the operation id | — |
| `chargebee_capture.balance_after` | a cached Chargebee number, never read back | **dropped** (§22) | — |
| `activeSubscriptions(...)[0]` | which subscription gets the usage, as an array index | `models/subscription.ts`, called from `syncFromChargebee` | `account.ts`, `subscription.ts` |

## The three changes that are not renames

### 1. The cursor is a time, not a position

It was `(ingested_at, TraceId:SpanId)`. The key half existed because the read was
a `LIMIT 5000` page of events, and a page ends on an arbitrary event inside a
millisecond — several spans routinely share one, so a bare `>` on the timestamp
would have dropped the rest of that millisecond for ever.

Windows are now bounded by times the worker picks:

```sql
WHERE ingested_at >  :from   -- the cursor
  AND ingested_at <= :to     -- cursor + BILLING_WINDOW_MS, once it fits
```

A time boundary cannot fall inside a millisecond, so there is nothing to
tie-break. The `LIMIT` goes with it, because the query aggregates
(`count()`, `sum()`) instead of returning rows — and the `LIMIT` was the only
reason a page had to be resumable in the first place.

**Event identity did not go away, it moved.** Deduplication is now entirely the
query's job, as `GROUP BY concat(TraceId, ':', SpanId)` over `span_nodes FINAL`
— the same pair the table is keyed on (`ReplacingMergeTree ORDER BY (TraceId,
SpanId)`). Two responsibilities, two mechanisms, neither doing the other's job.

**The window is a fixed span, not "whatever is available".** `to = from +
BILLING_WINDOW_MS` (default one minute), processed only once it fits inside
`now − lag`. That is not cosmetic: `to = min(from + max, until)` would give two
workers reading the same cursor a few milliseconds apart DIFFERENT window ends,
and `chargebee_sync_window_uq` — keyed on `from_ingested_at` — could not see
them as the same window. One could then charge `(from, toB]` while the other
advanced the cursor to `toA`, leaving the overlap to be billed twice. With `to`
derived from `from`, two workers either collide on the index or agree exactly.

Catch-up is bounded by the same constant rather than by a row count: an outage
drains one window at a time, up to `BILLING_MAX_WINDOWS_PER_TICK` per tick, each
succeeding or failing on its own.

### 2. Seven statuses, and a backoff per status

`failed` answered "it did not work" without saying which of four very different
things happened. The states and their responses are now:

| Status | Retry policy |
|---|---|
| `PENDING` | every tick — and **without a lookup**, because the id has provably never been on the wire |
| `PROCESSING` | every tick, lookup first |
| `UNKNOWN` | every tick, lookup first |
| `RATE_LIMITING` | 1 min doubling to 15 |
| `OUT_OF_CREDITS` | 5 min doubling to 1 hour while the account is `exhausted`; at once after a top-up or renewal |
| `INVALID` | 5 min doubling to 1 hour |

The backoff is derived from `updated_at + f(attempt_count)`; there is no
`next_attempt_at` column.

`PROCESSING` is the state that earns its keep: it is written and committed
*before* the request leaves, so a row still reading `PENDING` has provably never
been sent and can skip the verification lookup. That halves the Chargebee calls
on the happy path — one capture per tenant per minute instead of a lookup and a
capture — without weakening recovery anywhere, because every path that could
have sent the id goes through `recover()`, which always asks first.

### 2b. The cost of splitting progress from outcome, and how it is paid

A derived cursor could not disagree with the log; a stored one can. There is
exactly one way in — a window resolves but its cursor advance does not land —
and it is closed in two places: the advance is a compare-and-set, so a stale
worker cannot rewind it, and an insert that collides with an already-`SUCCESS`
row moves the cursor past it (`billing.sync.cursor_repaired`) instead of
returning `LOCKED` for ever.

### 3. A subscription with no prepaid ledger now HOLDS the cursor

It was `skipped`, which moved billing past usage that would never be charged. It
is now `INVALID`: the usage waits, and bills the moment someone configures the
ledger. The 7-day `billing.sync.behind` alarm is what stops that becoming a
silent hold until ClickHouse's 90-day TTL takes the spans.

## Migration safety

The cutover, unlike step 1's, **preserves continuity**:

- Each tenant's cursor is seeded from the furthest settled `cursor_to_at`. Not
  `now()`, which would skip everything ingested since the last capture, and not
  epoch, which would bill 90 days of retention.
- Unresolved captures are carried across **with their ids intact**, mapped
  `pending → UNKNOWN`, `insufficient → OUT_OF_CREDITS`, `failed → INVALID`. The
  id is the only way to ask Chargebee whether the money moved; dropping those
  rows would re-bill their usage under a new id.
- Settled captures are not carried. Their ranges are expressed in a position pair
  the new table has no column for, and Chargebee holds the authoritative record
  of the money.

The one **acknowledged loss**: a cursor that sat inside a millisecond (possible
only at a `LIMIT` boundary) loses the remainder of that millisecond, because
`ingested_at > cursor` excludes it. Sub-cent, once, and the migration counts the
affected tenants in a `RAISE WARNING`. Rounding down instead would re-bill
everything already charged in that millisecond, which is the worse error.

Verified by applying the migration to a scratch schema cloned from the live
tables: cursors seeded correctly for a settled tenant, a held tenant and an
unsubscribed one; the unresolved capture carried across as `UNKNOWN` with its id;
and all five guards confirmed to reject the rows they exist to reject.

## Preserved from earlier steps

- `captureIdempotent()` — lookup by our id before every send, and the whole
  `classify()` table (`retryable` / `rate_limited` / `insufficient` /
  `no_ledger` / `terminal`, auth failure and blocked site as unknowns).
- The Chargebee webhooks and their claim-before-acting handling.
- LiteLLM `max_budget` enforcement, the spend baseline, blocking on
  `activating` / `exhausted`, and release on cancellation.
- One worker per tenant, under the same Hatchet `maxRuns: 1` workflow — now
  guaranteed by `chargebee_sync_window_uq` and the compare-and-set cursor rather
  than by a lease.
- No local record of the customer's credits. Chargebee owns the money.

### Why `processed_billing_event` went

It was kept through three refactors because Chargebee does not sign webhooks and
the claim row was the only replay guard in front of an endpoint that changes
subscription state. What changed is that the handlers became convergent: with the
credit ledger gone, every one of them re-reads Chargebee and applies what it
says, so a redelivery converges rather than doubling.

The two writes that are not convergent are guarded at the write: the cursor
update is create-only, and top-up grants are keyed on the invoice id inside
Chargebee's own ledger with an idempotency header on the allocate.

The cost is real and worth naming: per-tenant webhook history and the
`unmapped customer` marker are gone from our database. In exchange a failing
handler now returns 500 instead of 200, so Chargebee retries it and records a
permanently failing webhook in its delivery log — which is where that audit
trail now lives.
