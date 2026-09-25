# Chargebee API reference

Every Chargebee call this service makes, with real requests and responses.

**Everything below was captured against the live `enwithai-test` site**, not copied
from the API reference. Where the documentation and the site disagree, the site
wins and the difference is noted.

## Transport

The pinned SDK (2.x) has no bindings for the prepaid-credit endpoints, so every
call goes over plain REST from [`src/integrations/chargebee/`](../src/integrations/chargebee/client.ts).

```
Base      https://<CHARGEBEE_SITE>.chargebee.com/api/v2
Auth      Basic base64("<CHARGEBEE_API_KEY>:")     ← API key as user, empty password
GET       parameters in the query string
POST      application/x-www-form-urlencoded        ← NOT JSON
Timeout   20s (CHARGEBEE_TIMEOUT_MS), via AbortController
Retry     3 attempts, exponential backoff 500ms → 1s → 2s
```

Nested parameters use Chargebee's bracket syntax, flattened into form fields:
`customer[id]`, `subscription_items[item_price_id][0]`, `metadata[json]`.

**What is retried.** Only what a retry could fix: HTTP **5xx** and **429**, plus
network failures and timeouts. A 4xx is never retried — it will fail identically.
A network error is marked `retryable` because it says nothing about whether the
request was *applied*, which is the distinction the whole capture design rests on.

**The idempotency header is deliberately avoided.** `chargebee-idempotency-key` is
used on exactly one call (`/ledger_operations/allocate`), because its replay window
is 30 minutes — fine for a top-up retried seconds later, useless for a capture
stuck behind an hours-long outage. Capture uses a client-supplied `id` instead.

---

# Subscription creation, end to end

What happens from "customer clicks Subscribe" to "credits enforced at the gateway".

## 1. `POST /customers` — ensure the customer

Called before checkout, from `ensureCustomer()`.

```http
POST /api/v2/customers
Content-Type: application/x-www-form-urlencoded

id=5f0335de-d45e-411b-80da-1c1fc8d3ace1
&email=admin@enwithai.com
&company=Enwithai
```

**The `id` is supplied by us — it is the tenant UUID.** That is what makes customer
creation idempotent: a retry collides on Chargebee's side rather than creating a
second customer for the same tenant. A `duplicate_entry` / `resource_already_exists`
response is caught and treated as success.

```json
{ "customer": { "id": "5f0335de-d45e-411b-80da-1c1fc8d3ace1", "first_name": "…" } }
```

Because the id *is* the tenant id, the reverse lookup in the webhook is a local
read, not an API call — and a customer created by hand in the dashboard (with a
Chargebee-generated id) resolves to nothing rather than to the wrong tenant.

## 2. `GET /item_prices/{id}` — plan details for the page

Called by [`plan-catalog.service.ts`](../src/services/plan-catalog.service.ts), cached 10 minutes.

```http
GET /api/v2/item_prices/pre-paid-test-v1-INR-Monthly
```

```json
{
  "item_price": {
    "id": "pre-paid-test-v1-INR-Monthly",
    "name": "pre-paid-test-v1  INR Monthly",
    "external_name": "pre-paid-test-v1",
    "item_id": "pre-paid-test-v1",
    "item_family_id": "test_product",
    "item_type": "plan",
    "pricing_model": "flat_fee",
    "price": 10000,
    "currency_code": "INR",
    "period": 1,
    "period_unit": "month",
    "status": "active",
    "metadata": {}
  }
}
```

> **`price` is in the currency's MINOR unit.** `10000` is ₹100.00. Dividing by 100
> is wrong for zero-decimal currencies (JPY, KRW), so the UI takes the divisor from
> `Intl.NumberFormat(...).resolvedOptions().maximumFractionDigits`.

**The credit grant amount is NOT here.** Measured: it appears on neither
`/item_prices/{id}` nor `/items/{id}`, and `/item_price_credit_grants` returns 404.
Credits become visible only as `grant_blocks` once a subscription exists.

## 3. `POST /hosted_pages/checkout_new_for_items` — the checkout page

```http
POST /api/v2/hosted_pages/checkout_new_for_items

customer[id]=5f0335de-d45e-411b-80da-1c1fc8d3ace1
&subscription_items[item_price_id][0]=pre-paid-test-v1-INR-Monthly
&subscription_items[quantity][0]=1
```

```json
{ "hosted_page": { "id": "…", "url": "https://enwithai-test.chargebee.com/pages/v3/…",
                   "type": "checkout_new", "state": "created", "expires_at": 1789812108 } }
```

**No `redirect_url` is sent, deliberately.** Setting one makes Chargebee navigate
away instead of calling `openCheckout`'s `success` callback in place — and that
callback is what triggers the post-checkout pull in step 5.

The `item_price_id` is validated against the `ITEM_PRICE_IDS` allowlist *before*
this call. It arrives in the request body from the browser, so without that check a
tampered request could subscribe a tenant to any item price in the catalogue.

## 4. The customer pays

Chargebee creates the subscription and — because the item price carries a **Credit
Grant configuration** — issues the credits automatically. We never call an allocate
endpoint for a plan's credits; we read what Chargebee granted and mirror it.

## 5. `GET /subscriptions` — the pull path

The UI calls it from the checkout success callback, through enginos-platform
(`POST /api/v1/billing/sync-subscription` → `/api/internal/sync-subscription`), which
reaches `activeSubscriptions()`:

```http
GET /api/v2/subscriptions
  ?customer_id[is]=5f0335de-d45e-411b-80da-1c1fc8d3ace1
  &status[in]=["active","in_trial","non_renewing"]
  &limit=10
```

Results are sorted newest-first by `created_at`; the first is used.

```json
{
  "subscription": {
    "id": "169m6aVVefyRF9DZY",
    "customer_id": "5f0335de-d45e-411b-80da-1c1fc8d3ace1",
    "status": "active",
    "currency_code": "INR",
    "current_term_start": 1789808508,
    "current_term_end": 1792400508,
    "next_billing_at": 1792400508,
    "billing_period": 1,
    "billing_period_unit": "month",
    "mrr": 10000,
    "subscription_items": [
      { "item_price_id": "pre-paid-test-v1-INR-Monthly", "item_type": "plan",
        "quantity": 1, "unit_price": 10000, "amount": 10000 }
    ]
  }
}
```

**`current_term_start` (a unix second) is load-bearing** — it is half the grant
idempotency key, `sub:<subscription id>:<term start>`.

This exists because the webhook is not enough on its own: Chargebee cannot reach a
developer machine at all, and even in production a delivery can be delayed, dropped,
or land mid-deploy. Both paths are idempotent and share one key, so whichever
arrives first does the work.

## 6. `GET /ledger_account_balances` — the credit unit and balance

```http
GET /api/v2/ledger_account_balances?subscription_id[is]=169m6aVVefyRF9DZY&limit=1
```

```json
{ "list": [ { "ledger_account_balance": {
  "subscription_id": "169m6aVVefyRF9DZY",
  "unit_id": "token-test",
  "unit_type": "credit_unit",
  "unit_external_name": "token-test",
  "provisioned_balance": {
    "total_balance": "0.8594750000",
    "usable_balance": "0.8594750000",
    "hold_amount":    "0.0000000000"
  },
  "overdraft_balance": { "total_balance": "0.0000000000", "usable_balance": "0.0000000000" }
} } ] }
```

`usable_balance` is what `chargebeeExhausted()` tests. `unit_id` is stored as
`billing_account.ledger_unit_id` and is required on every capture.

Amounts are **strings at 10 decimal places** — the same precision as the
`DECIMAL(20,10)` ledger columns. Never parse them into a float.

**A subscription can hold more than one unit** (MEASURED 2026-09-24): a top-up
whose charge item carried its own Credit Grant into `token` added a second
ledger account beside the plan's `token-test`, and the list returned `token`
**first**. `limit=1` with no unit filter therefore reads the wrong unit.
`balance()` now asks with `unit_id[is]=<ledger_unit_id>` (honoured by the site,
and checked again client-side); only a first link, with no unit yet, picks the
subscription's **oldest** ledger account — the plan's — and logs
`billing.subscription.multiple_units` when there was a choice. A relink of the
same subscription never changes `ledger_unit_id`.

## 7. `GET /grant_blocks` — what was actually granted

```http
GET /api/v2/grant_blocks?subscription_id[is]=169m6aVVefyRF9DZY&limit=100
```

```json
{ "list": [
  { "grant_block": { "id": "B0O7ADVVerZoB5G", "granted_amount": "1.0000000000",
                     "unit_id": "token-test", "status": "available" } },
  { "grant_block": { "id": "B0O7ADVVeg6vO57", "granted_amount": "1.0000000000",
                     "unit_id": "token-test", "status": "available" } }
] }
```

`grantedCredits()` filters by `unit_id`, **excludes blocks that are no longer
live**, and sums `granted_amount`. It is recomputed whole on every push, never
incremented, so a correction made in Chargebee converges instead of drifting.

The exclusion is load-bearing: this sum is the LiteLLM cap, and a renewal works
by Chargebee expiring last term's block and issuing a new one. Counting the
expired block would leave the customer able to spend credits they no longer own —
which is the job the local ledger's hand-written `expiry` entries used to do.
A block that is merely SPENT still counts: the cap is `baseline + everything
granted`, and the team's own cumulative spend is what consumes it.

> **Unverified:** only `status: "available"` is documented. `isLiveGrantBlock()`
> excludes `expired`/`invalidated`/`cancelled`/`deleted` and anything past
> `expires_at`, erring towards excluding. Pin the real values against the site.

## 8. Local effects — no Chargebee calls

```
billing_account   subscription id, unit, item price, term, status
billing_account   last_processed_ingested_at = now()  ← billing starts here, never earlier
LiteLLM /team/update  max_budget = baseline + USD(live grant blocks), budget_duration = null
billing_account   status → active
```

No credit figure is written anywhere. The grant lives in Chargebee and is
re-read from `/grant_blocks` whenever the cap is set or the page is rendered.

The account only becomes `active` once the gateway holds the budget. If the push
fails it is held `activating` with its team blocked — the customer has paid, but the
gateway would otherwise enforce a budget nobody computed.

---

# Usage capture — the money path

## `POST /ledger_operations/capture`

```http
POST /api/v2/ledger_operations/capture

id=443066f3-1d93-4d19-a54d-d27b296c15e0        ← OUR operation id
&subscription_id=169m6aVVefyRF9DZY
&unit_id=token-test
&amount=0.1405250000
&ledger_operation_timestamp=1789809061
```

**The `id` is the `chargebee_sync` row's own id, written BEFORE the call.** One
value in two systems is what makes a replay settle instead of re-charge, and
writing it first is what makes it survive the crash that lost the answer.
Chargebee documents that for external ledger operations "the same value should be
reused across retries".

Retrieved back, unchanged — this is the live proof:

```json
{ "ledger_operation": {
  "id": "443066f3-1d93-4d19-a54d-d27b296c15e0",
  "type": "capture",
  "amount": "0.1405250000",
  "provisioned_start_balance": "1.0000000000",
  "provisioned_end_balance":   "0.8594750000",
  "subscription_id": "169m6aVVefyRF9DZY",
  "unit_id": "token-test",
  "sequence_number": 1789809062074128569
} }
```

The drain-to-zero check reads the balance from the capture response's
`ledger_account_balance.provisioned_balance.usable_balance`, which the capture API
documents as always returned — not from this operation body's
`provisioned_end_balance`. A capture that empties the balance marks the account
`exhausted` and blocks the LiteLLM team. A capture settled by *lookup* (a replay
after a lost response) has no response body, so the client reads
`/ledger_account_balances` for it. Nothing is stored — the billing page asks
`/ledger_account_balances` too, so it cannot go stale.

Note the retry predicate here is `err.status === 429` **only** — narrower than the
default. A 5xx on a capture must not be retried blindly inside the call; it becomes
`CAPTURE_RETRYABLE` so the row stays `UNKNOWN` under that same id, the
cursor does not move, and the *next tick* resolves it by lookup.

## `GET /ledger_operations/{id}` — resolve an unknown outcome

Called before every capture, and after any unknown outcome.

```http
GET /api/v2/ledger_operations/443066f3-1d93-4d19-a54d-d27b296c15e0
```

- **200** → the charge landed. Settle from it; do not re-send.
- **404 `resource_not_found`** → it never landed. Safe to send.
- **anything else** → still unknown. Stay pending.

The match is strict: same id, `type` containing `capture`, and the same
subscription. A grant is not a charge, and matching one would suppress a real
capture forever.

## `POST /ledger_operations/allocate` — top-up only

The **only** call using `chargebee-idempotency-key`, because Chargebee accepts no
client-supplied id here. Requires a mandatory `expires_at`.

MEASURED (2026-09-24): the key replays only the **same request** — a second call
under it with a different `expires_at` is refused ("The idempotency key provided
has already been used for a different request") — and the `metadata` sent with
the allocation is **never returned**: not on `GET /ledger_operations` or
`/ledger_operations/{id}`, and the grant block it creates carries only
`{"done_by":"<api key name>"}`. So nothing in Chargebee ties an allocation to the
invoice it paid for.

The guard is therefore local: a `topup_grant` row per invoice, claimed with the
whole request before the call and completed with the operation id after it. A
retry within the key's window re-sends that exact request (Chargebee answers with
the original grant); past it, the subscription's `grant_blocks` are searched for
the allocation before anything is sent again. See BILLING-ARCHITECTURE.md §10.

A pack whose charge item carries its **own** Credit Grant is granted by Chargebee
at payment; its grant block's `billing_metadata` names the invoice line
(`{"line_items":[{"id":"li_…","invoice_number":"85"}],"item_price_id":"…"}`),
and billing records it and allocates nothing. `checkout_one_time_for_items`
refuses such a charge outright ("Charges with grants are not supported for
customer one off charges").

---

# Error classification

Errors are classified, not just thrown ([`classify()`](../src/integrations/chargebee/errors.ts)),
in this precedence:

| Kind | Trigger | Effect |
|---|---|---|
| `replayed` | **`ERROR_DUPLICATE_OPERATION_ID`** (measured), plus the unmeasured `duplicate_entry`, `resource_already_exists`, `idempotency_replayed` — in `api_error_code` or `error_code` | Our id was already used — the money moved. Confirmed by `GET /ledger_operations/{id}`, then settled; not found → `retryable`. |
| `retryable` | 5xx, 429, network error, timeout | **Unknown.** The id stays pending, cursor frozen, resolved by lookup next tick. |
| `insufficient` | `ERROR_INSUFFICIENT_BALANCE` | Out of credits. Pending cleared, **cursor held**, team blocked; the same usage is offered again every tick and clears itself on a top-up. |
| `no_ledger` | `resource_not_found`, `invalid_request` | No prepaid ledger. Nothing charged and nothing will be until it is configured; `INVALID`, **cursor held**, billed once fixed. |
| `terminal` | anything else | Stop and ask a human. |

The `retryable` branch is the important one: *"Treating it as failure loses the
usage; treating it as success loses the money."* An unknown is never converted into
a failure by counting attempts — only Chargebee can resolve it — so the id stays
pending indefinitely and the tenant bills nothing until it answers. A rejected
credential logs `billing.sync.unauthenticated` instead, because that one stalls
every tenant at once and a person fixes it.

> **Measured 2026-09-24** (L1 `dup_id_probe`): re-POSTing a capture whose id exists
> returns HTTP 400, `type: invalid_request`, and both `api_error_code` and
> `error_code` = `ERROR_DUPLICATE_OPERATION_ID` — "Duplicate operation id: one or
> more operationId values conflict." The operation and the balance are unchanged.
> Chargebee refuses a reused id; it never charges it twice. The live L1 run hit it
> whenever a second caller re-sent a row still on the wire, and it used to land in
> `terminal` → `INVALID`.

---

# Remaining endpoints

| Call | Endpoint | Purpose |
|---|---|---|
| `portalSession()` | `POST /portal_sessions` | Self-serve portal. **Built but never rendered in the UI, and refused (409 `portal-off`) unless `CHARGEBEE_PORTAL_ENABLED=true`** — customers must not be able to cancel, and the portal offers cancellation unless it is switched off in the site's Self-Serve Portal settings. |
| `customer()` | `GET /customers/{id}` | Tells a deleted subscription (customer still there) from a wrong site or key (nothing there) before a missing subscription cancels an account. |
| `subscriptionIdsOf()` | `GET /subscriptions?customer_id[is]=…` | Every subscription the customer has had, so the top-up guard sees a pack Chargebee granted to an earlier one. |
| `checkoutOneTime()` | `POST /hosted_pages/checkout_one_time_for_items` | Top-up pack — a one-time charge, not a second subscription. |
| `paidInvoicesFor()` | `GET /invoices?customer_id[is]=…&status[is]=paid` | Proof of payment for a top-up. |
| `ledgerOperations()` | `GET /ledger_operations?subscription_id[is]=…` | One page of history. **Not** a top-up guard: operation metadata is never returned. |
| `grantBlocks()` | `GET /grant_blocks?subscription_id[is]=…` (paginated) | Every grant block with the invoice line that issued it — how the top-up guard recognises a pack Chargebee granted itself, and finds a lost allocation past the key's window. |
| `subscription()` | `GET /subscriptions/{id}` | One subscription by id. Null only on a 404 `resource_not_found`; anything unclear throws. |

# Webhooks (inbound)

Chargebee POSTs to **enginos-platform** (`/api/v1/webhooks/chargebee`) with **HTTP
Basic** credentials (`CHARGEBEE_WEBHOOK_USER` / `CHARGEBEE_WEBHOOK_PASSWORD`, in the
platform's env). The platform checks them and forwards the body verbatim to billing's
`/api/webhooks/chargebee`, which checks no credentials of its own and must not be
reachable from the internet. **Chargebee does not sign webhooks** — there is no HMAC
to verify — so those credentials are the only thing in front of an endpoint that
grants credits.

```json
{ "id": "ev_…", "event_type": "subscription_created",
  "content": { "subscription": { "id": "…", "customer_id": "…",
                                 "current_term_start": 1789808508,
                                 "current_term_end": 1792400508,
                                 "subscription_items": [ { "item_price_id": "…" } ] },
               "customer": { "id": "…" } } }
```

Handled: `subscription_created`, `_activated`, `_changed`, `_renewed`, `_cancelled`,
`_deleted`, `payment_failed`, `alert_status_changed`. Any other event type is
acknowledged with **200** and ignored — nothing is logged or stored for it. The
platform has authenticated the delivery before billing sees it.

A body with no `id` or `event_type` gets **400**. A failed handler returns **500**,
not 200, and enginos-platform hands that status to Chargebee unchanged. Billing
keeps no record of the event (see **Webhook replays** in SCHEMA.md), so handing the
failure back is what keeps it from vanishing: Chargebee retries a non-2xx, and a
webhook that keeps failing shows up in Chargebee's own delivery log.
