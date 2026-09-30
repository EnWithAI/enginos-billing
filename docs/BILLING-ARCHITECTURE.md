# Billing architecture

How usage becomes money, end to end.

Written for an engineer who has not seen this codebase and has to operate,
debug or extend it. Companion documents: [SCHEMA.md](SCHEMA.md) for the
column-by-column reference, [CHARGEBEE-API.md](CHARGEBEE-API.md) for measured
API behaviour, [UPDATE-PATHS.md](UPDATE-PATHS.md) for which mechanism writes
which field.

---

## 1. The shape of it

```
   LLM call
      │
   LiteLLM gateway            stamps gen_ai.cost.total_cost onto the span
      │
   OpenTelemetry
      │
   ClickHouse  tenant_<slug>.span_nodes       ReplacingMergeTree (TraceId, SpanId), read
      │                                       as it is — billing adds no column, no migration
      │
      │   ── every 60s, Hatchet cron ──
      ▼
   enginos-billing worker
      │   read cursor → range to now − lag → aggregate → record → charge → move cursor
      ▼
   PostgreSQL (master DB)     billing_account + chargebee_sync, and nothing else
      │
      ▼
   Chargebee prepaid ledger   the money. Credits, grants, top-ups, consumption.
```

**The one rule that explains most of the design: this service stores no
financial state.** No balance, no ledger, no record of what was billed. Every
credit figure on the billing page is read from Chargebee at request time. A
second copy of a number Chargebee owns can only ever be wrong, and managing that
wrongness was most of the code this service used to be.

What Postgres answers is narrow:

1. Which Chargebee customer and subscription is this tenant?
2. How far has the billing worker got? — the **cursor**
3. What happened to each range it billed? — the **sync log**

---

## 2. Schema

Two tables. That is the whole of the usage-billing schema.

```
billing_account          tenant ↔ Chargebee mapping, AND the billing cursor
    │
    └── chargebee_sync   one row per billed range (1:N)
```

A **range** is the interval of call end times one capture covers; the code and
the index names still call it a *window*. It is not a fixed length (§3).

### `billing_account`

| Column | Type | Purpose |
|---|---|---|
| `tenant_id` | `uuid` PK | Logical FK to master `tenants` — deliberately **not** a Prisma relation, so migrations can never propose a change to a table this service does not own |
| `routing_slug` | `varchar(100)` UNIQUE | The ClickHouse database key: `tenant_<routing_slug>.span_nodes` |
| `chargebee_customer_id` | `varchar(100)` UNIQUE | **We supply this** — it is the tenant UUID. A retry collides on Chargebee's side rather than creating a second customer |
| `chargebee_subscription_id` | `varchar(100)` UNIQUE | Which subscription receives usage. *Which one that is* is decided in `models/subscription.ts`; the column stores only the answer |
| `chargebee_item_price_id` | `varchar(100)` | The plan bought. Carries the Credit Grant configuration |
| `ledger_unit_id` | `varchar(50)` | e.g. `token-test`. Required on every capture, so cached rather than fetched per minute. A free org on a zero-grant plan has none until the free credits' allocate creates its wallet; the account then adopts that unit (`adoptLedgerUnit`, §11 `FREE_PLAN_CREDIT_UNIT`) |
| `billing_email` | `varchar(320)` | Captured at provisioning, before any User row exists |
| `free_plan` | `boolean` | Whether the org is put on the free plan; null follows `FREE_PLAN_DEFAULT` (§11) |
| `current_term_start` / `_end` | `timestamptz` | Mirrored for display and for top-up expiry |
| `status` | `varchar(20)` | `unlinked` / `activating` / `active` / `cancelled` / `exhausted` |
| **`last_processed_ingested_at`** | `timestamptz(3)` | **THE CURSOR** — a call end time; see below |
| `created_at` / `updated_at` | `timestamptz` | |

### `chargebee_sync`

One row per range **that contained usage**. An empty range moves the cursor
and writes nothing — a log of empty minutes is noise. The two range columns keep
their `*_ingested_at` names from when they held ClickHouse's ingest time; they
hold call end times.

| Column | Type | Purpose |
|---|---|---|
| `id` | `uuid` PK | **Also the Chargebee ledger operation id.** Written before the capture is sent |
| `tenant_id` | `uuid` | FK → `billing_account`, ON DELETE CASCADE |
| `chargebee_subscription_id`, `ledger_unit_id` | | **Pinned at creation**, so a mid-term subscription change still settles against the subscription that incurred the usage |
| `from_ingested_at` | `timestamptz(3)` | Range start, **exclusive**. Equals the cursor it opened at |
| `to_ingested_at` | `timestamptz(3)` | Range end, **inclusive**: `now − lag` when the range was opened, at most `from + BILLING_MAX_RANGE_MS` |
| `status` | `varchar(16)` | One of eight — see §5 |
| `amount` | `decimal(20,10)` | Credits sent to Chargebee |
| `billed_usd` | `decimal(20,10)` | The dollar figure behind it |
| `event_count` | `integer` | Distinct `TraceId:SpanId` in the range |
| `error`, `attempt_count` | | Why it is not SUCCESS; sends attempted |
| `hatchet_run_id` | `varchar(100)` | Correlates back to the workflow run |
| `created_at`, `settled_at`, `updated_at` | `timestamptz(3)` | `updated_at` is what the backoff is measured from |

**Constraints that carry real weight** (several are in the migration SQL, not
in `schema.prisma` — Prisma cannot express partial/compound CHECKs):

| Object | What it prevents |
|---|---|
| `chargebee_sync_window_uq` UNIQUE `(tenant_id, from_ingested_at)` | **The mutex.** Two workers reading the same cursor compute different ends but share a start, so both rows collide here and one range can never be sent under two operation ids. What it cannot see — a range opened over a start another worker has already passed — `openWindow`'s cursor check covers (§3) |
| CHECK `to_ingested_at > from_ingested_at` | A zero-length range would claim a row and move the cursor nowhere |
| CHECK `SUCCESS ⟺ settled_at IS NOT NULL` | A resolved row with no settle time, or an unresolved one carrying one, is uninterpretable |
| `chargebee_sync_progress_idx`, `_status_idx` | Reading "last synced"; finding unresolved work across tenants |

### The cursor

`billing_account.last_processed_ingested_at` — the **call end time**
(`Timestamp + duration_ms`, §3) up to which this tenant is **fully billed**:
every LLM call that ended at or before it has been billed or passed as empty.
The next range starts here. The name is from when it held ClickHouse's
`ingested_at`; billing reads no such column now.

It is **worker progress and nothing else**: not a Chargebee status, not a
payment status, not an event id. Set to `now()` at activation (create-only), and
thereafter moves only when the range in front of it resolves.

**Why it is a time, not a position.** It used to be the pair
`(ingested_at, TraceId:SpanId)`, because the read was a `LIMIT 5000` page of
events and a page ends on an arbitrary event inside a millisecond — several
spans routinely share one. Ranges are bounded by *times*, so a boundary
cannot fall inside a millisecond and there is nothing to tie-break. They are
full UTC instants throughout (`timestamptz`, `DateTime64`, epoch ms): a range
may cross midnight or a month end, and neither is special.

**Event identity did not disappear, it moved.** Deduplication is the ClickHouse
query's job (`GROUP BY concat(TraceId, ':', SpanId)`). Two responsibilities, two
mechanisms:

```
cursor      →  which TIME RANGE
event key   →  which EVENTS are the same event
```

**Advancing is compare-and-set**, never a blind write:

```sql
UPDATE billing_account SET last_processed_ingested_at = <range end>
 WHERE tenant_id = :t AND last_processed_ingested_at = <range start>
```

A worker resumed after a long pause matches nothing and changes nothing, so it
cannot rewind a tenant's billing. Opening a range and passing an empty one make
the same check first, under the account row's lock (§3).

### Migration history

Ten migrations over seven days took six tables down to two. Reading them in
order is the fastest way to understand why the current shape is what it is.

| # | Migration | What it did |
|---|---|---|
| 1 | `20260916120000_billing_prepaid_credits` | Creates **four** tables: `billing_account`, `credit_ledger_entry`, `usage_sync_batch`, `processed_billing_event` |
| 2 | `20260918120000_billing_account_activating` | Adds `activating` to the status CHECK |
| 3 | `20260918190000_billing_cursor` | Creates `billing_cursor` and `billed_usage_event` — **the six-table peak** |
| 4 | `20260918200000_billed_usage_event_horizon` | Prunes event keys by position rather than age; relaxes the window-order CHECK to `>=` |
| 5 | `20260920090000_usage_sync_batch_held_status` | Splits `held` out of `failed` — they had been told apart by matching error text |
| 6 | `20260921080000_usage_sync_batch_concurrent_pending` | Drops the one-pending-per-tenant index |
| 7 | `20260921120000_billing_two_table` | Creates `usage_sync`; **drops** `billed_usage_event`, `usage_sync_batch`, `credit_ledger_entry`, `billing_cursor`, and five columns from `billing_account` |
| 8 | `20260922060000_chargebee_capture_log` | `usage_sync` → `chargebee_capture`; progress becomes the furthest settled row |
| 9 | `20260922130000_billing_cursor_and_sync` | Splits it back apart: adds the cursor **column**, creates `chargebee_sync`, drops `chargebee_capture` |
| 10 | `20260922150000_drop_processed_billing_event` | Drops the webhook claim table |

Note that #7 calls itself "six billing tables become two" while deliberately
leaving `processed_billing_event` standing — so **three** tables existed until
#10 removed it.

The arc worth understanding is #8 → #9. Migration 8 made progress *derived*
(the furthest settled capture); migration 9 split it back into an explicit
cursor column. Derived progress cannot disagree with the log, but it also meant
an idle minute could not move the cursor without writing a row to move it with.
The explicit column is what lets an empty range advance and write nothing — at
the cost of two places that must agree, which is why the advance is a
compare-and-set and why the `cursor_repaired` path exists (§5).

Four later migrations build on that shape:
`20260924120000_chargebee_sync_written_off` (the `WRITTEN_OFF` status),
`20260924190000_topup_grant` (the top-up guard, §10 #1) and its test-site seed,
and `20260929120000_billing_account_free_plan` (the `free_plan` column). Moving
the ranges onto call end times (2026-09-30) took no migration, here or in
ClickHouse: the columns kept their names.

All ten are **hand-authored SQL**, and most say so in a header comment. That is
not stylistic: correctness rests on partial unique indexes and compound CHECKs
that Prisma's schema language cannot express. `prisma migrate dev` reconciles
against `schema.prisma`, sees objects it did not model as drift, and drops
them — silently removing the guarantee that a range bills exactly once.

> **Apply with `prisma migrate deploy`, never `migrate dev`**, then
> `prisma migrate resolve` to record it.

---

## 3. Collecting the usage

A call is billed by when it **ended**: `Timestamp + duration_ms`, read from
`span_nodes` as it is. Billing adds no ClickHouse column and needs no
ClickHouse migration.

### Choosing the range

```
from  =  cursor
to    =  min(now − BILLING_LAG_MS, cursor + BILLING_MAX_RANGE_MS)     defaults 60_000, 3_600_000
read only if  to > from
```

`now` is **ClickHouse's clock**, not the worker's: the lag is how long a span
takes to land there, so it is measured on that clock.

An ordinary pass bills about the minute since the last one. A partial range is
fine — the next pass starts where it ended — and nothing is read while the
cursor is at or past `now − lag`. There is no fixed window: `BILLING_WINDOW_MS`
and `BILLING_MAX_WINDOWS_PER_TICK` are removed and no longer read.

**Two workers, two ends, one bill.** Two workers reading the same cursor a
moment apart compute *different* ends. `chargebee_sync_window_uq`, keyed on
`from_ingested_at`, catches both writing a row at one start, but not this: one
worker passes an empty `(c, tA]` and goes on to bill `(tA, …]`, while the other,
which read `c` before that, bills `(c, tB]` over both — the overlap charged
twice. So both moves check the cursor first, under the account row's lock:

| Move | Guard |
|---|---|
| Open a row — `openWindow` (`chargebee-sync.repository.ts`) | Compare-and-set of the cursor onto itself (`= from`), which locks the account row until the insert commits; then the unique index |
| Pass an empty range — `advancePastEmptyWindow` (`billing-account.repository.ts`) | The same lock and check, then a look for a row owning `from`; the cursor moves only if there is none |

Of two ranges from one start, exactly one is billed or passed; the other finds
the cursor gone and backs off (`billing.sync.raced`). A retry never recomputes
a range: the stored row is re-sent under its id (§4, §5).

**Catch-up.** A tenant hours behind (worker down) is billed in consecutive
ranges of at most `BILLING_MAX_RANGE_MS`, several in one pass: one Chargebee
capture per range with usage, and an empty range moves the cursor with no row.
Why an hour: Chargebee refuses a capture larger than the balance **whole** — it
cannot take part of one — so an org that ran out part-way through an outage has
at most an hour held `OUT_OF_CREDITS`, not the whole outage.

**The run budget.** A pass stops *starting* ranges — and tenants — past its
deadline; the range in hand finishes. `runOnce` defaults to 3 minutes
(`DEFAULT_RUN_BUDGET_MS`); the worker passes `SYNC_DEADLINE_MS` (3 min) for a
single pass, or `LAST_PASS_START_MS` (45 s) with several passes a minute. Orgs
are visited one by one in `listBillable` order, and those not reached are billed
next minute from their cursors (warn `billing.sync.budget_spent`). The gate
check follows, stopping at 4 minutes, inside the task's 5-minute
`executionTimeout`. On an ordinary minute the budget is never reached.

### The lag

A span is written once its call has ended, then batched by the collector and
inserted. MEASURED 2026-09-30 over 421 local spans: it landed p50 23 s and p99
44 s after its call ended; 3 took over 45 s, 1 over 60 s.

`BILLING_LAG_MS` is 60 s by default. Under 30 s (`MIN_LAG_MS`, 0 included) the
process refuses to start, unless `BILLING_ALLOW_SHORT_LAG=true` — tests only.
The local `.env` uses 45 s.

The aggregate is taken once and the cursor then moves past the range, so **a
span that lands later than the lag is behind the cursor and never billed**.
That is the price of billing on call time rather than on arrival: the lag
trades how soon usage reaches Chargebee against how many late spans are lost.
Enforcement does not depend on it (§8).

### The query

One read per range, returning a count and a total — **not rows**:

```sql
SELECT
  count()          AS event_count,
  sum(billed_usd)  AS billed_usd
FROM (
  SELECT
    concat(TraceId, ':', SpanId)                           AS event_key,
    any(toFloat64OrZero(attrs['gen_ai.cost.total_cost']))  AS billed_usd
  FROM tenant_<slug>.span_nodes FINAL
  WHERE SpanName = {span:String}
    AND attrs['gen_ai.cost.total_cost'] != ''
    AND JSONExtractString(attrs['hidden_params'], 'cache_key') = ''
    AND Timestamp >  {from:DateTime64(3)} - INTERVAL 1 HOUR
    AND Timestamp <= {to:DateTime64(3)}
    AND addMilliseconds(Timestamp, <duration>) >  {from:DateTime64(3)}
    AND addMilliseconds(Timestamp, <duration>) <= {to:DateTime64(3)}
  GROUP BY event_key
)

-- <duration> = if(isFinite(duration_ms) AND duration_ms > 0, toInt64(duration_ms), 0)
```

Load-bearing details:

- **`span_nodes`, never `otel_traces`.** `span_nodes` is a ReplacingMergeTree on
  `(TraceId, SpanId)` — a real per-span dedup key, and the event identity here.
  `FINAL` collapses a re-sent span to one row; the `GROUP BY` is what counts it
  once, and does not rely on `FINAL` having collapsed anything.
- **On when the call ended.** `Timestamp` is when the call *started* (MEASURED
  2026-09-30: equal to LiteLLM's spend-log `startTime` within 0.1 s);
  `duration_ms` is `Duration / 1e6`, from platform tenant migration 004's view.
  A duration that is missing or not a number counts as zero. The end, not the
  start, because that is when a span is written: a range on the start would
  have to wait out the longest call (LiteLLM's 600 s `request_timeout`) before
  it was complete.
- **A re-send is billed once, with no billing state.** A span the collector
  re-sends carries the same `Timestamp` and duration, so it falls in the same
  range as the first copy: inside a range not yet billed the `GROUP BY` counts
  it once, and after the range is billed it is behind the cursor and never read
  again. The earlier ingest-time design needed tenant migrations 029
  (`span_nodes.ingested_at`) and 030 (first copy wins) for this; both are
  withdrawn, and billing needs neither.
- **`Timestamp` bounds the scan.** `span_nodes` is
  `PARTITION BY toDate(Timestamp)`. A call that ended in the range started at
  most an hour before it (the gateway gives up after 600 s, retries included),
  so `Timestamp > from − 1 hour AND Timestamp <= to` prunes the read to one or
  two day partitions. No filter uses a skip index, so there is no `SETTINGS`
  clause — the old `use_skip_indexes_if_final_exact_mode` pin went with
  `ingested_at`.
- **One tenant database, never `merge()` across landing and tenant.** The tenant
  table is a *copy* of landing; a union counts every routed span twice.
- **The sum is over deduplicated events.** Summing first and counting distinctly
  afterwards would charge twice for a span that appears twice. `any()` not
  `max()`, because copies carry the same cost and taking the larger would bias
  the invoice upward.
- **Cache hits excluded.** LiteLLM serves them from Redis with the full
  `total_cost` attribute still attached, while recording spend 0.
- **No `LIMIT`.** Aggregating removes the need — and the `LIMIT` was the only
  reason a read ever had to be resumable mid-millisecond.
- **Slug is validated** (`assertSlug`) because it becomes part of a database
  identifier and cannot be a bound parameter. It is the one injection surface
  in the read path.

### Pricing

`models/rate.ts` is the only place dollars and credits convert.

```
usdPerCredit       =  1 / CREDITS_PER_USD       default 1,000 credits per $1
usdToCredits(usd)  =  usd / usdPerCredit        spend → capture
creditsToUsd(c)    =  c   × usdPerCredit        grant → LiteLLM cap
```

`CREDITS_PER_USD` is read in `config/config.ts` and turned into the per-credit
rate at the ledger's ten places. `USD_PER_CREDIT`, the same rate stated per
credit, is still read when it is unset.

A credit is a **billing unit with a fixed dollar rate**, not an LLM token — that
is what makes a single rate possible at all. This service performs **no pricing
arithmetic**: LiteLLM stamps the customer-facing cost onto the span and this
sums that column.

Zero-cost usage never reaches Chargebee (it rejects a zero amount). It is
recorded as `SUCCESS` with amount 0 so the range is visible and the cursor moves.

---

## 4. Sending it

```
cursor ──▶ range ──▶ ClickHouse aggregate
                            │  event_count = 0  →  cursor moves to the range end, no row (advancePastEmptyWindow)
                            │  event_count > 0
                            ▼
              INSERT chargebee_sync (status PENDING, id = the operation id)
                            │        only while cursor = from, under the account row's lock
                            │
              UPDATE status = PROCESSING        ← committed BEFORE the wire
                            │
              POST /ledger_operations/capture   id = that row's id
                            │
              UPDATE status = SUCCESS, settled_at = now
                            │
              advance cursor (compare-and-set) to to_ingested_at
```

**The row commits before Chargebee is called.** After that — timeout, crash,
second worker — the range belongs to this row and no other, and the operation
id is fixed. A retry re-sends this row as stored; it never recomputes the range.

**The sync row's id IS the Chargebee ledger operation id.** One value in two
systems is what makes a retry settle instead of re-charge: after a lost response
the next tick asks `GET /ledger_operations/{id}` rather than guessing.

**The cursor moves only once the range is resolved** — `SUCCESS`, an empty
range, or `WRITTEN_OFF` (§5) — and only by compare-and-set from the value the
range opened at.

---

## 5. Retry and recovery

### The eight statuses

Each answers "what did Chargebee say" — never "where is the worker".

| Status | Resolved? | Meaning | Retry policy |
|---|---|---|---|
| `PENDING` | no | Written, **never on the wire** | every tick, **no lookup needed** |
| `PROCESSING` | no | On the wire, claimed by its sender. A crash leaves this | once the sender's **5-minute lease** is over, **lookup first** |
| `SUCCESS` | **yes** | Taken, already taken, or nothing chargeable | — cursor moves |
| `UNKNOWN` | no | Timeout, 5xx, bad credential, disabled site | every tick, lookup first |
| `RATE_LIMITING` | no | HTTP 429 — refused *before* being applied | 1 min doubling to 15 |
| `OUT_OF_CREDITS` | no | `ERROR_INSUFFICIENT_BALANCE` | **never while the account is `exhausted`** — the tenant is held whole, nothing sent or read; at once when a top-up, a renewal, credits added by hand (`grant_blocks_created`) or the daily resync takes it out of `exhausted` |
| `INVALID` | no | Bad data/config, incl. no prepaid ledger | 5 min doubling to 1 hour |
| `WRITTEN_OFF` | **yes** | `OUT_OF_CREDITS` or `INVALID` on a subscription that has **ended** (account cancelled, or moved to another subscription). Nothing was charged and nothing can be | never — logged once as `billing.sync.written_off`; cursor moves |

There is deliberately **no generic `FAILED`**. It answered "it did not work"
without saying which of four very different things happened, and each wants a
different response.

Backoff is derived from `updated_at + f(attempt_count)` — there is no
`next_attempt_at` column.

**`attempt_count` never converts an unknown into a failure.** Only Chargebee can
resolve an unknown; past `BILLING_MAX_ATTEMPTS` (default 10) the logging gets
louder and nothing else changes.

### Why PENDING and PROCESSING are different

`PROCESSING` is written **and committed** before the request leaves. So a row
still reading `PENDING` has *provably* never been sent, and can be sent without
the verification lookup. Everything else goes through `captureIdempotent()`,
which retrieves the id and sends only on a definite 404.

That halves the Chargebee calls on the happy path without weakening recovery
anywhere.

### Two callers on one tenant

The cron, the operator's manual `/api/internal/sync`, a second replica and an old
worker during a rollout can all run the same tenant at once. Three rules keep
them from sending one capture twice, measured live in L1 (C06x, C55):

- **Every send claims its row first** — `PROCESSING`, attempt + 1, by
  compare-and-set against the status and attempt count it was read with. Two
  callers that read the same `PENDING` or `UNKNOWN` row both try; one sends,
  the other is told the row is taken (`billing.sync.raced`).
- **A `PROCESSING` row is its sender's for `PROCESSING_LEASE_MS` (5 min).** From
  the row, a dead sender and one still waiting on Chargebee look the same, so
  the row is recovered only once its sender cannot still be alive — the longest
  send (lookup + capture + duplicate check, three 20 s attempts each) is about
  3½ minutes. Before this, a second caller took a row whose POST was still on
  the wire, got a 404 from its lookup and sent the same id again.
- **The answer is written only under the claim that sent it.** `markSuccess`
  and `markUnresolved` compare the status and attempt count too, so a caller
  whose claim was taken over (`billing.sync.claim_lost`) cannot turn the new
  owner's `SUCCESS` into anything else.

If all three are ever beaten (a host suspended for longer than the lease),
Chargebee refuses the second POST with `ERROR_DUPLICATE_OPERATION_ID`, which the
client confirms by lookup and settles as `replayed`. Before that code was
pinned it was `terminal`, and a charged range was held `INVALID` for 10–20
minutes.

Ranges of **different lengths** — which any two callers reading one cursor
produce, since a range runs to `now − lag` — are kept apart the same way: a row
is written only while the cursor still sits at its start (`openWindow`), and an
empty range is passed only while no row owns a range starting there
(`advancePastEmptyWindow`) — both under the account row's lock (§3).

### Crash recovery, by crash point

| Dies… | Left behind | Next tick |
|---|---|---|
| before the row commits | nothing | range read again from the cursor |
| after PENDING, before PROCESSING | `PENDING` | sent directly — id was never on the wire |
| after PROCESSING, before/during the send | `PROCESSING` | once the 5-min lease is over: **lookup**; found → SUCCESS, 404 → re-send **same id** |
| after Chargebee OK, before the SUCCESS write | `PROCESSING` | once the lease is over: lookup finds it → SUCCESS, no second charge |
| after SUCCESS, before the cursor advance | `SUCCESS`, cursor behind | insert collides, or the empty-range pass finds the row → **`cursor_repaired`** moves the cursor to the settled row's end |

That last path matters: the repair advances to the **settled row's** end, which
is usually not the range end the loop asked for — a later pass computes a later
`now − lag`. The loop follows the *committed* cursor, never its own arithmetic —
otherwise the in-memory cursor runs ahead of the stored one and every later
range overlaps one already billed.

### Chargebee's own retry layer

`withRetry` — **3 attempts**, exponential backoff `500ms × 2^n`, 20s request
timeout — retrying only what a retry could fix. A 429 is re-sent in place
(Chargebee refuses it before applying); a timeout or 5xx is **not**, because it
says nothing about whether the charge landed.

---

## 6. Chargebee API reference

The endpoints below are all plain REST with HTTP Basic (`api_key:`), 20s timeout. The
pinned SDK has no bindings for the prepaid-ledger endpoints, which is why this
is hand-rolled.

### Money

| Verb | Endpoint | Notes |
|---|---|---|
| POST | `/ledger_operations/capture` | **The usage charge.** `id` = our sync row id. `ledger_operation_timestamp` is always *now* — the API rejects anything older than 10 minutes — and the range travels in metadata (`ingested_from` / `ingested_to`, call end times despite the names) |
| POST | `/ledger_operations/allocate` | Top-up grant, and the free plan's one-time credits (`FREE_PLAN_CREDITS`) — on a zero-grant plan that allocate is what creates the credit wallet (MEASURED 2026-09-30). Accepts **no client-supplied id** and never returns the metadata sent with it, so it carries `chargebee-idempotency-key` (**30-minute window**, same request only) and a mandatory `expires_at`; the guard is `topup_grant` (§10 #1) |
| GET | `/ledger_operations/{id}` | **Recovery lookup.** A 404 with `resource_not_found` is the *only* answer meaning "never captured" |
| GET | `/ledger_operations` | Listing (`ledgerOperations`), read only by `scripts/e2e-prepaid.ts`. Filters are not uniformly honoured — it ignores `id[is]`, which is why recovery retrieves by id |

### Credits

| Verb | Endpoint | Notes |
|---|---|---|
| GET | `/grant_blocks` | **granted** credits. Filtered by `unit_id` and `isLiveGrantBlock()` |
| GET | `/ledger_account_balances` | **current** balance, from `provisioned_balance.usable_balance` |

### Subscription & customer

| Verb | Endpoint | Notes |
|---|---|---|
| POST | `/customers` | id = tenant UUID, so a retry collides instead of duplicating |
| GET | `/subscriptions` | Active subs for a customer, newest first |
| GET | `/subscriptions/{id}` | Status, term, `next_billing_at` for the Subscription card |
| POST | `/subscriptions/{id}/update_for_items` | Addon attach. **Refused mid-term when items carry credit grants** |
| POST | `/estimates/update_subscription_for_items` | Dry run. Takes `subscription[id]`, *not* `subscription_id` |

### Billing documents

| Verb | Endpoint | Notes |
|---|---|---|
| GET | `/transactions` | The Payments card, paged (`transactionsPage`, the one payments reader). The **only** place a failed payment is visible (`status`, `error_text`) |
| GET | `/invoices` | Paid-pack proof, filtered client-side on `line_items[].entity_id` |
| GET | `/invoices/{id}` | **Ownership check** before minting a download |
| POST | `/invoices/{id}/pdf` | Pre-signed S3 URL, expires — minted per request, never stored |
| GET | `/payment_sources` | Card on file (brand, last4, expiry) |

### Catalogue & checkout

| Verb | Endpoint | Notes |
|---|---|---|
| GET | `/item_prices/{id}` | Plan details. The free plan's price is checked to be **zero** before every subscribe |
| POST | `/customers/{id}/subscription_for_items` | **The free plan**, no checkout and no card — for an org it is for, at sign-up and as the billing page's fallback. `chargebee-idempotency-key: free-plan:<tenant>` |
| POST | `/invoices/create_for_charge_items_and_charges` | **Top-up**, charged onto the subscription and collected from the card on file. **Never retried** |
| POST | `/hosted_pages/manage_payment_sources` | *Update card*. `redirect_url` on port 80, 443, 8080 or 8443 only |
| POST | `/hosted_pages/checkout_new_for_items` | Paid-plan checkout, from the page's **Choose a plan** for an org with no plan. `redirect_url` = `APP_URL/organization/billing?from=checkout`; the page then syncs the new subscription at once |
| POST | `/portal_sessions` | Built, never rendered, and disabled on the test site. Refused by billing (409 `portal-off`) unless `CHARGEBEE_PORTAL_ENABLED=true`: customers must not be able to cancel |

### Units trap

`price`, `total`, `amount_paid`, `line_item.amount` are all in the currency's
**MINOR unit** — `1000000` with `INR` is ₹10,000.00. Dates are **epoch
seconds**. The UI's `formatPrice()` takes its divisor from `Intl`, not a
hardcoded 100, because zero-decimal currencies (JPY, KRW) quote in whole units.

### Inbound: the webhook

`POST /api/webhooks/chargebee` is the **only public path of billing**, and
Chargebee calls it directly: the load balancer has one exact-path, POST-only
rule for it (Caddy locally, with a pinned rewrite). crewpe-ui and
enginos-platform are not in the path — their webhook route, rewrite, controller
and guard were removed. `/api/internal/*` stays private: platform-only, and
unauthenticated. The URL set in Chargebee is
`https://<app host>/api/webhooks/chargebee` (prod
`https://app.enwithai.com/api/webhooks/chargebee`). A local tunnel must point at
Caddy's app host, never at billing's `:4300`, which would publish
`/api/internal/*`.

Chargebee does not sign webhooks, so the HTTP Basic credentials set on the
endpoint are its whole authentication, and billing checks them itself before
reading the body (`http/webhook-auth.ts`): `CHARGEBEE_WEBHOOK_USER` /
`CHARGEBEE_WEBHOOK_PASSWORD` in billing's env, compared in constant time. Either
unset → every delivery 401 `webhook-unauthorized` — unset reads as "off", never
as "open".

| Event | Billing does |
|---|---|
| `subscription_created` `_activated` `_changed` `_renewed` `_reactivated` `_resumed` `_cancelled` `_deleted` | `syncFromChargebee(tenant)`; the body is only a trigger (§10 #3) |
| `payment_succeeded`, invoice with a top-up line | `applyPaidTopUps`. 500 while a grant-carrying pack's block is not visible yet, so Chargebee redelivers |
| `grant_blocks_created` | For each subscription in `content.grant_blocks`: the org whose **current** subscription it is (`findTenantIdBySubscriptionId`) → `syncFromChargebee`. Credits added by hand in the Chargebee dashboard, and any other grant, move the LiteLLM limit — and reopen an exhausted team — within seconds instead of at the daily resync. A subscription that is no org's current one, or a `cbdemo_` one → logged `billing.webhook.grant_unlinked_subscription`, 200 |
| `payment_failed`, `alert_status_changed` | Logged only |
| anything else | 200, ignored |

An event whose customer id starts `cbdemo_` — Chargebee's **Test Webhook**
sample data — answers 200, logged `billing.webhook.sample_event`, and nothing
is done. An unknown **real** customer on an event billing acts on answers 500,
so Chargebee retries. No `id` or `event_type` → 400. A handler failure → 500
(§9).

---

## 7. The credit numbers on the billing page

How **"10,998.91 of 11,000 token-test remaining"** is produced. Two independent
Chargebee reads in parallel, then one subtraction. Nothing is stored locally.

```
GET /grant_blocks?subscription_id[is]=…&limit=100
    → filter unit_id = "token-test"
    → filter isLiveGrantBlock()     drops expired / invalidated / cancelled
                                    and anything past expires_at
    → sum granted_amount                       = 11,000      granted, allocated

GET /ledger_account_balances?subscription_id[is]=…&limit=1
    → provisioned_balance.usable_balance       = 10,998.91463   current

consumed = max(granted − current, 0)           = 1.08537
```

`11,000` is two live grant blocks: 10,000 from the plan's Credit Grant at
subscription creation, plus 1,000 from a top-up. `token-test` is the `unit_id`,
cached on `billing_account.ledger_unit_id`.

`isLiveGrantBlock()` is written the safe way round — a block is live unless it
*says* it is finished (`expired`/`invalidated`/`cancelled`/`deleted`) or its
`expires_at` has passed. A status Chargebee introduces later that means "gone"
would otherwise quietly inflate the figure.

**The clamp on `consumed` matters.** If a grant expires mid-term, `current` can
briefly exceed `granted`, and without it the page shows a negative number.

`allocated` and `granted` are currently the same value — a leftover from when
they differed.

The UI renders `formatCredits(current)` **of** `formatCredits(allocated)` + unit,
with `consumed` driving the progress bar.

### The other cards

| Card | Source |
|---|---|
| **Credit balance** | the above, plus `lastSync` from the newest `SUCCESS` row |
| **Subscription** | `GET /subscriptions/{id}` + `GET /payment_sources` — status, term, next renewal, card on file |
| **Payments** | `GET /transactions` — every charge and refund, with `error_text` on failures |

`payments: null` (Chargebee unreachable) renders *"Could not load payments"* —
**not** "No payments yet". Telling someone they have never been charged when you
simply failed to ask is the worst answer this page could give.

---

## 8. Enforcement — what actually refuses a request

Everything above is a **recorder**. It bills a minute or two behind (the lag
plus up to one sweep interval) and writes down what happened. Nothing in §§3–7 can stop an LLM call.

The gate is the **LiteLLM team's `max_budget`**, set by this service and metered
by the gateway in real time (`services/gateway-budget.service.ts`). Driving refusal from a remaining
balance instead would let a tenant overspend for a whole sync interval before
anything noticed.

### The cap

```
maxBudget = baseline + creditsToUsd(grantedCredits)
```

- `grantedCredits` comes from Chargebee's live grant blocks — the same
  `GET /grant_blocks` figure the page renders, so cap and display cannot drift.
- `baseline` is the team's spend **at the moment billing took it over**, stored
  in team metadata as `billing_spend_baseline`. Without it, spend accrued before
  the subscription would eat into the prepaid cap.
- `budget_duration` is sent as an explicit `null`, which also clears
  `budget_reset_at` — a prepaid cap must not roll over monthly.

Three metadata keys mark a team as ours: `billing_managed`,
`billing_spend_baseline`, and `billing_block_reason` when blocked.
enginos-platform leaves the budget of a `billing_managed` team alone: its
provisioning never writes it, and its plan reconciler does not count it as drift
(§10 #5). A team without the flag gets the platform's own budget — **$0, with no
reset** — so billing is the only thing that ever lets a team spend.

`push()` is idempotent: it recomputes the cap and writes only when it differs
(`capHeld`) or when it needs to unblock. `/team/update` **replaces metadata
wholesale**, so it merges rather than replaces.

### Blocking

`block()` sets `blocked: true` plus `billing_block_reason`. Two reasons:

| Reason | Set when | Cleared by |
|---|---|---|
| `activating` | The budget push FAILED after payment. The customer has paid, their credits exist in Chargebee, but the gateway does not hold the cap yet — so the team is blocked rather than left uncapped. Also: a free-plan org whose one-time credits (§11 `FREE_PLAN_CREDITS`) are still owed while it is out of credits or has no credit wallet yet | `activatePending()`, retried every minute by the cron — granting owed free credits first — until the push lands |
| `exhausted` | Chargebee reports no usable balance | The next successful push once credits return |

**Fail closed.** An `activating` account shows no credits on the page and its
team is blocked, because showing credits would promise service that is refused.
Nothing is lost — the credits are in Chargebee, only paused.

Blocking goes through `/team/update`, **not** `/team/block`: MEASURED on LiteLLM
1.98, `/team/block` writes the flag somewhere the read path does not see.

### What exhausts a tenant

`markExhausted()` in `usage-sync.service.ts` does two things, in order:

```ts
// 1. Postgres
UPDATE billing_account SET status = 'exhausted'
 WHERE tenant_id = :t AND status <> 'cancelled'

// 2. LiteLLM
blockBudget(tenantId, "exhausted")     → blocked: true, reason recorded
```

Two independent triggers:

| Trigger | Where | Condition |
|---|---|---|
| A capture **succeeded** and drained the balance | `usage-sync.service.ts` `send()` | `balanceAfter != null && !isBillable(balanceAfter)` |
| Chargebee **refused** for insufficient balance | `usage-sync.service.ts` `send()` | sync status → `OUT_OF_CREDITS` |

The first exists because the LiteLLM cap counts only what reaches the team,
whereas Chargebee is what the customer actually bought. The drawdown itself is
treated as authoritative, not just the refusal.

`WHERE status <> 'cancelled'` keeps a cancelled account from being flipped back
to `exhausted` — cancellation is terminal and outranks it.

**While `exhausted`, the tenant is held whole.** Every tick `holdExhausted()`
re-asserts the block and does nothing else: no Chargebee call, no ClickHouse
read. The usage waits in front of the cursor. Only `activate()` — a top-up, a
renewal, a subscription or `grant_blocks_created` webhook, the daily resync —
moves the account out of `exhausted`; the next tick then resolves the held range
first and bills on. Credits granted by hand in the Chargebee dashboard arrive as
`grant_blocks_created` (§6) and reopen the team within seconds; the daily resync
is the backstop for a webhook that never came.

**Blocking is best-effort, retried each tick.** If LiteLLM is unreachable, the
Postgres status still changes and the failure logs as
`billing.budget.block_failed`; the next tick's `holdExhausted()` blocks again.
A block already in place for the same reason is not re-written — re-asserting
it costs one `/team/info` read. A LiteLLM outage at that exact moment still
leaves a window where the account reads `exhausted` while the team is spending.

### Release on cancellation

`release()` strips `billing_managed`, `billing_spend_baseline`,
`billing_baseline_term` and `billing_block_reason` from the team metadata and
leaves the cap alone. The platform's reconciler then sees an unmanaged team
and sets the platform's budget, **$0**: a cancelled org can spend nothing until
it is subscribed again. Without this the team would keep the prepaid cap
forever, since no further grant would ever come to move it.

It also lifts **billing's own block** (`blocked: false`, sent whenever
`billing_block_reason` is on the team): the platform's reconciler never sends
`blocked`, so a team that was exhausted or held activating when the
cancellation arrived would otherwise stay blocked with nobody owning it. A team
blocked by hand carries no reason and is left blocked. A tenant with no LiteLLM
team (provisioning is fail-open) has nothing to release, and is not an error.

Every activation (a minute's retry, the gate check, a top-up) re-checks for a
cancellation after it writes to the gateway, and hands the team back again if
one landed meanwhile; no status write but a subscription link replaces
`cancelled`.

### If this layer is removed

Worth stating plainly, because it is the question most often asked of it:
**deleting the LiteLLM integration removes the only thing that refuses a
request.** `chargebee_sync` would still faithfully record `OUT_OF_CREDITS` and
hold the cursor, and the page would still show a zero balance — while the tenant
kept calling. The liability is unbounded, not merely delayed.

## 9. Failure behaviour

**The billing page degrades, never 500s.** Each read is independently caught:
`billing.page.credits_unreadable`, `.payments_unreadable`,
`.subscription_unreadable`. A page showing the balance without the payment list
is useful; a page that fails to load because Chargebee is slow is not.

**The webhook returns 500 on a handler failure.** There is no local claim row any
more, so acknowledging a failure would drop the event silently. (A bad or
missing credential is 401 before any handler runs — §6.) A non-2xx makes
Chargebee retry and surfaces a permanently failing webhook in **its** delivery
log — which is now the audit trail this service no longer keeps.

**Per-tenant failures never abort the sweep.** One broken subscription must not
stop everyone else's billing (`billing.sync.tenant_error`).

### Metrics worth alerting on

| Metric | Meaning |
|---|---|
| `billing.sync.behind` | Cursor >7 days back — revenue about to age out of ClickHouse's 90-day TTL |
| `billing.sync.site_disabled` / `.unauthenticated` | Stops **every** tenant at once; a person must fix it |
| `billing.sync.stuck` | One sync Chargebee has not answered about past `maxAttempts` |
| `billing.sync.out_of_credits` | Customer needs to top up |
| `billing.sync.cursor_repaired` | Cursor had fallen behind a settled range |
| `billing.sync.budget_spent` | A pass hit its 3-minute budget before reaching every org; the rest are billed next minute from their cursors. Every minute means the org count has outgrown one pass |
| `billing.invoice.ownership_denied` | A tenant asked for someone else's invoice — not a typo |
| `billing.free_plan.page_fallback_failed` / `.no_ledger_yet` | A new org is not on its free plan, or is on it with no credit unit yet — its usage is not billed until a sync finds the unit |
| `billing.free_credits.failed` / `.unresolved` | A free org's one-time credits were not granted this time. While it has no credits or no wallet it is held `activating` (team blocked) and the minute's `activatePending` retries |
| `billing.webhook.credentials_unset` / `.unauthorized` | Chargebee deliveries are refused with 401 — billing's webhook credentials are unset, or do not match the endpoint's |

### Sentry alerts (the worker)

`worker/alerts.ts` raises four alerts, each ONE Sentry issue however many tenants
and ticks raise it:

| Alert | Raised when |
|---|---|
| `postgres-down` | the database cannot be reached, on any call |
| `postgres-write-failed` | the database is up and refused a write |
| `chargebee-down` | Chargebee does not answer (5xx, timeout, network), refuses the key, or a sync is stuck |
| `chargebee-update-failed` | Chargebee refused a usage range (400, 404) |

Out of credits, rate limiting and every other error send nothing.
`npx tsx scripts/sentry-alerts-check.ts` fires every case against the Sentry
project in `.env` (tagged `environment=manual-check`) and passes only when
Sentry accepted the right alert: all fourteen passed on 2026-09-28.

What it does not cover:

- **The worker must have its settings.** Without `SENTRY_DSN` in its
  environment Sentry is off; the worker scripts load `.env` for that reason.
- **A Chargebee outage is seen only when the worker calls Chargebee**, which it
  does when there is usage to capture. A quiet minute raises nothing.
- **The API sends nothing to Sentry.** A Chargebee failure on the billing page
  or a top-up is logged, not alerted.

---

## 10. Known defects

Documented rather than omitted, because anyone operating this needs them.

### 1. ~~Top-up de-duplication does not work — metadata is never returned~~ — fixed 2026-09-24

`allocate()` wrote `metadata.invoice_id` as the durable "already granted" mark,
and **Chargebee accepts it on write and never returns it on read** — absent from
the list endpoint, from `GET /ledger_operations/{id}`, and from the key set
entirely; the grant block the allocation makes carries only
`{"done_by":"<api key name>"}`. So the guard matched nothing, a repeat `apply`
inside the 30-minute `chargebee-idempotency-key` window answered **502** (the
key had been used "for a different request": `expires_at` came from the clock),
and after it **granted the pack again**.

**The guard is now a local record, `topup_grant`** (migration
`20260924190000_topup_grant`, unique on `(tenant_id, invoice_id)`,
`account.service.ts` `applyPaidTopUps`). Chargebee keeps nothing reliable that
ties an allocation to its invoice, so this is the one fact about credits billing
has to remember itself:

| Row | What happens on `apply` |
|---|---|
| `APPLIED` | Nothing is sent or read beyond the invoice list: `{applied: 0}` |
| none | **Claimed** (`SENDING`) and committed **with the whole allocate request** (subscription, unit, credits, `expires_at`, key `invoice:<id>`), then allocated, then `APPLIED` with `ledger_operation:<id>` |
| `SENDING`, < 2 min old | Another caller is sending it — left alone, `{applied: 0}` |
| `PENDING` (failed / answer lost), or `SENDING` past its lease | Within 25 min of the key's first use: re-sent **byte for byte** under the same key — Chargebee replays the original grant instead of making a second. Past that the key is dead, so the subscription's grant blocks are searched for the allocation first: found → `APPLIED` (`grant_block:<id>`); certainly absent → re-sent under a new key `invoice:<id>:<n>`; block list cut short → nothing sent, `billing.topup.unresolved` for a person |

A crash anywhere leaves a row, so a paid pack can be delayed by a crash but
never granted twice and never forgotten. Invoices allocated **before** the table
existed are recorded by `20260924190100_topup_grant_seed_test_site` — test-site
invoice 85 (org_aws_com, operation `2082089592063869696`) and invoice 83
(org_fs_com, grant block `B0O7ADVVwa3sgD9`) — and it inserts nothing on any other
database. Any other environment that sold packs before this migration must
record its own the same way before the first `apply`.

### 2. ~~The top-up ledger scan scrolls off its own page~~ — fixed 2026-09-24

The guard was `ledgerOperations(subscriptionId, 100)` — one page of a ledger
that gains a capture a minute. Gone with #1: the local row neither expires nor
paginates away.

### 3. ~~The webhook trusts its request body~~ — fixed 2026-09-24

Every subscription event (`created`, `activated`, `changed`, `renewed`,
`reactivated`, `resumed`, `cancelled`, `deleted`) is now only a *trigger*: the
body names the customer, and the handler calls `syncFromChargebee(tenantId)`,
which applies what Chargebee says now. A late or replayed body can no longer
re-activate a cancelled account or rewind its term, and a cancellation cancels
the account only when the subscription it is linked to has ended (C43, C53).

### 4. ~~The top-up pack must NOT carry its own Credit Grant~~ — superseded 2026-09-28: it keeps its grant

The owner chose to keep Chargebee's Credit Grant on the top-up charge
(`api_token`, 50 `token-test` per ₹1 unit) rather than have billing allocate.
MEASURED on the test site, a charge with a grant is refused on every hosted or
subscription-update route mid-term — `checkout_one_time_for_items` ("Charges
with grants are not supported for customer one off charges"),
`checkout_existing_for_items` and `update_for_items`
(`mid_term_grant_subscription_change_not_allowed`) — and accepted only when
invoiced onto the subscription. So a top-up is now charged to the card on file
after the customer confirms the amount
(`POST /invoices/create_for_charge_items_and_charges`), Chargebee issues the grant
about a second after `paid_at`, and billing records it as a `catalogue_grant`
and moves the cap (`TOPUP_CHARGEBEE_GRANTS=true`). Billing never allocates for
such a pack, not even while the grant block is still on its way: that would be a
second grant once Chargebee's lands.

Two measured consequences shape the flow:

- **No hosted checkout for a top-up.** The page asks the customer to confirm the
  charge to their saved card instead.
- **Invoice first, pay later does not work.** Invoiced with
  `auto_collection=off`, the grant was issued at once for the UNPAID invoice,
  and voiding the invoice did not take it back.

Still true from before: the **1000 `token` credits on `16A6ReVW76FGuAc8`**
(org_aws_com, block `B0FYuUVW8TAKdE2`) are in a unit billing never reads.

### 5. ~~The platform re-applied its plan budget over billing's cap~~ — fixed 2026-09-28

enginos-platform's plan reconciler (`litellm-plan-reconcile.scheduler.ts`, every
minute) compared each team's `max_budget` with its own per-plan cap ($5 / 30d
free, $1000 / 30d paid) and "corrected" the difference — so a minute after
billing set a credit-based cap, every billed team was back to $5 with a monthly
reset (measured: `org_aa_com` set at 08:09:01, reverted at 08:10:02). The
platform never read `billing_managed`. Now its provisioning never writes a
`billing_managed` team's budget, its drift check ignores the budget of such a
team, and the platform's own budget for any other team is $0 with no reset.

### 6. ~~A new org was linked before its credit ledger existed~~ — fixed 2026-09-28

The free-plan subscribe linked the subscription within a second, and Chargebee
created the plan's grant block — and with it the ledger account — three seconds
later. The account came out `active` with no `ledger_unit_id`, and the usage
sync skips such an account, so the org's usage went unbilled until some later
sync filled the unit in. `provisionFreePlan` now re-syncs once a second, up to
ten times, until the unit is there. A free plan whose grant is cut to zero gets
no wallet from Chargebee at all: the free credits' allocate creates it within
the first sync, and the account adopts its unit (§11 `FREE_PLAN_CREDIT_UNIT`).

### 7. ~~An unpaid top-up still raised the cap~~ — fixed 2026-09-28

Chargebee issues a top-up's grant block with the invoice, not with the payment.
Two ways to get an unpaid invoice were measured (CHARGEBEE-API.md):

- **Autopay off.** With the subscription's `auto_collection` off, the charge
  came back `payment_due` with its credits granted. `chargeItem()` now always
  sends `auto_collection=on`, which was measured to collect at once.
- **A declined card.** The charge answers HTTP 200 with a `payment_due`
  invoice, not a payment error, and the block is `available` at once. Voiding
  the invoice does not take the block back.

**Decision: a failed payment adds no credits.** `unpaidTopUpCredits()` sums the
live blocks of every top-up invoice that is `payment_due`, `not_paid`, `voided`
or `pending`. They are subtracted from:

- the gateway cap (`paidGrantedCredits`, container/budget-hooks.ts);
- the page's granted and remaining figures (billing-overview.service.ts);
- the exhaustion check (`usableCredits`, account.service.ts).

The invoice is kept, so the money can still be collected:

- **Chargebee's retry**, 24 hours after the failure, on whatever card is then on
  file. Changing the card does not collect it.
- **Pay now** (`POST /api/internal/topup/pay-unpaid`, `payUnpaidTopUps`):
  `collect_payment` on each owed invoice, at once.

Either way `payment_succeeded` (or Pay now itself) records the pack, and the cap
moves to include it. **One top-up may be owed at a time**: another is refused
with 409 `topup-unpaid`, because Chargebee would charge each one when it
retries.

Not handled: when Chargebee's retries run out, the invoice becomes `not_paid`
and stays owed. What the site does then (leave it, or cancel the subscription)
is Chargebee's dunning setting, not billing's.

### Also worth knowing

- **A resubscription after a cancellation bills from the moment it is linked.**
  The cancelled period — free-plan usage — is never billed to the new
  subscription (the cursor restarts, forward only). The ~1–2 minutes of usage
  between the cursor and the cancellation itself (the lag plus up to one
  interval) is not billed either.
- **Credits roll over at a renewal.** The plan's Credit Grant is set to
  unlimited rollover in the catalogue: Chargebee moves an old block's unused
  balance into a new rollover block (`is_rollover: true`) instead of expiring
  it (`expired_amount` stays 0). The LiteLLM baseline moves at the term change
  so the headroom equals Chargebee's usable balance — rolled-over credits
  included. Not yet seen live; the first test-site renewal is `org_aa_com` on
  2026-10-25. The last lag + interval of the old term is paid from the new
  term's balance, since the capture API has no effective time.
- **A crash mid-capture costs up to 5 minutes** (the `PROCESSING` lease) before
  that tenant's billing resumes. Nothing is lost — the usage waits in front of
  the cursor.

- A subscription with **no prepaid ledger** is `INVALID` and **holds** the
  cursor. The usage waits and bills once the ledger exists; `billing.sync.behind`
  is the backstop.
- A **collector re-send** carries the same `Timestamp` and duration as the
  first copy, so it falls in the same range and is billed once — by the
  `GROUP BY` while that range is unbilled, and because it is behind the cursor
  afterwards (§3). No ClickHouse change is involved: tenant migrations 029 and
  030, which the earlier ingest-time design needed, are withdrawn. A **rebuild
  of `span_nodes` from `otel_traces`** keeps those times too, so it re-bills
  nothing behind the cursor; a range read while the table is being refilled
  misses whatever is not back yet, so stop the worker for one. The old
  `billed_usage_event` table, which remembered billed spans, was removed; ranges
  on call end times replace it without any state here.
- **A span that lands more than `BILLING_LAG_MS` after its call ended is never
  billed**: its range was read and the cursor moved on (§3). Measured: 1 of 421
  local spans at the 60 s default, 3 at 45 s.
- `TOPUP_CREDITS` is a **single global env var**, so exactly one pack size is
  supported. With `TOPUP_CHARGEBEE_GRANTS=true` it only sets the figure the page
  quotes — what is granted is the charge's Credit Grant — so the two must match.

---

## 11. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CREDITS_PER_USD` | `1000` | Credits that buy $1 of LLM spend. `.env`: `50`. `USD_PER_CREDIT` (per credit, default `0.001`) is read only when this is unset |
| `FREE_PLAN_ITEM_PRICE_ID` | empty | The plan an org it is for is put on at sign-up — no card, so it must cost zero (checked before every subscribe). Empty turns automatic subscription off |
| `FREE_PLAN_CREDITS` | empty | The **total** free credits each free-plan org starts with, granted **once** per org, ever. The plan's own Credit Grant is cut to zero (or a single token) in the catalogue, so a renewal grants nothing; billing allocates `FREE_PLAN_CREDITS` less what that grant gave (floor 0). An org the plan already gave at least that much (one put on it before the cut) is recorded as a `catalogue_grant` and allocated nothing. Guarded by a `topup_grant` row with invoice id `free-plan-credits` (key `free-plan-credits:<tenant>`); expires 10 years out (`FREE_PLAN_CREDITS_YEARS`); resubscribing grants nothing more. Runs in `syncSubscription` before `activate()`; while it is owed and the org is out of credits or has no wallet yet, `activate()` holds it `activating` (team blocked), and `activatePending` retries every minute. Requires `FREE_PLAN_CREDIT_UNIT`. Empty: off |
| `FREE_PLAN_CREDIT_UNIT` | empty | **Required** with `FREE_PLAN_CREDITS` (the configuration is refused without it): the credit unit the free credits go into, e.g. `token-test`. MEASURED 2026-09-30: a zero-grant plan gets **no** credit wallet (ledger account) from Chargebee; billing's allocate into this unit creates it, and the account adopts the unit (`adoptLedgerUnit`). An org whose wallet exists keeps its own unit |
| `FREE_PLAN_DEFAULT` | `false` | Whether an org with no setting of its own (`billing_account.free_plan` null) gets the free plan. One it is not for is offered the paid plans and cannot check out the free one. Per org: `POST /api/internal/free-plan {tenantId, enabled}` — **operators only**, never forwarded by the platform |
| `BILLING_LAG_MS` | `60000` | Only LLM calls that ended at least this long ago (by ClickHouse's clock) are read. Under `30000` (`MIN_LAG_MS`) — 0 included — the configuration is refused. `.env`: `45000`. MEASURED: a span lands p50 23 s, p99 44 s after its call ended; one landing later than the lag is never billed (§3) — [BILLING-WORKER.md](BILLING-WORKER.md) §6 |
| `BILLING_ALLOW_SHORT_LAG` | unset | `true` lifts the `BILLING_LAG_MS` floor. Tests only, against a local ClickHouse on a short clock; never anywhere real |
| `BILLING_MAX_RANGE_MS` | `3600000` | Longest range one Chargebee capture covers. A pass bills cursor → `now − lag` (ordinarily a minute); this bounds a catch-up, an hour at a time — and, since Chargebee refuses a capture larger than the balance whole, what an org that ran out mid-outage can have held. A pass starts no new range after 3 minutes (§3) |
| `BILLING_SWEEP_INTERVAL_MS` | `60000` | Time between usage-sync passes. The cron fires once a minute, so above `60000` it behaves as `60000`; under it, each run makes several passes (none after 45 s) — an option, not used. Usage reaches Chargebee about lag + up to one interval after the call ended: ~1–2 min with the defaults |
| `BILLING_MAX_ATTEMPTS` | `10` | Escalation threshold; never converts unknown → failure |
| `BILLING_PLAN_CACHE_TTL_MS` | `600000` | Plan catalogue cache; 0 disables |
| `TOPUP_ITEM_PRICE_ID` | `token-pack-5m-INR` | The top-up charge — an **item price** id (`api_token-INR`), not the item id |
| `TOPUP_CHARGEBEE_GRANTS` | `false` | `true` when the charge carries its own Credit Grant: Chargebee grants, billing only records (§10 #4). `false` with a grant would grant twice |
| `TOPUP_CREDITS` | `1000` | Credits per unit. With Chargebee granting, only the page's quote — must match the grant |
| `TOPUP_MAX_QUANTITY` | `100` | Most units one top-up may buy — a typo guard |
| `ITEM_PRICE_IDS` | empty | Plans besides the free one an org may be on. The free plan is **always** included. An org's current subscription is kept whatever this says |
| `APP_URL` | `http://localhost:4200` | Where Chargebee sends the browser back to. Chargebee accepts port 80, 443, 8080 or 8443 only, so locally the HTTPS dev origin |
| `CHARGEBEE_PORTAL_ENABLED` | `false` | The self-serve portal route answers 409 `portal-off` unless this is exactly `true`. Customers must not be able to cancel; set it only after "Allow customers to cancel subscriptions" is off in the site's Self-Serve Portal settings |
| `CHARGEBEE_WEBHOOK_USER` / `CHARGEBEE_WEBHOOK_PASSWORD` | empty | The HTTP Basic credentials set on Chargebee's webhook endpoint, checked by billing in constant time (§6). Either unset: every delivery 401 `webhook-unauthorized` |

> **Deployment note:** `BILLING_LAG_MS` is in **milliseconds**. `120` (meant as
> 120 s) or `0` is under the 30 s floor and is refused when the configuration
> loads — the worker stops at start — instead of silently undercounting ranges.
> A longer lag is always safe: it delays when usage reaches Chargebee, never
> what the gateway refuses. `BILLING_WINDOW_MS` and `BILLING_MAX_WINDOWS_PER_TICK`
> are removed; a value left in an environment is ignored.

### The crons

| Workflow | Schedule | Does |
|---|---|---|
| `billing-usage-sync` | `* * * * *` | The usage path, whole: held activations, then the usage sync (no new range after 3 minutes), then the gate check (bounded to 4 minutes into the 5-minute timeout). With several passes a minute, no pass starts after 45 s and the gate check stops at 55 s. `maxRuns: 1`, `CANCEL_NEWEST` |
| `billing-subscription-reconcile` | `11 2 * * *` | Re-reads every subscription, repairing state a lost webhook left stale |

Cadence is not freshness — a tick reads LLM calls that ended up to `now − lag`,
so usage reaches Chargebee about lag + up to one interval after the call ended
(~1–2 min with the defaults).
