# enginos-billing

Prepaid credit billing. An org the free plan is for is put on it the moment it
is created — no checkout, no card — and every other org chooses a paid plan;
either way Chargebee grants it credits, and customers buy more as top-ups. Every minute a Hatchet cron reads what they actually spent from
ClickHouse and captures it against those credits in Chargebee, and the LiteLLM
gateway refuses service once the credits are gone.

Two processes from one image, plus Prisma Studio to look at the tables:

```bash
make dev         # all three in one terminal, lines tagged [api] [worker] [studio];
                 # Ctrl-C stops all three. Refuses while :4300 or :5555 is taken.
make dev-api     # only the API on :4300 (webhooks + internal routes) — npm run dev
make dev-worker  # only the Hatchet worker (the cron sweep)       — npm run worker
make db-studio   # only Prisma Studio on :5555 — billing's three tables
make test        # vitest, no external services needed          — npm test
make help        # everything else (setup, db-migrate, check, …)
```

Next.js loads `.env` for the API; the worker scripts load it with
`--env-file-if-exists=.env` (a container that injects its environment has no
`.env` and is unaffected). A worker started any other way — plain
`tsx worker/hatchet-worker.ts` — runs with none of its settings: no Chargebee,
no database, and no Sentry, so it can raise no alerts.

## The database

Billing has no database of its own. Its three tables — `billing_account`,
`chargebee_sync`, `topup_grant` — live in the **shared master database,
`enginos_master`**, beside the platform's (`tenants`, `org_llm_gateways`, …).
Two connections, both in `.env`:

| Variable | Goes to | Role | Used by |
|---|---|---|---|
| `DATABASE_URL` | PgBouncer `localhost:6432` → `enginos_master` (`?pgbouncer=true&connection_limit=1`) | `enginos_app` | the API, the worker, **Prisma Studio** |
| `DATABASE_DIRECT_URL` | Postgres `localhost:5432` → `enginos_master` (session mode) | `enginos_owner` | **migrations only** (`make db-migrate` = `prisma migrate deploy`) — the app role cannot create tables |

**Prisma Studio shows only billing's three tables**: it shows the models in
`prisma/schema.prisma`, and billing's schema models only those, although the
database holds the platform's tables too. For the platform's, run Studio in
`enginos-platform` instead.

## The whole flow

```
LLM call → LiteLLM → OpenTelemetry → ClickHouse tenant_<slug>.span_nodes
                                              │
                                      every 1 minute
                                              ▼
      read billing_account.last_processed_ingested_at (a call end time)
                                              │
        range = (cursor, min(now − lag, cursor + BILLING_MAX_RANGE_MS)]
                                              │
                  SELECT count(), sum(cost) … GROUP BY TraceId:SpanId
                                              │
                          INSERT chargebee_sync (PENDING)
                                              │
                              POST /ledger_operations/capture
                                              │
                                    status = SUCCESS
                                              ▼
                              cursor ← the range's end
```

Two tables in PostgreSQL carry usage billing:

```
billing_account   which Chargebee customer/subscription a tenant is,
                  AND how far the worker has got — the cursor
chargebee_sync    one row per billed range, and what Chargebee said
```

and a third, `topup_grant`, is the top-up guard: one row per paid top-up
invoice, so a pack is granted exactly once. Chargebee keeps nothing that ties an
allocation to its invoice (the metadata sent with it is never returned), so
this one fact has to live here — docs/BILLING-ARCHITECTURE.md §10.

Those are two separate questions and they are deliberately two separate columns:

```
billing_account.last_processed_ingested_at   WHERE THE WORKER IS
chargebee_sync.status                        WHAT CHARGEBEE SAID
```

## Plans, top-ups and cards

- **The free plan, automatically — for the orgs it is for.** When
  enginos-platform creates an org it calls `POST /api/internal/provision`, and
  billing subscribes the org's Chargebee customer to `FREE_PLAN_ITEM_PRICE_ID`
  — no checkout, no card, and only ever a plan the catalogue prices at zero. It
  waits for Chargebee's credit ledger (about three seconds) before calling the
  org set up. The billing page does the same for any org it finds with no
  subscription.
- **The free plan's credits are granted once.** It is a yearly plan, and a
  plan's own Credit Grant comes again at every renewal, so the plan's grant is
  cut to zero (or a single token) in the catalogue and billing grants the
  credits itself the first time the org is linked to the plan.
  `FREE_PLAN_CREDITS` is the TOTAL each free org starts with: billing
  allocates it less whatever the plan's own grant gave, exactly once per org
  (a `topup_grant` row, `free-plan-credits`), with an expiry 10 years out.
  MEASURED: a zero-grant plan gets no credit wallet from Chargebee — the
  allocate into `FREE_PLAN_CREDIT_UNIT` (required with `FREE_PLAN_CREDITS`)
  creates it, and the account adopts that unit. Until the credits land the org
  is held `activating` and the minute's cron retries. An org the plan already
  gave at least that much is recorded and allocated nothing.
- **Who gets it** is per org: `billing_account.free_plan`, or
  `FREE_PLAN_DEFAULT` (off) when an operator has not set one with
  `POST /api/internal/free-plan {tenantId, enabled}`. Every other org sees the
  paid plans (`ITEM_PRICE_IDS`) and subscribes through Chargebee's hosted
  checkout, which returns it to the billing page.
- **Top-ups** are charged to the card on file once the customer confirms an
  amount (₹50, ₹100 or a custom figure): `POST /invoices/create_for_charge_items_and_charges`,
  the API form of the admin UI's *Add Charge*. The `api_token` charge carries its
  own Credit Grant, so Chargebee grants the credits and billing records the
  grant and moves the LiteLLM cap. The `payment_succeeded` webhook does the same
  for a buyer who closed the tab.
- **Credits added any other way** — a charge or a grant made by hand in the
  Chargebee dashboard, a renewal's grant — arrive as `grant_blocks_created`;
  billing re-reads the org at once, so its LiteLLM cap rises (and an exhausted
  team reopens) within seconds. The daily resync is only the backstop.
- **Credits roll over.** Chargebee's grant rollover carries unused credits into
  the next term, and the LiteLLM cap follows Chargebee's usable balance — with
  no monthly reset.
- **The card on file** is changed on Chargebee's Manage Payment Sources page.
- **Payment history** is paged ten at a time by Chargebee's cursor.

`CREDITS_PER_USD` credits buy $1 of LLM spend. The Chargebee calls behind each
of these, with real requests and responses, are in
[docs/CHARGEBEE-API.md](docs/CHARGEBEE-API.md).

## Why a separate service

Billing reads ClickHouse, writes the master Postgres, calls Chargebee, and runs
a cron. It shares no request path with anything else, and an outage in it must
never take down the gateway. Keeping it separate also keeps the Chargebee API
key out of every other service's process.

## Who calls it

enginos-platform, for everything but Chargebee's webhook — and billing checks
nothing about it. Chargebee, for the webhook — and billing checks its
credentials itself.

```
browser   → crewpe-ui /enginos-api/billing/* → enginos-platform /api/v1/billing/* → billing /api/internal/*
Chargebee → billing /api/webhooks/chargebee   (directly: the ONE public path of billing)
```

The platform authenticates the user and takes the tenant id from the
authenticated request, never from what the browser sent. Billing then trusts
the tenant id it is handed: there is no API key on `/api/internal/*`.

The webhook is the exception. Chargebee does not sign webhooks, so the HTTP
Basic credentials set on the endpoint are its only authentication, and
`POST /api/webhooks/chargebee` checks them against `CHARGEBEE_WEBHOOK_USER` /
`CHARGEBEE_WEBHOOK_PASSWORD` (constant-time; either one unset refuses every
delivery with 401). Chargebee calls billing directly: the load balancer (Caddy
locally) sends exactly `POST /api/webhooks/chargebee` on the app host to
billing, and no other path of billing is public.

What the webhook acts on (everything else is acknowledged and ignored):

| Event | Billing does |
|---|---|
| `subscription_created` `_activated` `_changed` `_renewed` `_reactivated` `_resumed` `_cancelled` `_deleted` | Re-reads the org from Chargebee (the body is only a trigger): link, term, free credits owed, LiteLLM cap; cancels an ended subscription |
| `payment_succeeded` (invoice with a top-up line) | Records the paid pack once and moves the cap; 500 while its grant block is not visible yet, so Chargebee redelivers |
| `grant_blocks_created` | Finds the org by its CURRENT subscription (the event names no customer) and re-reads it — credits added by hand reach the cap in seconds |
| `payment_failed`, `alert_status_changed` | Logged only |
| anything for a `cbdemo_` customer or subscription | Chargebee's **Test Webhook** sample data: 200, nothing done |

An unknown REAL customer on an event billing acts on answers 500, so Chargebee
retries it and the failure shows in its delivery log.

So **`/api/internal/*` must only be reachable from enginos-platform on the
private network.** Anyone who can reach it can read and act on any tenant's
billing. `POST /api/internal/sync` (run the
usage sync now) is deliberately not proxied by the platform; it is for operators
on that network.

## What it does NOT do

**It keeps no financial state.** No credit ledger, no balance, no record of what
was billed, no copy of what was granted. Chargebee holds the customer's credits,
grants, top-ups and consumption, and is asked whenever anyone needs to know —
`/ledger_account_balances` for the balance, `/grant_blocks` for the grant,
`/ledger_operations` for the history. A second copy of a number Chargebee owns
can only ever be wrong, and reconciling one against the other was most of the
code this service used to be.

**It performs no pricing arithmetic.** LiteLLM stamps the customer-facing cost
onto each span as `gen_ai.cost.total_cost`; this service sums that column. There
is exactly one pricing system and it is the gateway's.

**It does not create credit grants.** Chargebee issues every one: the plan's
on subscription creation, and the top-up charge's own Credit Grant when a pack
is paid (`TOPUP_CHARGEBEE_GRANTS=true`) — billing records that grant and
allocates nothing. `/ledger_operations/allocate` is used only for a top-up
charge that carries no grant of its own (`TOPUP_CHARGEBEE_GRANTS=false`), and
for the free plan's one-time credits (`FREE_PLAN_CREDITS`).

**It does not block LLM requests.** Enforcement is the LiteLLM team's
`max_budget`, set from Chargebee's live grant blocks at subscription time and
metered by the gateway in real time. Driving it from a remaining balance instead
would let a tenant overspend for a whole sync interval before the gate noticed.

## What prevents double-charging

Three things, in order of how often they do the work:

| Guard | What it stops |
|---|---|
| `billing_account.last_processed_ingested_at` | Usage behind the cursor being read again. The cursor moves ONLY past a range Chargebee resolved, so a failure of any kind re-offers the same usage rather than losing or repeating it. It advances by compare-and-set, so a stale worker cannot rewind it either. |
| `GROUP BY concat(TraceId, ':', SpanId)` | One logical usage event being counted twice inside a range — a re-sent span, or a read that caught `span_nodes` mid-merge. This is event *identity*, and it is a different job from the cursor's. |
| `chargebee_sync_window_uq` on `(tenant_id, from_ingested_at)`, and a range opened (or an empty one passed) only while the cursor still sits at its start, under the account row's lock | Two workers reading the same cursor — which compute different ends, since a range runs to `now − lag` — both billing it: exactly one opens or passes it, the other backs off. |
| `chargebee_sync.id`, written before the capture and sent as the Chargebee ledger operation id | A capture whose response was lost being sent again. The next tick asks Chargebee about that exact id: found → mark SUCCESS and move the cursor; 404 → it never landed, so send it again under the SAME id. |

What that adds up to is **at-least-once processing plus Chargebee's own
idempotency**, which is the strongest guarantee available across two systems
that cannot share a transaction. The `GROUP BY` alone does not give exactly-once
and is not claimed to: it deduplicates one range's rows and has no memory.

## Reading usage

One query per tenant per range, against that tenant's own database
([`src/integrations/clickhouse/usage-source.ts`](src/integrations/clickhouse/usage-source.ts)). It returns a count and a
total, not rows:

```sql
SELECT count() AS event_count, sum(billed_usd) AS billed_usd
FROM (
  SELECT concat(TraceId, ':', SpanId) AS event_key,
         any(toFloat64OrZero(attrs['gen_ai.cost.total_cost'])) AS billed_usd
  FROM tenant_<slug>.span_nodes FINAL
  WHERE SpanName = 'litellm_request' AND attrs['gen_ai.cost.total_cost'] != ''
    AND <not a LiteLLM cache hit>
    AND Timestamp + duration_ms >  {from} AND Timestamp + duration_ms <= {to}
    AND Timestamp > {from} - 1 hour            -- prunes to the range's day partitions
  GROUP BY event_key
)
```

Things about that are load-bearing:

- **`span_nodes`, not `otel_traces`.** The raw table is a plain MergeTree whose
  dedup the platform's own migration calls "best-effort by design… not an
  idempotency guarantee". `span_nodes` is a ReplacingMergeTree on
  `(TraceId, SpanId)` — a real per-span dedup key, and the event key here.
- **One tenant database, never `merge()` across `otel_landing` and `tenant_*`.**
  The tenant table is a *copy* of landing, so a union counts every routed span
  twice.
- **When the LLM call ended — `Timestamp + duration_ms` — and nothing billing
  added to ClickHouse.** Both are read from `span_nodes` as they are: no extra
  column, no migration. A span is written once its call ends and lands about
  23 s later (p99 44 s, measured), so a range is read only once it is
  `BILLING_LAG_MS` old (60 s default, never under 30 s); a span landing later
  than that is behind the cursor and never billed. A collector re-send carries
  the same start and duration, so it falls in the same range and is never
  billed twice.
- **The range is half-open on TIMES, and that is why there is no event id in
  the cursor.** Many spans share one millisecond. A boundary that was "the last
  event of a page" could fall inside one, which is what the old
  `(time, TraceId:SpanId)` cursor pair existed to survive. A boundary that
  is a time cannot: every millisecond belongs whole to exactly one range.
- **`GROUP BY event_key` is the deduplication**, and it is a separate job from
  the cursor. The cursor says which time range; the key says which rows are the
  same event. `any()` rather than `max()` on the cost, because copies of one span
  carry the same cost and taking the larger would be a quiet upward bias.
- **Cache hits are not billed.** LiteLLM records spend 0 for them.
- **There is no `LIMIT`.** Aggregating removes the reason for one — and the
  `LIMIT` was the only reason a read had to be resumable mid-millisecond.

## The cursor

It moves to the end of a range Chargebee resolved, and to nothing else.

- **An unresolved range leaves it exactly where it is**, so the same usage is
  offered again next minute. That, and nothing else, is what retains usage a
  customer had no credits for — there is no requeue step because nothing was ever
  dequeued.
- **An empty range still advances it.** The aggregate covered the whole range
  rather than a page of it, so "no events" is a fact about the range, not a
  failure to read it. No row is written: a log of empty minutes is noise.
- **A range runs from the cursor to `now − lag`** — ordinarily the minute since
  the last pass. Two workers reading the same cursor a moment apart compute
  different ends, and that is safe: a row is opened, and an empty range passed,
  only while the cursor still sits at its start, under the account row's lock,
  so exactly one of them bills or passes it and the other backs off. A retry
  never recomputes a range: it re-sends the row it stored, under that row's id.
- **Catch-up goes an hour at a time** (`BILLING_MAX_RANGE_MS`), one Chargebee
  charge per hour. Chargebee refuses a charge larger than the balance whole, so
  an org that ran out mid-outage has at most an hour held, not the whole outage.
  A pass starts no new range after 3 minutes; the next minute's pass carries on
  from each cursor, so a long outage never runs the task into its timeout.

## Cadence is not freshness

The cron runs every minute and reads only LLM calls that ended before
`now − BILLING_LAG_MS` (taken from ClickHouse's own clock; 60 s by default,
never under 30 s) — reading closer to the present would bill a range before
its spans land.

A tenant can be run by more than one caller at once — the cron, the manual sync
route, a second replica, an old worker mid-rollout — and each range is still
charged once. `chargebee_sync_window_uq` refuses a second row for a range start; a
range is written, and an empty one passed, only while the cursor still sits at
its start; the cursor advances only by compare-and-set; every send first claims
its row by compare-and-set; and a `PROCESSING` row is left to its sender for a
5-minute lease, so a capture still on the wire is never sent again. See
docs/BILLING-ARCHITECTURE.md §5, "Two callers on one tenant".

Note the platform already walked back from a tight cron once: `outbox-poller`
went from 30 s to 2 min because at 500 tenants the former meant 60,000
tenant-database probes an hour. If the minute proves expensive, widening it
costs nothing operationally — enforcement is the gateway's real-time budget.

## Before this bills anyone

1. **Confirm `CREDITS_PER_USD`.** How many credits $1 of LLM spend costs; the
   default is 1,000 (`.env` has 50). A credit is a *billing* unit with a fixed
   dollar rate, not an LLM token.
2. **Confirm `gen_ai.cost.total_cost` is inclusive of margin.** If
   `total - original - margin ≈ 0` it is, and billing it alone is correct.
   Adding `margin_total` separately would charge the markup twice.
3. **Confirm a repeated capture `id` does not create a second operation.** The
   docs imply it; they do not state it. `captureIdempotent()` retrieves
   `GET /ledger_operations/{id}` before every capture and sends only on a 404,
   so this matters only for a capture that lands between the lookup and the
   send — but confirm it directly.
4. **Pin `grant_block.status`.** Only `available` is documented.
   `isLiveGrantBlock()` excludes anything that plainly says it is finished and
   anything past `expires_at`, and that exclusion is what keeps last term's
   credits out of this term's LiteLLM cap — the job the ledger's `expiry`
   entries used to do. Capture the real values against the site.
5. **Confirm no deployment is unpriced.** `verify-litellm-gateway.ts` in
   enginos-platform already detects this: an unpriced target records spend 0,
   which is both a revenue leak and a hole in the hard block.
6. ~~**Settle the plan reconciler.**~~ Settled 2026-09-28: enginos-platform
   leaves the budget of a `billing_managed` team alone, and gives every other
   team $0 with no reset — billing is the only source of spend (see
   docs/BILLING-ARCHITECTURE.md §10 #5).

## Migrations

Two of the older migrations carry partial unique indexes, which Prisma's schema
language cannot express. `prisma migrate dev` reconciles against
`schema.prisma`, sees objects it did not model as drift, and drops them. Apply
with `prisma migrate deploy`, never `migrate dev`.

`20260922130000_billing_cursor_and_sync` is the current head. It adds the cursor
column, creates `chargebee_sync`, seeds both from `chargebee_capture`, and only
then drops it. Unlike the earlier cutovers it **preserves continuity**: each
tenant's cursor comes from its furthest settled capture, and unresolved captures
are carried across with their operation ids intact, because the id is the only
way to ask Chargebee whether the money moved.

The one acknowledged loss is a cursor that sat inside a millisecond — possible
only at a `LIMIT` boundary in the design being replaced. The remainder of that
millisecond is not billed, the migration counts the affected tenants in a
`RAISE WARNING`, and the alternative (rounding down) would re-bill everything
already charged in it.

See [docs/REFACTOR-PLAN.md](docs/REFACTOR-PLAN.md) for the full table-by-table
history.

## Layout

```
src/app/api/**/route.ts   Next.js routing only — each file re-exports one controller
src/controllers/          HTTP: read the request, call one service, render a view
src/http/                 the route wrapper (try/catch + fallback), request parsing, AppError → status
src/services/             business logic
  account.service.ts        customer creation, subscription linking, activation, top-ups
  usage-sync.service.ts     cursor, capture, recovery — the one usage path
  gateway-budget.service.ts the LiteLLM team cap, from Chargebee's grant blocks
  billing-overview.service  the billing page's reads, each degrading on its own
  checkout.service.ts       the free plan (provisionFreePlan) and top-ups
  payment-method / portal / invoice / webhook / plan-catalog
src/repositories/         every database query; platform.repository reads the platform's tables
src/views/                response payloads, in the shapes crewpe-ui reads
src/models/               pure rules: decimal money, the credit rate, statuses, subscription choice
src/integrations/         Chargebee, LiteLLM and ClickHouse clients
src/container/            composition root — the only place config and concrete clients meet
docs/REFACTOR-PLAN.md     six billing tables → two: what moved where, and why
worker/                   Hatchet cron registration
```
