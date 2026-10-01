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

A fourth, `currency_switch`, is not usage billing either: one row per currency
switch — an org whose billing address moved it to another currency, carried
from its subscription to a new one in that currency. It is the stored request
for each capture the switch makes (see **`currency_switch`** below).

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
only the four tables below: it shows what `prisma/schema.prisma` models. They are not in a tenant database: the usage sync sweeps
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
| `billing_country` | `varchar(2)` | NULL | The country of the billing address the org saved (ISO 3166-1 alpha-2, upper case; CHECK `billing_account_billing_country_check`). The one part of the address kept here, because it decides the currency the org is billed in (`models/currency.ts`); the address itself is on the Chargebee customer. Written only by the billing address sync (`setBillingCountry`), which reads it from Chargebee — never from a request. Null until the org saves one: the page then sells nothing and asks for the address. Added by `20261001120000_billing_currency`. |
| `currency` | `varchar(3)` | NULL | The linked subscription's currency (ISO 4217, upper case; CHECK `billing_account_currency_check`), mirrored from Chargebee's `currency_code` at every link — and set to the new one by a currency switch's link. Chargebee fixes it for the life of a subscription. Not backfilled: null on a row linked before it existed, and readers fall back to the live subscription's `currency_code` until the next sync stores it. Added by `20261001120000_billing_currency`. |
| `topup_charging_until` | `timestamptz(3)` | NULL | A top-up charge (or Pay now) is on the wire until then: the charge lease, `now + 2 min`, taken under the row's lock in the same transaction that checks no currency switch is open, and cleared when the charge is recorded. A switch does not START while it is live, and no charge starts while a switch is open — so a pack is never charged onto a subscription a switch is about to empty. A lease, not a lock: a process that dies mid-charge leaves it to run out. Added by `20261001130000_currency_switch_carry`. |
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
| `switching` | A currency switch is moving the org's credits to a subscription in another currency. No usage range is opened or sent, no top-up is charged, no subscription sync relinks it, and nothing but the switch may change the row. The team keeps the cap it had, so the org keeps working. The billing page reads only the database. Set and ended by the switch (`currency_switch`); one left here with no switch moving it is put back by the worker. Added to the CHECK by `20261001120000_billing_currency`. |

---

## `chargebee_sync`

One row per billing window that contained usage. **An empty window moves the
cursor and writes nothing** — a log of empty minutes is noise, and the cursor
already records that the minute passed.

| Column | Type | Null | Purpose |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | **PK**, and ALSO the Chargebee ledger operation id. Written before the capture is sent. |
| `tenant_id` | `uuid` | NOT NULL | FK to `billing_account` ON DELETE CASCADE. |
| `chargebee_subscription_id` | `varchar(100)` | NULL | Pinned at creation, so a mid-term subscription change still settles against the subscription that incurred the usage. One exception: a currency switch's link re-pins the rows A never applied (`PENDING`, `OUT_OF_CREDITS`, `INVALID`) to B, in the same transaction (`repointHeld`), since A is emptied and cancelled. Rows on the wire or unsure are never re-pinned — a switch does not start while any exist. |
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
| `invoice_id` | `varchar(100)` | no | The paid Chargebee invoice — or `free-plan-credits` (`FREE_PLAN_GRANT`) for the free plan's one-time grant, or `carry:<switch id>:<grant block id>` for a currency switch's copy of one grant block onto the new subscription. |
| `chargebee_subscription_id`, `ledger_unit_id` | `varchar` | no | Where the credits went — pinned at the claim, so a retry completes against the same place. |
| `credits` | `decimal(20,10)` | no | Credits granted (or, for a catalogue grant, granted by Chargebee). |
| `expires_at`, `idempotency_key`, `key_issued_at` | | yes | The allocate request, stored before its first send so a retry is the same request; `key_issued_at` bounds Chargebee's 30-minute replay. Key `invoice:<id>`, or `free-plan-credits:<tenant>` with `expires_at` about 10 years out for the free plan's row, or the carry id itself for a switch's copy, with the copied block's own expiry. Null only for a catalogue grant. |
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

**A currency switch's copies.** Each live grant block on the old subscription
is copied to the new one by one allocate, under its own row
`carry:<switch id>:<block id>` (`allocateOnce`): claimed with the whole request
before it is sent, and decided by reading the row again afterwards — `APPLIED`,
or the switch waits. So a block is copied once, whatever crashes. The switch's
abort is allowed only while no row of it is `APPLIED`.

`20260924190100_topup_grant_seed_test_site` records the two test-site invoices
allocated before the table existed (85 on org_aws_com, 83 on org_fs_com), and
inserts nothing anywhere else.

---

## `currency_switch`

One row per currency switch. Migrations `20261001120000_billing_currency`
(the table, and `billing_account.billing_country`, `.currency` and the
`switching` status) and `20261001130000_currency_switch_carry` (`held_back`,
`own_grant`, `to_subscription_at`, `lease_owner`, `activated_at`, and
`billing_account.topup_charging_until`). Both are additive. The model is
`CurrencySwitch`; the code is `repositories/currency-switch.repository.ts`,
and the state machine `services/currency-switch.service.ts`.

**Why it exists.** Chargebee fixes a subscription's currency, and keys its
credit ledger per subscription. An org on the free plan whose saved billing
country wants another currency (India → INR, elsewhere → USD) is therefore
moved to a new subscription, **B**, on that currency's free plan, from its old
one, **A**: every live grant block of A is copied to B (allocates, guarded by
`topup_grant` carry rows), A is drained to zero (a capture), A's consumption is
captured on B (the mirror) so B shows the same granted, used and left, and
only then is billing relinked to B and A cancelled. A paid plan never
switches.

**Why a row.** A capture takes a client-supplied operation id. The drain's and
the mirror's id and amount are written here **before** they are sent, and
re-sent only under that id, so a crash, a timeout or two advancers at once can
delay a switch but never move money twice — the same rule as `chargebee_sync`.

| Column | Type | Null | Meaning |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | **PK.** B's subscription id is made from it: `cs_<id without dashes>`. |
| `tenant_id` | `uuid` | NOT NULL | FK → `billing_account`, `ON DELETE RESTRICT`, as for `topup_grant`. |
| `from_subscription_id` | `varchar(100)` | NOT NULL | A: the subscription the org was billed on when the switch was asked for. |
| `from_currency`, `to_currency` | `varchar(3)` | NOT NULL | Both ISO 4217, upper case, and different (CHECK `currency_switch_currencies`). |
| `to_item_price_id` | `varchar(100)` | NOT NULL | The plan B is made on: `FREE_PLAN_ITEM_PRICE_ID_<to_currency>`. |
| `to_subscription_id`, `to_subscription_at` | `varchar(100)`, `timestamptz(3)` | NULL | B, and when it was created or adopted. Set once, together (CHECK `currency_switch_to_subscription_dated`). B's own plan grant is read only 10 s after `to_subscription_at`. |
| `ledger_unit_id` | `varchar(50)` | NULL | The account's credit unit when MOVING started; every carry, drain and mirror is in it. Null: A had no wallet, and nothing is moved. |
| `status` | `varchar(16)` | NOT NULL | See below. |
| `drained` | `decimal(20,10)` | NOT NULL, dflt 0 | Credits captured off A by drains that settled. |
| `held_back` | `decimal(20,10)` | NOT NULL, dflt 0 | Credits on A that belong to top-up invoices not settled (a voided pack's grant stays on A). Never carried — so a pack nobody paid for never becomes paid credits on B — and taken off what the mirror counts. Recorded once, before the first drain. |
| `own_grant` | `decimal(20,10)` | NOT NULL, dflt 0 | What B's own plan granted on creation (MEASURED: 1 credit on a new free-plan subscription), netted out of the mirror and of the LiteLLM cap, so switching back and forth mints nothing. Recorded once, before the mirror; above zero it is logged `billing.currency_switch.target_plan_grants`. |
| `drain_operation_id`, `drain_amount` | `uuid`, `decimal(20,10)` | NULL | A drain on the wire, or of unknown outcome — both or neither (CHECK `currency_switch_drain_complete`). Added to `drained` when it settles; dropped only when Chargebee answers its id 404. |
| `mirror_operation_id`, `mirror_amount`, `mirrored_at` | `uuid`, `decimal(20,10)`, `timestamptz(3)` | NULL | The capture on B that carries A's consumption: Σ live granted on B − max(`drained` − `held_back`, 0). Stored before it is sent, and recorded once (CHECK `currency_switch_mirror_complete`). Never clamped: a negative figure stops the switch for a person. |
| `lease_until`, `lease_owner` | `timestamptz(3)`, `uuid` | NULL | One advancer at a time, for 5 minutes (`SWITCH_LEASE_MS`); owner and time together (CHECK `currency_switch_lease_complete`). Every write of an advancing switch compares the status **and** `lease_owner`, so an advancer whose lease was taken over writes nothing more. |
| `attempt_count` | `integer` | NOT NULL, dflt 0 | Advances that stopped on something. |
| `error` | `text` | NULL | What it is waiting on, or why it was abandoned: `timed_out`, `country_changed`, `chargebee_refused`, `misconfigured`, `account_changed`, `no_customer`. |
| `created_at`, `updated_at` | `timestamptz(3)` | NOT NULL | `updated_at` is also when an ABANDONED switch ended — only DONE sets `completed_at`. |
| `moving_at`, `linked_at` | `timestamptz(3)` | NULL | When it started moving; when billing moved to B. |
| `activated_at` | `timestamptz(3)` | NULL | When the org's LiteLLM cap moved to B. From here the switch blocks no top-up; cancelling A is a background chore. Only while LINKED or DONE, and DONE only with it (CHECK `currency_switch_activated_when_linked`). |
| `completed_at` | `timestamptz(3)` | NULL | Set iff DONE (CHECK `currency_switch_done_when_completed`). |

### `status` values

| Value | Open? | Meaning |
|---|---|---|
| `REQUESTED` | yes | Asked for — by the billing address sync, a `customer_changed` webhook, or the worker's convergence. B may already be made (unlinked, harmless). Nothing else has changed. Waits while the org owes or is receiving anything: an unpaid or pending top-up, free credits being set up, a top-up charge (`topup_charging_until`) or a usage capture on the wire. Abandoned after 30 minutes (`timed_out`), or once the country no longer wants `to_currency` (`country_changed`). |
| `MOVING` | yes | Started, in one transaction under the account row's lock: the account `switching`, `ledger_unit_id` recorded. Carry, drain, rescan, mirror. Aborted to ABANDONED only while no money has moved — the account then goes back to A, and B is cancelled. |
| `LINKED` | yes | Billing points at B — the account's subscription, item price, unit, `currency` and term — and the `chargebee_sync` rows A never applied are re-pinned to B, in one transaction. Then the cap moves (`activated_at`), and A is cancelled. |
| `DONE` | no | Finished. |
| `ABANDONED` | no | Given up before anything moved. The page is told it failed for a day, unless the org changed its country back. |

### Indexes and constraints

| Object | What it prevents |
|---|---|
| `currency_switch_open_uq` UNIQUE `(tenant_id)` WHERE `status IN ('REQUESTED','MOVING','LINKED')` | Two open switches for one org, each carrying its credits somewhere. A partial index Prisma cannot express — apply with `prisma migrate deploy`, never `migrate dev`. |
| `currency_switch_status_idx` `(status)` | The worker's minute: every open switch. |
| CHECK `status_check`, `currencies`, `amounts_nonneg`, `carry_nonneg` | The obvious ones; amounts are credits, never negative. |
| CHECK `moving_when_started`, `linked_to_b`, `settled_when_linked` | A row cannot claim a step it did not take: LINKED only with B, no drain outstanding, and the mirror (if any) settled. |
| CHECK `drain_complete`, `mirror_complete`, `lease_complete`, `to_subscription_dated`, `activated_when_linked`, `done_when_completed` | Values written together stay together. |

**Never delete a row.** An open one is money in flight; a finished one is the
record of where an org's credits went.

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
re-reads which top-up invoices are paid. `customer_changed` reads the
customer's billing address back from Chargebee — never from the body — and
only for an org that has saved one on its billing page. Nothing in a body is written as it
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
