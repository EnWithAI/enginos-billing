# Billing schema reference

Every table, every column, and what actually reads and writes it.

**Two tables carry usage billing**, and that is the whole of the architecture:

```
billing_account          which Chargebee customer and subscription a tenant is,
    │                    AND how far the billing worker has got — the cursor
    │
    └── chargebee_sync   one row per billing window (1:N)
```

A third table, `topup_grant`, is not usage billing: it is the grant guard —
one row per paid top-up invoice, so each pack is granted exactly once, plus one
row per tenant, ever, for the free plan's one-time credits (see
**`topup_grant`** below). `processed_billing_event`, the webhook claim row, was
removed — see **Webhook replays** at the end.

Nothing here lives in ClickHouse, and billing adds or changes nothing there:
usage is read from `tenant_<slug>.span_nodes FINAL` as it is. The `*_ingested_at`
column names below are kept from when they held ClickHouse's ingest time; they
now hold **call end times** (`Timestamp + duration_ms`), and billing reads no
`ingested_at` column.

These tables live in the **master** database (`enginos_master`), beside `tenants`
and `org_llm_gateways` — billing has no database of its own. The API, the worker
and Prisma Studio connect through PgBouncer (`DATABASE_URL`, `localhost:6432`,
role `enginos_app`); migrations go straight to Postgres (`DATABASE_DIRECT_URL`,
`localhost:5432`, role `enginos_owner`, via `make db-migrate`), because the app
role cannot create tables. Prisma Studio (`make db-studio`, or `make dev`) shows
only the three tables below: it shows what `prisma/schema.prisma` models. They are not in a tenant database: the usage sync sweeps
every tenant each tick, and finding billable accounts by opening N tenant
databases would be both slow and racy.

The schema is **additive**. It declares no model for `tenants` or `org_llm_gateways`
— those belong to enginos-platform. `tenant_id` and `routing_slug` are carried as
plain columns with no Prisma relation, specifically so `prisma migrate` can never
propose a change to a table this service does not own. Reads against those tables
go through `$queryRaw` for the same reason.

## The two rules that explain the design

**1. This service keeps no financial state.** There is no balance, no credit
ledger, no record of what was billed, and no copy of what the customer was
granted. Chargebee holds all of it, and is asked whenever anyone needs to know:
`/ledger_account_balances` for the balance, `/grant_blocks` for the grant,
`/ledger_operations` for the history.

**2. Progress and outcome are separate columns in separate tables.**

```
billing_account.last_processed_ingested_at   WHERE THE WORKER IS
chargebee_sync.status                        WHAT CHARGEBEE SAID
```

They were one thing in the previous schema — progress was `max(cursor_to)` over
the capture rows whose status happened to be settled — and the conflation cost
more than it saved. "How far has the worker got" could only be answered by
interpreting Chargebee outcomes, and an idle minute could not move the cursor
without writing a row to move it with.

What Postgres answers is therefore narrower and unambiguous:

1. **Who is this tenant in Chargebee?** — `billing_account`
2. **Where did the usage poller stop?** — `billing_account.last_processed_ingested_at`
3. **What happened to each window it billed?** — `chargebee_sync`

### Units

A credit is worth `1 / CREDITS_PER_USD` dollars (default 1,000 credits = $1), always. Amounts on the wire
to Chargebee carry ten decimal places, which is exactly its ledger precision, so
nothing rounds in transit. `chargebee_sync.amount` is what was SENT, not a
balance: no money is stored here.

---

## `billing_account`

One row per tenant: identifiers, the operational status that decides what the
gateway enforces, and the billing cursor.

| Column | Type | Null | Purpose |
|---|---|---|---|
| `tenant_id` | `uuid` | NOT NULL | **PK.** Logical FK to master `tenants.tenant_id`, deliberately not declared as a Prisma relation. |
| `routing_slug` | `varchar(100)` | NOT NULL | **UNIQUE.** Denormalised from `org_llm_gateways.routing_slug`. Copied rather than joined because the gateway row is created fail-open and may not exist at all, and because this is the key the ClickHouse query needs: `tenant_<routing_slug>.span_nodes`. |
| `chargebee_customer_id` | `varchar(100)` | NULL | **UNIQUE.** We supply this ourselves (the tenant UUID) instead of letting Chargebee generate it — that makes customer creation idempotent, since a retry collides on Chargebee's side instead of creating a second customer. |
| `chargebee_subscription_id` | `varchar(100)` | NULL | **UNIQUE.** The subscription usage is billed against. WHICH one that is, when a customer has several, is decided in [`models/subscription.ts`](../src/models/subscription.ts); this column stores the answer and models none of the alternatives. Also how a `grant_blocks_created` webhook, which names no customer, finds its org (`findTenantIdBySubscriptionId`): only the CURRENT subscription matches. |
| `chargebee_item_price_id` | `varchar(100)` | NULL | The item price the subscription was created from. It carries the Credit Grant configuration. Rendered on the billing page. |
| `ledger_unit_id` | `varchar(50)` | NULL | The credit unit from `ledger_account_balances.unit_id`, e.g. `"token"`. Required on every capture, so it is cached here rather than fetched once a minute per tenant. A free plan that grants zero gets no Chargebee wallet and so no unit to read; billing's allocate of the free credits creates the wallet, and the unit is then set by `adoptLedgerUnit` — only while this is null, and only for the current subscription. |
| `billing_email` | `varchar(320)` | NULL | Billing contact on the Chargebee customer. Captured at provisioning from the admin email, because no `User` row exists yet at that point. |
| `free_plan` | `boolean` | NULL | Is this org put on the free plan (or offered the paid plans instead)? Null follows `FREE_PLAN_DEFAULT`. Set by an operator (`POST /api/internal/free-plan`); an org already on the plan keeps it when this is turned off. Added by `20260929120000_billing_account_free_plan`. |
| `current_term_start` | `timestamptz` | NULL | Mirrored from the subscription, for display and for the expiry date a top-up allocation requires. |
| `current_term_end` | `timestamptz` | NULL | As above. |
| `status` | `varchar(20)` | NOT NULL, dflt `unlinked` | See states below. |
| `last_processed_ingested_at` | `timestamptz(3)` | NULL | **THE CURSOR** — a call end time, despite the name. See below. |
| `created_at` | `timestamptz` | NOT NULL, dflt now() | |
| `updated_at` | `timestamptz` | NOT NULL | `@updatedAt`. |

**Index:** `status` — the sync sweeps by status each tick.

**Deliberately absent**, and each for the same reason: `granted_credits`,
`budget_usd`, `cached_balance_credits`, `cached_balance_at`, `sync_from`. The
first four are Chargebee's numbers; `sync_from` is replaced by the cursor, laid
when the subscription is linked.

### `last_processed_ingested_at` — the cursor

The **call end time** — `addMilliseconds(Timestamp, duration_ms)` in
`span_nodes` — up to which this tenant is **fully billed**. The next range
starts here. A call is billed by when it ENDED, because that is when its span
is written; a range is read only once it is `BILLING_LAG_MS` in the past
(60 000 by default, never under 30 000), so the spans of calls that ended in it
have landed. A span that lands later than the lag is behind the cursor and is
never billed.

It is worker progress and **nothing else**: not a Chargebee status, not a payment
status, not a subscription status, not an event id. It is set to `now()` when the
subscription is linked (`ensureBillingCursor`, create-only), moved forward to
`now()` once when an account comes back from a cancellation (`restartCursorAt`,
forward only), and otherwise moves only when the range in front of it has been
resolved.

**Why it is a TIME and not a position.** It used to be the pair
`(ingested_at, TraceId:SpanId)`, because the read was a `LIMIT 5000` page of
events and a page ends on an arbitrary event inside a millisecond — several spans
routinely share one, and a bare `>` on the timestamp would have dropped the rest
of that millisecond for ever. Windows are now bounded by times the worker picks,
so a boundary cannot fall inside a millisecond and there is nothing to tie-break.

**Event identity did not go away; it moved.** Deduplication is the ClickHouse
query's job and uses `GROUP BY concat(TraceId, ':', SpanId)` — the same pair
`span_nodes` is keyed on. Two responsibilities, two mechanisms:

```
cursor      →  which TIME RANGE
event key   →  which EVENTS are the same event
```

**Advancing is compare-and-set**, never a blind write:

```sql
UPDATE billing_account
   SET last_processed_ingested_at = <window end>
 WHERE tenant_id = :t
   AND last_processed_ingested_at = <window start>
```

A worker resumed after a long pause matches nothing and changes nothing, so it
cannot rewind a tenant's billing to where it remembers.

The two writes that START from the cursor are guarded the same way, and under
the account row's lock (a compare-and-set of the cursor onto itself):
`openWindow` writes a `chargebee_sync` row only while the cursor still equals
the row's `from_ingested_at`, and `advancePastEmptyWindow` moves the cursor over
an empty range only while it still sits at the start **and** no row owns that
start. Two workers reading one cursor a moment apart compute different ends;
with both writes serialised on that lock, exactly one of them bills or passes
the range, and the other finds the cursor gone and backs off.

### `status` values

Defined in [`src/models/account-status.ts`](../src/models/account-status.ts) as `ACCOUNT`. These are
*operational* states — what the gateway should be enforcing — not financial ones.

| Value | Meaning |
|---|---|
| `unlinked` | A billing row exists; no subscription. Brief: the free plan is subscribed at sign-up, and again by the billing page for an org still here. |
| `activating` | Subscribed, but the LiteLLM budget push has not landed — or, on the free plan, its one-time credits (`FREE_PLAN_CREDITS`) have not. The team is BLOCKED and the page shows no credits, because showing them would promise service that is refused. Retried every minute. |
| `active` | Subscribed, and the gateway holds the cap. |
| `cancelled` | Subscription ended. The team is handed back to the platform, whose budget for it is $0. |
| `exhausted` | Chargebee reports no usable balance. The team is blocked; the cursor stops moving until credits return. |

---

## `chargebee_sync`

One row per billing window that contained usage. **An empty window moves the
cursor and writes nothing** — a log of empty minutes is noise, and the cursor
already records that the minute passed.

| Column | Type | Null | Purpose |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | **PK**, and ALSO the Chargebee ledger operation id. Written before the capture is sent. |
| `tenant_id` | `uuid` | NOT NULL | FK to `billing_account` ON DELETE CASCADE. |
| `chargebee_subscription_id` | `varchar(100)` | NULL | Pinned at creation, so a mid-term subscription change still settles against the subscription that incurred the usage. |
| `ledger_unit_id` | `varchar(50)` | NULL | As above. |
| `from_ingested_at` | `timestamptz(3)` | NOT NULL | Range start on call end time, EXCLUSIVE. Equals the cursor the range opened at, which is why the uniqueness index is on it. |
| `to_ingested_at` | `timestamptz(3)` | NOT NULL | Range end on call end time, INCLUSIVE: `now − lag` when the range was opened, at most `from + BILLING_MAX_RANGE_MS` (default 1 h). Stored, so a retry re-sends exactly this range under this row's id and never recomputes it. |
| `status` | `varchar(16)` | NOT NULL | See below. |
| `amount` | `decimal(20,10)` | NOT NULL, dflt 0 | Credits sent to Chargebee. |
| `billed_usd` | `decimal(20,10)` | NOT NULL, dflt 0 | The dollar figure behind it, for the billing page. |
| `event_count` | `integer` | NOT NULL, dflt 0 | Distinct `TraceId:SpanId` in the window. |
| `error` | `text` | NULL | Why it is not `SUCCESS`. |
| `attempt_count` | `integer` | NOT NULL, dflt 0 | Sends attempted for this row. Sets the backoff; never converted into a failure. |
| `hatchet_run_id` | `varchar(100)` | NULL | Correlates the row back to the workflow run that created it. |
| `created_at` | `timestamptz(3)` | NOT NULL | |
| `settled_at` | `timestamptz(3)` | NULL | Set iff `SUCCESS`, and enforced that way by a CHECK. |
| `updated_at` | `timestamptz(3)` | NOT NULL | `@updatedAt`. The backoff is measured from it. |

**Deliberately absent:** `provider_usd` and `margin_usd` (written but never read),
`chargebee_operation_id` (the `id` IS the operation id — a second column for it
is a copy that can disagree), and `balance_after` (a cached Chargebee number
nothing reads back; see §22).

### Indexes and constraints

| Object | What it prevents |
|---|---|
| `chargebee_sync_window_uq` UNIQUE `(tenant_id, from_ingested_at)` | **The important one.** One row per range start, so one range can never be sent under two operation ids. A constraint, not a lease, because a lease is a value a caller can forget to check. Two workers from one cursor compute different ENDS, which the index alone cannot see; `openWindow` and `advancePastEmptyWindow` (above) close that, so they cannot both bill it. |
| `chargebee_sync_progress_idx` `(tenant_id, to_ingested_at DESC)` | Reading "last synced" and finding the oldest unresolved row. |
| `chargebee_sync_status_idx` `(status)` | Finding every unresolved sync across tenants. |
| CHECK `window_order` — `to > from` | A zero-length window would claim a row and move the cursor nowhere. Strict, unlike the position-pair range it replaces. |
| CHECK `settled_when_success` | `SUCCESS` ⟺ `settled_at IS NOT NULL`. A resolved row with no settle time, or an unresolved one carrying one, is a state nothing can interpret. |
| CHECK `status_check`, `amounts_nonneg` | The obvious ones. |

### `status` values

Defined in [`src/models/sync-status.ts`](../src/models/sync-status.ts) as `SYNC`. These are states of the
**Chargebee operation** — never of the cursor.

| Value | Resolved? | Meaning, and what happens next |
|---|---|---|
| `PENDING` | no | Written, not yet sent. The id has provably never been on the wire, so recovery may send it **without a lookup**. |
| `PROCESSING` | no | On the wire, claimed by one sender. A crash leaves this. Left to its sender for a 5-minute lease, then resolved by `GET /ledger_operations/{id}`, never by a blind re-send. |
| `SUCCESS` | **yes** | Chargebee took it, confirmed it already had, or there was nothing chargeable. The cursor moves to `to_ingested_at`. |
| `UNKNOWN` | no | Timeout, 5xx, rejected credential, disabled site. Same treatment as `PROCESSING`: ask, do not guess. Retried every tick. |
| `RATE_LIMITING` | no | HTTP 429. Refused *before* it was applied, so it needs no lookup — just a backoff: 1 min doubling to 15. |
| `OUT_OF_CREDITS` | no | `ERROR_INSUFFICIENT_BALANCE`. Never retried on a timer: **while the account is `exhausted`** the sync does not reach the row at all. New credits (a top-up, a renewal, a grant made by hand) take the account out of `exhausted` and the row is due at once, with no requeue step. |
| `INVALID` | no | Rejected for bad data or configuration, including a subscription with no prepaid ledger. Backoff 5 min doubling to 1 hour, so a corrected configuration heals itself within the hour without anyone touching the database. |
| `WRITTEN_OFF` | **yes** | An `OUT_OF_CREDITS` or `INVALID` row whose subscription has **ended** — the account is cancelled, or now bills another subscription. No top-up or renewal can reach it, so it is given up once (`billing.sync.written_off`, an error naming the amount) and the cursor moves past it. Never settled: `settled_at` stays null. Added by `20260924120000_chargebee_sync_written_off`. |

There is no generic `FAILED`. It answered "it did not work" without saying which
of those four very different things happened, and they want four different
responses.

### When the cursor and the log disagree

Splitting progress from outcome buys a cursor that an idle minute can move, and
costs two places that can be inconsistent. There is exactly one way in: a range
resolves but its cursor advance does not land. The worker repairs it rather than
wedging — the window index refuses the insert (or the empty-range advance finds
a row owning the start), the existing row is read, and if it is resolved
(`SUCCESS` or `WRITTEN_OFF`) the cursor is moved to THAT row's `to_ingested_at`,
not to the end this worker computed (`billing.sync.cursor_repaired`). Without
that, every tick would read the same range, collide, and give up for ever.

### What moves the cursor, and what does not

| Outcome | Cursor | Row |
|---|---|---|
| Capture accepted, or replayed | → `to_ingested_at` | `SUCCESS` |
| Nothing billable in the window | → `to_ingested_at` | `SUCCESS`, amount 0 |
| Empty range | → the range's end, unless a row owns its start | **none written** |
| Throttled | **unchanged** | `RATE_LIMITING` |
| Unknown (timeout, 5xx, bad key, disabled site) | **unchanged** | `UNKNOWN` |
| Insufficient credits | **unchanged** | `OUT_OF_CREDITS` |
| Malformed request, or no prepaid ledger | **unchanged** | `INVALID` |

---

## `topup_grant`

One row per paid top-up invoice this service has acted on, and one per tenant,
ever, for the free plan's credits. Migration `20260924190000_topup_grant`; the
model is `TopUpGrant`; the code is `repositories/topup-grant.repository.ts`,
`applyPaidTopUps` and `grantFreePlanCredits`.

| Column | Type | Null | Meaning |
|---|---|---|---|
| `id` | `uuid` | no | Row id. |
| `tenant_id` | `uuid` | no | FK → `billing_account`, `ON DELETE RESTRICT` — deleting an account row must fail while it has guard rows, not take the guard with it. |
| `invoice_id` | `varchar(100)` | no | The paid Chargebee invoice — or `free-plan-credits` (`FREE_PLAN_GRANT`) for the free plan's one-time grant. |
| `chargebee_subscription_id`, `ledger_unit_id` | `varchar` | no | Where the credits went — pinned at the claim, so a retry completes against the same place. |
| `credits` | `decimal(20,10)` | no | Credits granted (or, for a catalogue grant, granted by Chargebee). |
| `expires_at`, `idempotency_key`, `key_issued_at` | | yes | The allocate request, stored before its first send so a retry is the same request; `key_issued_at` bounds Chargebee's 30-minute replay. Key `invoice:<id>`, or `free-plan-credits:<tenant>` with `expires_at` about 10 years out for the free plan's row. Null only for a catalogue grant. |
| `status` | `varchar(16)` | no | `SENDING` (claimed, allocate on the wire) · `PENDING` (may have landed; retried) · `APPLIED`. |
| `source` | `varchar(20)` | no | `allocation` — billing allocated it — or `catalogue_grant`: the pack's (or the free plan's) own Credit Grant already did it and nothing was allocated. |
| `chargebee_ref` | `varchar(120)` | yes | The proof: `ledger_operation:<id>` or `grant_block:<id>`. |
| `operation_at` | `timestamptz(3)` | yes | When Chargebee made the grant (the allocation's `created_at`, the same second as its grant block's). How the guard tells this row's block from another's when it searches for an allocation whose answer was lost. |
| `attempt_count`, `error` | | | Sends attempted; the last failure. |
| `created_at`, `updated_at`, `applied_at` | `timestamptz(3)` | | `updated_at` is the claim's lease (2 minutes). |

**Constraints:** `topup_grant_invoice_uq` UNIQUE `(tenant_id, invoice_id)` — the
guard; `APPLIED ⟺ applied_at AND chargebee_ref`; an `allocation` row always
carries its request; a `catalogue_grant` row is always `APPLIED`. Never delete
a row: a paid pack invoice with none is granted again.

**The free plan's credits.** The free plan is yearly and a plan's own Credit
Grant comes again at every renewal, so the plan's grant is cut to zero (or a
single token) in the catalogue and billing grants `FREE_PLAN_CREDITS` (the total per org, once)
itself, the first time the org is linked to the plan. It allocates
`FREE_PLAN_CREDITS − what the plan's own grant gave`, floor 0; when the plan
already gave that much, the row is recorded as `catalogue_grant` from its block
and nothing is allocated. A zero-grant plan gets no Chargebee wallet, so the
allocate goes into `FREE_PLAN_CREDIT_UNIT` (required with `FREE_PLAN_CREDITS`),
creates the wallet, and `billing_account.ledger_unit_id` then adopts that unit.
Until the row is `APPLIED` the account is held `activating`.

`20260924190100_topup_grant_seed_test_site` records the two test-site invoices
allocated before the table existed (85 on org_aws_com, 83 on org_fs_com), and
inserts nothing anywhere else.

## Webhook replays

There is **no webhook table**. `processed_billing_event` claimed each Chargebee
event id before any work, and it is gone.

**A redelivery, or a replayed OLD body, is harmless, because the body is only a
trigger.** Every `subscription_*` event re-reads the customer's subscriptions
from Chargebee (`syncFromChargebee` — the same pull the post-checkout callback
and the daily reconcile run) and applies what Chargebee says now, so a late
event finds the state that followed it. `grant_blocks_created` names no
customer: the org is found by its CURRENT subscription
(`findTenantIdBySubscriptionId`) and re-read the same way. `payment_succeeded`
re-reads which top-up invoices are paid. Nothing in a body is written as it
stands; it only decides WHICH org is re-read, and it is exactly as trustworthy
as the HTTP Basic credentials billing checks on it.

The writes that are not convergent on their own are guarded where they live:

| Write | Guard |
|---|---|
| `ensureBillingCursor` | Create-only: `WHERE last_processed_ingested_at IS NULL`. A replayed activation cannot rewind the cursor to `now()` and skip every call that ended since. (`restartCursorAt`, on a resubscription after a cancellation, only ever moves it forward.) |
| `applyPaidTopUps` | A `topup_grant` row per invoice, claimed with the whole allocate request before it is sent; a retry re-sends that exact request under the same `chargebee-idempotency-key`. A paid pack grants once. (It used to scan the ledger for `metadata.invoice_id`, which Chargebee never returns.) |
| `grantFreePlanCredits` | The tenant's `free-plan-credits` row in `topup_grant`, claimed the same way. A replayed subscription event re-runs the link, finds the row, and grants nothing. |

**One behaviour change came with it:** a failing handler now returns **500**, not
200 — an unknown real customer included (Chargebee's `cbdemo_` Test Webhook
samples get 200, nothing done). The claim row used to be the durable record
that something needed attention; with no row, acknowledging a failure would
drop the event silently.
Chargebee retries a non-2xx and surfaces a permanently failing webhook in its own
delivery log, so **Chargebee's delivery log is now the audit trail** this service
no longer keeps.

**What is genuinely given up:** per-tenant webhook history in our database, and
the `unmapped customer` marker. Both now live only in the logs and in Chargebee's
dashboard. Chargebee still does not sign webhooks and calls billing DIRECTLY —
`POST /api/webhooks/chargebee` is billing's only public path, and enginos-platform
is not on it. HTTP Basic, checked by billing's webhook route itself against
`CHARGEBEE_WEBHOOK_USER` / `CHARGEBEE_WEBHOOK_PASSWORD` (either unset → 401), is
the only authentication, so rotate those credentials like a password and
rate-limit /api/webhooks/chargebee at the edge. Billing's /api/internal/* routes
check nothing and must stay off the public network.
