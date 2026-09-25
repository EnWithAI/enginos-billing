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
   ClickHouse  tenant_<slug>.span_nodes       ReplacingMergeTree (TraceId, SpanId),
      │                                       keeps a span's FIRST copy (migration 030)
      │
      │   ── every 60s, Hatchet cron ──
      ▼
   enginos-billing worker
      │   read cursor → take one window → aggregate → record → charge → move cursor
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
3. What happened to each window it billed? — the **sync log**

---

## 2. Schema

Two tables. That is the whole of the usage-billing schema.

```
billing_account          tenant ↔ Chargebee mapping, AND the billing cursor
    │
    └── chargebee_sync   one row per billing window (1:N)
```

### `billing_account`

| Column | Type | Purpose |
|---|---|---|
| `tenant_id` | `uuid` PK | Logical FK to master `tenants` — deliberately **not** a Prisma relation, so migrations can never propose a change to a table this service does not own |
| `routing_slug` | `varchar(100)` UNIQUE | The ClickHouse database key: `tenant_<routing_slug>.span_nodes` |
| `chargebee_customer_id` | `varchar(100)` UNIQUE | **We supply this** — it is the tenant UUID. A retry collides on Chargebee's side rather than creating a second customer |
| `chargebee_subscription_id` | `varchar(100)` UNIQUE | Which subscription receives usage. *Which one that is* is decided in `models/subscription.ts`; the column stores only the answer |
| `chargebee_item_price_id` | `varchar(100)` | The plan bought. Carries the Credit Grant configuration |
| `ledger_unit_id` | `varchar(50)` | e.g. `token-test`. Required on every capture, so cached rather than fetched per minute |
| `billing_email` | `varchar(320)` | Captured at provisioning, before any User row exists |
| `current_term_start` / `_end` | `timestamptz` | Mirrored for display and for top-up expiry |
| `status` | `varchar(20)` | `unlinked` / `activating` / `active` / `cancelled` / `exhausted` |
| **`last_processed_ingested_at`** | `timestamptz(3)` | **THE CURSOR** — see below |
| `created_at` / `updated_at` | `timestamptz` | |

### `chargebee_sync`

One row per window **that contained usage**. An empty window moves the cursor
and writes nothing — a log of empty minutes is noise.

| Column | Type | Purpose |
|---|---|---|
| `id` | `uuid` PK | **Also the Chargebee ledger operation id.** Written before the capture is sent |
| `tenant_id` | `uuid` | FK → `billing_account`, ON DELETE CASCADE |
| `chargebee_subscription_id`, `ledger_unit_id` | | **Pinned at creation**, so a mid-term subscription change still settles against the subscription that incurred the usage |
| `from_ingested_at` | `timestamptz(3)` | Window start, **exclusive**. Equals the cursor it opened at |
| `to_ingested_at` | `timestamptz(3)` | Window end, **inclusive**. Always `from + BILLING_WINDOW_MS` |
| `status` | `varchar(16)` | One of eight — see §5 |
| `amount` | `decimal(20,10)` | Credits sent to Chargebee |
| `billed_usd` | `decimal(20,10)` | The dollar figure behind it |
| `event_count` | `integer` | Distinct `TraceId:SpanId` in the window |
| `error`, `attempt_count` | | Why it is not SUCCESS; sends attempted |
| `hatchet_run_id` | `varchar(100)` | Correlates back to the workflow run |
| `created_at`, `settled_at`, `updated_at` | `timestamptz(3)` | `updated_at` is what the backoff is measured from |

**Constraints that carry real weight** (several are in the migration SQL, not
in `schema.prisma` — Prisma cannot express partial/compound CHECKs):

| Object | What it prevents |
|---|---|
| `chargebee_sync_window_uq` UNIQUE `(tenant_id, from_ingested_at)` | **The mutex.** Two workers reading the same cursor collide here, so one range can never be sent under two operation ids |
| CHECK `to_ingested_at > from_ingested_at` | A zero-length window would claim a row and move the cursor nowhere |
| CHECK `SUCCESS ⟺ settled_at IS NOT NULL` | A resolved row with no settle time, or an unresolved one carrying one, is uninterpretable |
| `chargebee_sync_progress_idx`, `_status_idx` | Reading "last synced"; finding unresolved work across tenants |

### The cursor

`billing_account.last_processed_ingested_at` — the `span_nodes.ingested_at` up
to which this tenant is **fully billed**. The next window starts here.

It is **worker progress and nothing else**: not a Chargebee status, not a
payment status, not an event id. Set to `now()` at activation (create-only), and
thereafter moves only when the window in front of it resolves.

**Why it is a time, not a position.** It used to be the pair
`(ingested_at, TraceId:SpanId)`, because the read was a `LIMIT 5000` page of
events and a page ends on an arbitrary event inside a millisecond — several
spans routinely share one. Windows are now bounded by *times*, so a boundary
cannot fall inside a millisecond and there is nothing to tie-break.

**Event identity did not disappear, it moved.** Deduplication is the ClickHouse
query's job (`GROUP BY concat(TraceId, ':', SpanId)`). Two responsibilities, two
mechanisms:

```
cursor      →  which TIME RANGE
event key   →  which EVENTS are the same event
```

**Advancing is compare-and-set**, never a blind write:

```sql
UPDATE billing_account SET last_processed_ingested_at = <window end>
 WHERE tenant_id = :t AND last_processed_ingested_at = <window start>
```

A worker resumed after a long pause matches nothing and changes nothing, so it
cannot rewind a tenant's billing.

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
The explicit column is what lets an empty window advance and write nothing — at
the cost of two places that must agree, which is why the advance is a
compare-and-set and why the `cursor_repaired` path exists (§5).

All ten are **hand-authored SQL**, and most say so in a header comment. That is
not stylistic: correctness rests on partial unique indexes and compound CHECKs
that Prisma's schema language cannot express. `prisma migrate dev` reconciles
against `schema.prisma`, sees objects it did not model as drift, and drops
them — silently removing the guarantee that a window bills exactly once.

> **Apply with `prisma migrate deploy`, never `migrate dev`**, then
> `prisma migrate resolve` to record it.

---

## 3. Collecting the usage

### Choosing the window

```
to = cursor + BILLING_WINDOW_MS          default 60_000
process only if  to <= now − BILLING_LAG_MS
```

`now` is **ClickHouse's clock**, not ours — `ingested_at` is stamped by it, so
lag must be measured against it.

**The window end is a function of the start.** This is not cosmetic. If it were
`min(cursor + max, until)`, two workers reading the same cursor milliseconds
apart would compute *different* ends, and `chargebee_sync_window_uq` — keyed on
`from_ingested_at` — could not see them as the same window. One could charge
`(from, toB]` while the other advanced the cursor to `toA`, leaving the overlap
billed twice. With `to` derived from `from`, two workers either collide on the
index or agree exactly.

A window that does not yet fit inside the safe range is **left alone**. The
aggregate is taken once, so reading a window before its events have landed
undercounts it permanently.

Catch-up after an outage drains one window at a time, up to
`BILLING_MAX_WINDOWS_PER_TICK` (default 20) per tick.

### The query

One read per window, returning a count and a total — **not rows**:

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
    AND ingested_at >  {from:DateTime64(3)}
    AND ingested_at <= {to:DateTime64(3)}
  GROUP BY event_key
)
SETTINGS use_skip_indexes_if_final = 1, use_skip_indexes_if_final_exact_mode = 1
```

Load-bearing details:

- **`span_nodes`, never `otel_traces`.** `span_nodes` is a ReplacingMergeTree on
  `(TraceId, SpanId)` — a real per-span dedup key, and the event identity here.
- **`FINAL` keeps a span's FIRST copy, so a re-send cannot bill again.** A span
  the collector re-sends gets a second copy with a later `ingested_at`, often in
  a later window, after the first copy's window was billed. Tenant migration 030
  (enginos-platform `030_span_nodes_first_copy_wins.sql`) made the table's
  version column fall as `ingested_at` rises, so `FINAL` returns each span once,
  at its earliest `ingested_at`, and the re-send's window never sees it. The
  `GROUP BY` counts a span once *within* a window; the first-copy rule is what
  keeps it in *one* window, and it needs no billing state. Before 030 the last
  copy won and the re-send billed again (live case C12).
- **The window filter must see the copy `FINAL` chose.** With
  `use_skip_indexes_if_final_exact_mode = 0`, or with the `ingested_at` filter in
  `PREWHERE`, `FINAL` chooses among the window's own copies and the re-send
  bills again — both measured on ClickHouse 26.3. Exact mode is the server
  default since 25.6 and is pinned in the query anyway; an older server fails
  the read instead of double-billing. `usage-sync.test.ts` pins both.
- **One tenant database, never `merge()` across landing and tenant.** The tenant
  table is a *copy* of landing; a union counts every routed span twice.
- **`ingested_at`, and no `Timestamp` predicate at all.** The worker polls for
  usage that has *become available*, not usage that happened. A span can land
  long after the call it describes; a cursor on span time would skip it forever.
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
usdToCredits(usd)  =  usd / USD_PER_CREDIT      default 0.001
```

A credit is a **billing unit with a fixed dollar rate**, not an LLM token — that
is what makes a single rate possible at all. This service performs **no pricing
arithmetic**: LiteLLM stamps the customer-facing cost onto the span and this
sums that column.

Zero-cost usage never reaches Chargebee (it rejects a zero amount). It is
recorded as `SUCCESS` with amount 0 so the window is visible and the cursor moves.

---

## 4. Sending it

```
cursor ──▶ window ──▶ ClickHouse aggregate
                            │  event_count > 0
                            ▼
              INSERT chargebee_sync (status PENDING, id = the operation id)
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
second worker — the window belongs to this row and no other, and the operation
id is fixed.

**The sync row's id IS the Chargebee ledger operation id.** One value in two
systems is what makes a retry settle instead of re-charge: after a lost response
the next tick asks `GET /ledger_operations/{id}` rather than guessing.

**The cursor moves only on SUCCESS**, and only by compare-and-set from the value
the window opened at.

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
| `OUT_OF_CREDITS` | no | `ERROR_INSUFFICIENT_BALANCE` | **every tick** — a top-up must clear it at once |
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
pinned it was `terminal`, and a charged window was held `INVALID` for 10–20
minutes.

Windows of **different lengths** (a deploy that changes `BILLING_WINDOW_MS` while
the old worker still runs) are kept apart the same way: a window is written only
while the cursor still sits at its start, and an empty window is passed only
while no row owns a window starting there — both under the account row's lock.

### Crash recovery, by crash point

| Dies… | Left behind | Next tick |
|---|---|---|
| before the row commits | nothing | window read again |
| after PENDING, before PROCESSING | `PENDING` | sent directly — id was never on the wire |
| after PROCESSING, before/during the send | `PROCESSING` | once the 5-min lease is over: **lookup**; found → SUCCESS, 404 → re-send **same id** |
| after Chargebee OK, before the SUCCESS write | `PROCESSING` | once the lease is over: lookup finds it → SUCCESS, no second charge |
| after SUCCESS, before the cursor advance | `SUCCESS`, cursor behind | insert collides → **`cursor_repaired`** moves the cursor to the settled row's end |

That last path matters: the repair advances to the **settled row's** end, which
is not necessarily the window end the loop asked for (they differ if
`BILLING_WINDOW_MS` changed between deploys). The loop follows the *committed*
cursor, never its own arithmetic — otherwise the in-memory cursor runs ahead of
the stored one and every later window misaligns.

### Chargebee's own retry layer

`withRetry` — **3 attempts**, exponential backoff `500ms × 2^n`, 20s request
timeout — retrying only what a retry could fix. A 429 is re-sent in place
(Chargebee refuses it before applying); a timeout or 5xx is **not**, because it
says nothing about whether the charge landed.

---

## 6. Chargebee API reference

20 endpoints, all plain REST with HTTP Basic (`api_key:`), 20s timeout. The
pinned SDK has no bindings for the prepaid-ledger endpoints, which is why this
is hand-rolled.

### Money

| Verb | Endpoint | Notes |
|---|---|---|
| POST | `/ledger_operations/capture` | **The usage charge.** `id` = our sync row id. `ledger_operation_timestamp` is always *now* — the API rejects anything older than 10 minutes — and the range travels in metadata |
| POST | `/ledger_operations/allocate` | Top-up grant. Accepts **no client-supplied id** and never returns the metadata sent with it, so it carries `chargebee-idempotency-key` (**30-minute window**, same request only) and a mandatory `expires_at`; the guard is `topup_grant` (§10 #1) |
| GET | `/ledger_operations/{id}` | **Recovery lookup.** A 404 with `resource_not_found` is the *only* answer meaning "never captured" |
| GET | `/ledger_operations` | Listing. Filters are not uniformly honoured — it ignores `id[is]`, which is why recovery retrieves by id |

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
| GET | `/transactions` | The Payments card. The **only** place a failed payment is visible (`status`, `error_text`) |
| GET | `/invoices` | Paid-pack proof, filtered client-side on `line_items[].entity_id` |
| GET | `/invoices/{id}` | **Ownership check** before minting a download |
| POST | `/invoices/{id}/pdf` | Pre-signed S3 URL, expires — minted per request, never stored |
| GET | `/payment_sources` | Card on file (brand, last4, expiry) |

### Catalogue & checkout

| Verb | Endpoint | Notes |
|---|---|---|
| GET | `/item_prices/{id}` | Plan details, and the checkout currency |
| POST | `/hosted_pages/checkout_new_for_items` | Subscribe |
| POST | `/hosted_pages/checkout_one_time_for_items` | Top-up. **Requires `currency_code`** |
| POST | `/portal_sessions` | Built, never rendered, and disabled on the test site. Refused by billing (409 `portal-off`) unless `CHARGEBEE_PORTAL_ENABLED=true`: customers must not be able to cancel |

### Units trap

`price`, `total`, `amount_paid`, `line_item.amount` are all in the currency's
**MINOR unit** — `1000000` with `INR` is ₹10,000.00. Dates are **epoch
seconds**. The UI's `formatPrice()` takes its divisor from `Intl`, not a
hardcoded 100, because zero-decimal currencies (JPY, KRW) quote in whole units.

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

Everything above is a **recorder**. It polls a minute behind and writes down
what happened. Nothing in §§3–7 can stop an LLM call.

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
`billing_spend_baseline`, and `billing_block_reason` when blocked. The platform's
own plan reconciler treats a cap without `billing_managed` as drift and restores
the plan budget, which is how release works — see below.

`push()` is idempotent: it recomputes the cap and writes only when it differs
(`capHeld`) or when it needs to unblock. `/team/update` **replaces metadata
wholesale**, so it merges rather than replaces.

### Blocking

`block()` sets `blocked: true` plus `billing_block_reason`. Two reasons:

| Reason | Set when | Cleared by |
|---|---|---|
| `activating` | The budget push FAILED after payment. The customer has paid, their credits exist in Chargebee, but the gateway does not hold the cap yet — so the team is blocked rather than left uncapped | `activatePending()`, retried every minute by the cron, until the push lands |
| `exhausted` | Chargebee reports no usable balance | The next successful push once credits return |

**Fail closed.** An `activating` account shows no credits on the page and its
team is blocked, because showing credits would promise service that is refused.
Nothing is lost — the credits are in Chargebee, only paused.

Blocking goes through `/team/update`, **not** `/team/block`: MEASURED on LiteLLM
1.98, `/team/block` writes the flag somewhere the read path does not see.

### What exhausts a tenant

`markExhausted()` in `usage-sync.ts` does two things, in order:

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
| A capture **succeeded** and drained the balance | `usage-sync.ts:552` | `balanceAfter != null && !isBillable(balanceAfter)` |
| Chargebee **refused** for insufficient balance | `usage-sync.ts:575` | sync status → `OUT_OF_CREDITS` |

The first exists because the LiteLLM cap counts only what reaches the team,
whereas Chargebee is what the customer actually bought. The drawdown itself is
treated as authoritative, not just the refusal.

`WHERE status <> 'cancelled'` keeps a cancelled account from being flipped back
to `exhausted` — cancellation is terminal and outranks it.

**Blocking is best-effort and not retried on its own.** If LiteLLM is
unreachable, the Postgres status still changes and the failure logs as
`billing.budget.block_failed`. The next tick's capture reaches `markExhausted`
again and retries there — so a LiteLLM outage at that exact moment leaves a
window where the account reads `exhausted` while the team is still spending.

### Release on cancellation

`release()` strips `billing_managed`, `billing_spend_baseline`,
`billing_baseline_term` and `billing_block_reason` from the team metadata and
leaves the cap alone. The platform's reconciler then sees an unmanaged team
whose budget does not match its plan, and restores the plan budget. Without
this the team would keep the prepaid cap forever, since no further grant would
ever come to move it.

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
more, so acknowledging a failure would drop the event silently. A non-2xx makes
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
| `billing.sync.cursor_repaired` | Cursor had fallen behind a settled window |
| `billing.invoice.ownership_denied` | A tenant asked for someone else's invoice — not a typo |

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

### 4. The top-up pack must NOT carry its own Credit Grant — owner action in Chargebee

**MEASURED on the test site (2026-09-24):** both pack item prices,
`test-top-up-INR` and `token-pack-5m-INR`, carry a **Credit Grant of their own**
on their charge item, into unit **`token`**, while the plan
(`pre-paid-test-v1-INR-*`) grants into **`token-test`**. Two things follow:

- **No customer can buy a pack.** `checkout_one_time_for_items` refuses it:
  *"Charges with grants are not supported for customer one off charges"*.
  Billing now answers that as **409 `topup-misconfigured`**
  (`billing.topup.pack_carries_grant`) instead of a generic 502.
- **A pack paid another way is granted twice over, in the wrong unit.** Invoice
  85 was paid through a subscription-level charge: Chargebee granted 1000 into
  `token` (block `B0FYuUVW8TAKdE2`), and billing — before this fix — allocated
  1000 more into `token-test`. The `token` credits are never drawn by the usage
  sync and never counted in the LiteLLM cap; `token` also appeared as a second
  ledger account on the subscription, listed **first**, which is what broke
  `balance()` (fixed: it now reads the account's own unit — C57b).

**What the owner must change in the Chargebee catalogue** (Product Catalog →
Items → Charges):

1. Open the charge item **`test-top-up`** (item price `test-top-up-INR`) and
   **remove its Credit Grant** (the entitlement/credit-grant configuration on the
   charge that grants units of `token`). Do the same for **`token-pack-5m`**
   (`token-pack-5m-INR`) if it stays in the catalogue. The pack must be a plain
   one-off charge; billing grants its credits itself with
   `/ledger_operations/allocate`, into the account's `ledger_unit_id`
   (`token-test`), for `TOPUP_CREDITS` credits.
2. Keep **one-time checkout** enabled (Settings → Configure Chargebee → Checkout
   & Self-Serve Portal) — it is what `startTopUp` opens.
3. Decide what to do with the **1000 `token` credits already on
   `16A6ReVW76FGuAc8`** (org_aws_com, block `B0FYuUVW8TAKdE2`): billing will never
   use them. Void them, or leave them; nothing reads that unit. Invoice 85 is
   recorded as applied, so its pack is not granted a third time.
4. Set `TOPUP_ITEM_PRICE_ID` to the **item price** id — `test-top-up-INR`, not
   the item id `test-top-up`, which answered *"No currency for item price
   test-top-up"* (C57c).

**The code is safe with either setup.** If a pack DOES carry its own grant and
is paid anyway, its grant block names the invoice's pack line
(`billing_metadata.line_items[].id`): billing records the invoice as a
`catalogue_grant` and **allocates nothing**. Into the account's unit it counts
as applied and the gateway cap moves; into another unit it raises
`billing.topup.catalogue_grant_wrong_unit` for the owner, once, and still
allocates nothing — a second grant for one payment is never the remedy.

### Also worth knowing

- **A resubscription after a cancellation bills from the moment it is linked.**
  The cancelled period — free-plan usage — is never billed to the new
  subscription (the cursor restarts, forward only). The ~2–3 minutes of usage
  between the cursor and the cancellation itself (the lag) is not billed either.
- **At a renewal, the last lag + window of the old term is paid from the new
  term's grant.** The capture API has no effective time and the old block has
  already expired. The LiteLLM baseline moves to the team's spend at the term
  change, so that sliver is not counted against the new headroom; if the
  customer spends the whole new grant, Chargebee refuses the overflow
  (`OUT_OF_CREDITS`) and the team is blocked.
- **A crash mid-capture costs up to 5 minutes** (the `PROCESSING` lease) before
  that tenant's billing resumes. Nothing is lost — the usage waits in front of
  the cursor.

- A subscription with **no prepaid ledger** is `INVALID` and **holds** the
  cursor. The usage waits and bills once the ledger exists; `billing.sync.behind`
  is the backstop.
- A **collector re-send** of a span whose window was already billed is not
  billed again once platform migration 030 has run on the tenant: `span_nodes`
  keeps the first copy, so the span stays in its first window (§3). On a tenant
  still before 030 the last copy wins and the re-send bills again. What 030 cannot
  cover: a span whose earlier copies were already merged away before 030 ran
  keeps the copy it has, and a **rebuild of `span_nodes` from `otel_traces`**
  (the way platform migration 005 once did it) gives every row a new
  `ingested_at`, so everything past the cursor would bill again. Never rebuild
  it that way. The old `billed_usage_event` table, which remembered billed
  spans, was removed; 030 replaces it without any state here.
- `TOPUP_CREDITS` is a **single global env var**, so exactly one pack size is
  supported. A second size requires deriving credits from the item price.

---

## 11. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `USD_PER_CREDIT` | `0.001` | 1,000 credits = $1.00 of LLM spend |
| `BILLING_LAG_MS` | `120000` | Only usage ingested this long ago is read |
| `BILLING_WINDOW_MS` | `60000` | Window length. **Fixed** — see §3 |
| `BILLING_MAX_WINDOWS_PER_TICK` | `20` | Catch-up bound |
| `BILLING_MAX_ATTEMPTS` | `10` | Escalation threshold; never converts unknown → failure |
| `BILLING_PLAN_CACHE_TTL_MS` | `600000` | Plan catalogue cache; 0 disables |
| `TOPUP_ITEM_PRICE_ID` / `TOPUP_CREDITS` | | The one top-up pack and its credits. An **item price** id (`test-top-up-INR`), not the item id; the pack must carry no Credit Grant of its own (§10 #4) |
| `ITEM_PRICE_IDS` | | **Allowlist**, not a menu — every checkout request is checked against it |
| `CHARGEBEE_PORTAL_ENABLED` | `false` | The self-serve portal route answers 409 `portal-off` unless this is exactly `true`. Customers must not be able to cancel; set it only after "Allow customers to cancel subscriptions" is off in the site's Self-Serve Portal settings |

> **Deployment note:** `BILLING_LAG_MS` is in **milliseconds**. A value of `120`
> is 120ms, not 120 seconds, and makes the worker read up to the present instant,
> racing ClickHouse inserts. The symptom is silently undercounted windows.

### The crons

| Workflow | Schedule | Does |
|---|---|---|
| `billing-usage-sync` | `* * * * *` | The usage path, whole: held activations, then the usage sync, then the gate check (bounded to 4 minutes into the 5-minute timeout). `maxRuns: 1`, `CANCEL_NEWEST` |
| `billing-subscription-reconcile` | `11 2 * * *` | Re-reads every subscription, repairing state a lost webhook left stale |

Cadence is not freshness — a tick reads usage ingested up to `now − lag`.
