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

**One call is never retried at all:** `POST /invoices/create_for_charge_items_and_charges`,
the top-up charge. It moves money, and a timeout says nothing about whether the
card was charged — a second send could charge it twice.

**The idempotency header is used sparingly.** `chargebee-idempotency-key` is sent
on two calls — `/ledger_operations/allocate` (`invoice:<id>` for a pack,
`free-plan-credits:<tenant>` for the free plan's credits) and the free-plan
subscribe (`free-plan:<tenant>`) — because its replay window is 30 minutes:
fine for a repeat seconds later, useless for a capture stuck behind an
hours-long outage. Capture uses a client-supplied `id` instead.

---

# The free plan — no checkout, no card

An org the free plan is for — `billing_account.free_plan`, or
`FREE_PLAN_DEFAULT` (off) when that is empty — is put on
`FREE_PLAN_ITEM_PRICE_ID` (`pre-paid-test-v1-INR-Yearly`, ₹0 a year, its own
Credit Grant cut to zero) by `checkout.provisionFreePlan`: enginos-platform calls
`POST /api/internal/provision` once the org's LiteLLM team exists, and the
billing page calls it again for such an org with no subscription. It creates
the customer (§1 below) for **every** org, with the admin's email; for an org
the free plan is not for it stops there (`not-eligible`). Otherwise it checks
the plan's `price` is `0` (§2), then:

```http
POST /api/v2/customers/<tenant uuid>/subscription_for_items
chargebee-idempotency-key: free-plan:<tenant uuid>

subscription_items[item_price_id][0]=pre-paid-test-v1-INR-Yearly
&subscription_items[quantity][0]=1
```

MEASURED 2026-09-28 with a customer that has **no card**: the subscription came
back `active` and its ₹0 invoice `paid`, and — while the plan still carried a
grant — Chargebee granted 1,000 `token-test`. The grant block, and the ledger
account billing charges usage against, came **three seconds after** the
subscription, so the link (§5) is repeated once a second, up to 10 times, until
`ledger_unit_id` is set. From sign-up to a $20 LiteLLM cap
(`CREDITS_PER_USD=50`) took about twelve seconds for `org-billtest2-com`.

## The free credits — billing's own allocate, once per org

A plan's Credit Grant comes again at every renewal, so the yearly free plan's
is cut to zero (or a single token) and billing grants the credits itself:
`FREE_PLAN_CREDITS` is the **total** each free-plan org starts with, granted
**once per org, ever**, into `FREE_PLAN_CREDIT_UNIT` (required with it). It runs
inside the link (`syncSubscription` → `grantFreePlanCredits`), before the
account is activated:

```http
POST /api/v2/ledger_operations/allocate
chargebee-idempotency-key: free-plan-credits:<tenant uuid>

subscription_id=<subscription>
&unit_id=token-test
&amount=1000.0000000000
&expires_at=<10 years out>
&metadata[json]={"invoice_id":"free-plan-credits","tenant_id":"<tenant uuid>"}
```

- **A zero-grant plan has no wallet.** MEASURED 2026-09-30: no grant block, no
  balance, no unit on the subscription. The allocate into
  `FREE_PLAN_CREDIT_UNIT` creates the wallet, and the account then **adopts**
  that unit as its `ledger_unit_id`.
- **Amount** = `FREE_PLAN_CREDITS` − what the plan's own grant gave (floor 0),
  read from `GET /grant_blocks`. A plan that gave at least that — every org put
  on it before the cut — is recorded and nothing is allocated.
- **Exactly once**: the `topup_grant` row `free-plan-credits`, claimed before
  the call, and the key above. `expires_at` is 10 years out (allocate requires
  one).
- **A failed allocate** holds the account `activating`, its team blocked, and
  `activatePending` retries it every minute.

MEASURED 2026-09-30: `org_aaa_com`, created on the zero-grant plan, had no
wallet and got nothing before this; after it, billing allocated 1,000
`token-test`, the wallet appeared, and the account adopted it.

# Subscription creation, end to end

What happens from "customer clicks Subscribe" to "credits enforced at the gateway".
The page offers the paid plans (`ITEM_PRICE_IDS`) to an org the free plan is not
for; steps 3 and 4 are how one is bought.

## 1. `POST /customers` — ensure the customer

Called at onboarding for every org (`provisionFreePlan` → `ensureCustomer()`),
and again before a checkout if it is still missing.

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
&redirect_url=https://dev.127.0.0.1.nip.io/organization/billing?from=checkout
```

```json
{ "hosted_page": { "id": "…", "url": "https://enwithai-test.chargebee.com/pages/v3/…",
                   "type": "checkout_new", "state": "created", "expires_at": 1789812108 } }
```

**`redirect_url` is `APP_URL/organization/billing?from=checkout`.** The browser is
sent to the page, and Chargebee returns it with `&id=<hosted page>&state=succeeded`
— which is what triggers the post-checkout pull in step 5. (With Chargebee.js's
`openCheckout` it would have to be left out: a `redirect_url` makes Chargebee
navigate away instead of calling the `success` callback in place.)

The `item_price_id` is validated against the `ITEM_PRICE_IDS` allowlist *before*
this call. It arrives in the request body from the browser, so without that check a
tampered request could subscribe a tenant to any item price in the catalogue.

## 4. The customer pays

Chargebee creates the subscription and — because the item price carries a **Credit
Grant configuration** — issues the credits automatically. We never call an allocate
endpoint for a paid plan's credits; we read what Chargebee granted and mirror it.
The one plan billing allocates for is the free plan, once per org (above).

## 5. `GET /subscriptions` — the pull path

The page calls it when Chargebee returns the browser with
`?from=checkout&state=succeeded`, through enginos-platform
(`POST /api/v1/billing/sync-subscription` → `/api/internal/sync-subscription`), which
reaches `activeSubscriptions()`:

```http
GET /api/v2/subscriptions
  ?customer_id[is]=5f0335de-d45e-411b-80da-1c1fc8d3ace1
  &status[in]=["active","in_trial","non_renewing"]
  &limit=10
```

Results are sorted newest-first by `created_at`. Which one gets the usage is
decided in `models/subscription.ts`: the one already linked while it is still
active, else the only one, else the newest selling a plan on `ITEM_PRICE_IDS`,
else the newest.

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

**`current_term_start` (a unix second) is load-bearing** — a term start later
than the one on file is how a renewal is recognised, and it is the term the
LiteLLM spend baseline is recorded for (`billing_baseline_term`), so a second
delivery of the same renewal moves nothing.

This exists because the webhook is not enough on its own: Chargebee reaches a
developer machine only through a tunnel, and even in production a delivery can be
delayed, dropped, or land mid-deploy. Both paths re-read Chargebee and apply it
whole, so whichever arrives first does the work and the other changes nothing.

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
topup_grant       free-plan-credits (free plan only)  ← the one-time allocate's guard; ledger_unit_id adopted
LiteLLM /team/update  max_budget = baseline + USD(live grant blocks), budget_duration = null
billing_account   status → active
```

No balance is written anywhere — only the guard row's record of what one
allocate asked for. The grant lives in Chargebee and is re-read from
`/grant_blocks` whenever the cap is set or the page is rendered.

The account only becomes `active` once the gateway holds the budget. If the push
fails — or the free plan's credits are still owed — it is held `activating` with
its team blocked, and `activatePending` retries every minute: the customer has
paid, but the gateway would otherwise enforce a budget nobody computed.

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

## `POST /ledger_operations/allocate` — a grant-free top-up, and the free credits

Uses `chargebee-idempotency-key` (`invoice:<id>`, or `free-plan-credits:<tenant>`),
because Chargebee accepts no client-supplied id here. Requires a mandatory
`expires_at`.

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

Allocate is the path for a pack whose charge carries **no** Credit Grant
(`TOPUP_CHARGEBEE_GRANTS=false`), and for the free plan's one-time credits (a
`topup_grant` row under `free-plan-credits`, above). A pack whose charge carries
its **own** grant is granted by Chargebee, and billing records that grant and
allocates nothing — see **Top-up** below.

---

# Top-up — buying more credits

The pack is `api_token-INR`: a charge, `per_unit`, `price: 100` (₹1.00 a unit),
carrying its **own** Credit Grant of **50 `token-test` per unit** (measured from
the grant blocks — the grant configuration is not readable over the API, see §2).
`TOPUP_CHARGEBEE_GRANTS=true` tells billing that Chargebee grants it.

**A top-up is always in the subscription's currency.** MEASURED 2026-09-30: a
charge in a different currency from the subscription is refused —
`currency_mismatched`, *"currency of the item(s) is different from the expected
value 'INR'"*. Everything on the site is INR today; `api_token-USD` exists but
nothing uses it.

## `POST /invoices/create_for_charge_items_and_charges` — charge the pack

`chargeItem()`, from `checkout.startTopUp`. The API form of the admin UI's
*Subscription → Billing Actions → Add Charge*: the pack is invoiced onto the
subscription and collected from the card on file at once. The billing page asks
the customer to confirm the amount first.

```http
POST /api/v2/invoices/create_for_charge_items_and_charges

subscription_id=AzZJw4VWERUNT16d5
&item_prices[item_price_id][0]=api_token-INR
&item_prices[quantity][0]=1
&auto_collection=on
```

**`auto_collection=on` is always sent.** Without it the invoice takes the
subscription's `auto_collection`, else the customer's. MEASURED 2026-09-28 on a
probe customer: with the subscription's set `off`, the charge came back
`payment_due` (invoice 123) and its 50-credit grant was issued anyway. The same
setup with `auto_collection=on` on the call was paid at once (invoice 124). The
customer has just confirmed the charge, so the account's setting must not decide
it. Also measured: adding a card (`POST /payment_sources/create_card`) turned a
customer's `auto_collection` from `off` to `on` by itself. Every live customer on
the test site was `on`, with no subscription overriding it.

Trimmed from invoice 96, 2026-09-28:

```json
{ "invoice": { "id": "96", "status": "paid", "total": 100, "amount_due": 0,
               "currency_code": "INR", "paid_at": 1790574139,
               "line_items": [ { "id": "li_16BVWYVWUUbpZG7K", "entity_type": "charge_item_price",
                                 "entity_id": "api_token-INR", "quantity": 1, "amount": 100 } ] } }
```

**Never retried** (see Transport). A `payment` error (HTTP 402 — a declined card,
no card on file) is answered as 409 `topup-payment-failed` with Chargebee's
reason. An invoice that comes back not `paid` grants nothing on billing's side and
is returned to the page as it is.

## The grant — issued by Chargebee, recorded by billing

Chargebee issues the pack's grant block itself, **about a second after
`paid_at`** (invoice 96: `paid_at` 1790574139, block `created_at` 1790574140):

```json
{ "grant_block": { "id": "B0FQTwVWUUcJx8G", "unit_id": "token-test",
                   "granted_amount": "50.0000000000", "status": "available",
                   "grant_source": "top_up", "expires_at": 5680261800,
                   "billing_metadata": "{\"line_items\":[{\"id\":\"li_16BVWYVWUUbpZG7K\",\"invoice_number\":\"96\",\"quantity\":1}],\"item_price_id\":\"api_token-INR\"}" } }
```

- `billing_metadata` is a JSON **string**, and names the invoice **line**. That
  line id is how `catalogueGrantFor()` tells this pack's block from the plan's
  block on the same invoice.
- `expires_at` 5680261800 is **2149-12-31**: the pack's grant never expires,
  unlike the plan's, which ends with the term.
- billing waits up to five seconds for the block (`startTopUp`), then records
  it as a `catalogue_grant` row in `topup_grant` and moves the gateway cap. A
  block still not visible is **never** allocated for instead — that would be a
  second grant once Chargebee's lands; the next apply, or `payment_succeeded`,
  looks again.

## What Chargebee refuses for a charge that carries a grant

MEASURED on the test site, 2026-09-28, with `api_token-INR`. A top-up is always
mid-term, so every route but the invoice charge above is closed to it:

| Call | Result |
|---|---|
| `POST /hosted_pages/checkout_one_time_for_items` (`item_prices[…]`, with or without `unit_price`) | 400 `invalid_request` / `operation_not_supported`: *"Charges with grants are not supported for customer one off charges"*. The same call with a grant-free charge (`token-pack-20m-INR`) opens a page. |
| `POST /hosted_pages/checkout_existing_for_items` (`subscription_items[…]`) | 400 `mid_term_grant_subscription_change_not_allowed`: *"You cannot update a subscription with items having credit unit grants immediately or mid-term. Schedule the update at end of term."* |
| `POST /subscriptions/{id}/update_for_items` (checked through `POST /estimates/update_subscription_for_items`, which applies nothing) | The same `mid_term_grant_subscription_change_not_allowed`. |
| `POST /subscriptions/{id}/add_charge` | 400 `configuration_incompatible` / `pc2_to_pc1_error` — a Product Catalog 1.0 endpoint; the site is on 2.0. |
| `charge_items[…]` on `checkout_one_time_for_items` | **Silently ignored.** The page is created empty — even for an item price that does not exist. |

**Invoice first, pay later does not work with a grant-carrying charge.** The
same invoice charge with `auto_collection=off` returns an unpaid invoice
(`payment_due`), and the grant block is issued **at once, `available`** — the
credits land before any payment. Voiding the invoice (`POST /invoices/{id}/void`)
leaves the block `available`. So a `hosted_pages/collect_now` flow would hand
out credits for unpaid invoices. (Test invoice 103 on `5e51a7d0-…`: voided, its
50 credits still on the subscription.)

**A declined card leaves an unpaid invoice, with the credits granted.**
MEASURED 2026-09-28 with the test gateway's `4005519200000004`: the card was
added as `valid`, and the charge (with `auto_collection=on`) answered **HTTP 200**
with invoice 126 `payment_due`, not a payment error. Its 50-credit block was
`available` straight away. `grantedCredits()` sums every live block, so the
gateway cap counted those credits although nothing was paid. **Fixed**: they are
held back until the invoice is paid (`unpaidTopUpCredits`, below; BILLING-ARCHITECTURE.md
§10 #7). (`4119862760338320` is refused when the card is
added: 400 `payment_method_verification_failed`, "(3009) Do not honour".)

**How that invoice gets paid** (MEASURED 2026-09-28, invoice 128):

- The failed attempt is a `failure` transaction, `3001` *Insufficient funds*. The
  invoice goes into dunning: `dunning_status: in_progress`, `next_retry_at`
  **24 hours** later, retried on whatever card is primary then.
- **Adding a new card does not collect it.** With the card replaced
  (`replace_primary_payment_source=true`), the invoice was still `payment_due`.
- `POST /invoices/{id}/collect_payment` (admin: the invoice's *Collect Payment*)
  charged the new card at once: `paid`, `dunning_status: stopped`.
- Events, in order: `payment_failed` at the decline; then `payment_succeeded`,
  `invoice_updated` and `dunning_updated` when it was collected.
- `collect_payment` on a card that declines again: HTTP **400**
  `payment_processing_failed` / `charge_failed`, *"Payment collection failed.
  Reason: (3001) Insufficient funds."* (invoice 130), not a 402. Billing treats
  any `payment_…` code as a declined card.

## Unpaid top-ups

| Client call | Chargebee | Used by |
|---|---|---|
| `unpaidInvoicesFor()` | `GET /invoices?customer_id[is]=…&status[in]=["payment_due","not_paid"]&sort_by[asc]=date` | The one-owed-at-a-time guard, the page's banner, Pay now |
| `unpaidTopUpCredits()` | The same list with `voided` and `pending` added, then `GET /grant_blocks` only if one is a top-up | Holding a declined top-up's credits back from the cap, the page and the exhaustion check |
| `collectInvoice()` | `POST /invoices/{id}/collect_payment` — **never retried** | Pay now |

The charge response carries `dunning_status` and `next_retry_at`, which the page
shows as the date Chargebee tries the card again.

## `GET /invoices` — proof of payment

`paidInvoicesFor()`, read by every apply:

```http
GET /api/v2/invoices?customer_id[is]=…&status[is]=paid&sort_by[desc]=date&limit=20
```

Newest first, so an invoice paid a moment ago is on the one page read — a
customer with 20 renewals behind it would otherwise push it off. Filtered
client-side to invoices with a line for the top-up item price.

---

# The billing page's reads

## `GET /transactions` — the payment history, a page at a time

`transactionsPage()`. The overview reads page one; `GET /api/internal/billing/:tenantId/payments?offset=`
serves the rest.

```http
GET /api/v2/transactions?customer_id[is]=…&sort_by[desc]=date&limit=10
GET /api/v2/transactions?customer_id[is]=…&sort_by[desc]=date&limit=10&offset=["1790574889000","345"]
```

```json
{ "list": [ …9 newer…,
            { "transaction": { "id": "txn_AzytDSVWUXl9II4b", "type": "payment", "status": "success",
                               "amount": 100, "currency_code": "INR", "date": 1790574889,
                               "payment_method": "card", "masked_card_number": "************1111",
                               "linked_invoices": [ { "invoice_id": "98" } ] } } ],
  "next_offset": "[\"1790574889000\",\"345\"]" }
```

Chargebee pages by an **opaque cursor**, not by number: `next_offset` is sent back
as `offset` for the next page and is **absent on the last** (test site: 10, then 7,
then none). The cursor only says where to continue — `customer_id[is]` is sent
again with every page, from the tenant's own account, so a cursor from the
browser cannot reach another customer's list.

## `POST /hosted_pages/manage_payment_sources` — change the card

`managePaymentSourcesPage()`, behind the page's *Update card* button. The customer
adds, replaces or removes cards — and nothing else; unlike the portal it offers no
cancellation, so it is shown while the portal stays shut.

```http
POST /api/v2/hosted_pages/manage_payment_sources

customer[id]=5d3fa58c-86c5-4141-a0d3-94d385af953f
&redirect_url=https://dev.127.0.0.1.nip.io/organization/billing
```

```json
{ "hosted_page": { "id": "IjLMDgAbfoSQm1m9AfxTeI8h500Pbmi7", "type": "manage_payment_sources",
                   "url": "https://enwithai-test.chargebee.com/pages/v3/…/", "state": "created",
                   "created_at": 1790580433, "expires_at": 1791012433 } }
```

**`redirect_url` must be on port 80, 443, 8080 or 8443.** `http://localhost:4200`
is refused: 400 `UNSUPPORTED_PORT`, *"Only [443, 80, 8443, 8080] ports are
allowed"*. It is `APP_URL` + `/organization/billing`, so `APP_URL` is the HTTPS dev
origin locally and the real domain elsewhere. The page lives five days
(`expires_at − created_at` = 432000 s).

---

# Error classification

Errors are classified, not just thrown ([`classify()`](../src/integrations/chargebee/errors.ts)),
in this precedence:

| Kind | Trigger | Effect |
|---|---|---|
| `replayed` | **`ERROR_DUPLICATE_OPERATION_ID`** (measured), plus the unmeasured `duplicate_entry`, `resource_already_exists`, `idempotency_replayed` — in `api_error_code` or `error_code` | Our id was already used — the money moved. Confirmed by `GET /ledger_operations/{id}`, then settled; not found → `retryable`. |
| `retryable` | 5xx, 429, network error, timeout | **Unknown.** The id stays pending, cursor frozen, resolved by lookup next tick. |
| `insufficient` | `ERROR_INSUFFICIENT_BALANCE` | Out of credits. Pending cleared, **cursor held**, team blocked. While the account is `exhausted` Chargebee is not asked again (5 min doubling to 1 hour); a top-up or renewal takes it out of `exhausted`, and the same usage is offered again on the next tick. |
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
| `chargeItem()` | `POST /invoices/create_for_charge_items_and_charges` | Top-up pack, charged to the card on file; **never retried**. See **Top-up**. |
| `collectInvoice()` | `POST /invoices/{id}/collect_payment` | Pay now, for a top-up whose card declined; **never retried**. See **Unpaid top-ups**. |
| `unpaidInvoicesFor()` | `GET /invoices` (`payment_due`, `not_paid`) | Top-ups still owed. |
| `unpaidTopUpCredits()` | `GET /invoices`, then `GET /grant_blocks` | A declined top-up's credits, held back. |
| `paidInvoicesFor()` | `GET /invoices?customer_id[is]=…&status[is]=paid&sort_by[desc]=date` | Proof of payment for a top-up. See **Top-up**. |
| `transactionsPage()` | `GET /transactions?customer_id[is]=…&offset=…` | The payment history, by cursor. See **The billing page's reads**. |
| `managePaymentSourcesPage()` | `POST /hosted_pages/manage_payment_sources` | The *Update card* page. See **The billing page's reads**. |
| `ledgerOperations()` | `GET /ledger_operations?subscription_id[is]=…` | One page of history, read only by `scripts/e2e-prepaid.ts` to see the captures the worker sent. **Not** a top-up guard: operation metadata is never returned. |
| `grantBlocks()` | `GET /grant_blocks?subscription_id[is]=…` (paginated) | Every grant block with the invoice line that issued it — how the top-up guard recognises a pack Chargebee granted itself, and finds a lost allocation past the key's window. |
| `subscription()` | `GET /subscriptions/{id}` | One subscription by id. Null only on a 404 `resource_not_found`; anything unclear throws. |

# Webhooks (inbound)

Chargebee POSTs **directly to billing**'s `/api/webhooks/chargebee` — the one
public path of billing. The load balancer (Caddy locally) has an exact-path,
POST-only rule for it on the app host; nothing else of billing is public, and
crewpe-ui and enginos-platform are not in the path (`/api/internal/*` stays
private, reachable only from the platform). Billing checks the **HTTP Basic**
credentials (`CHARGEBEE_WEBHOOK_USER` / `CHARGEBEE_WEBHOOK_PASSWORD`, in billing's
env, compared in constant time) before anything else; either one unset refuses
every delivery with 401 `webhook-unauthorized`. **Chargebee does not sign
webhooks** — there is no HMAC to verify — so those credentials are the only thing
in front of an endpoint that grants credits.

```json
{ "id": "ev_…", "event_type": "subscription_created",
  "content": { "subscription": { "id": "…", "customer_id": "…",
                                 "current_term_start": 1789808508,
                                 "current_term_end": 1792400508,
                                 "subscription_items": [ { "item_price_id": "…" } ] },
               "customer": { "id": "…" } } }
```

`grant_blocks_created` is shaped differently: `content.grant_blocks[]`, each naming
its `subscription_id`, and **no customer** (MEASURED 2026-09-30).

Handled:

| Event | Effect |
|---|---|
| `subscription_created`, `_activated`, `_changed`, `_renewed`, `_reactivated`, `_resumed`, `_cancelled`, `_deleted` | A trigger only: the customer's subscriptions are re-read from Chargebee and applied (`syncFromChargebee`). |
| `payment_succeeded` | For an invoice with a line for the top-up item price only: applies paid packs (`applyPaidTopUps`), exactly as the page's own apply does — what grants a pack whose buyer closed the tab. While a grant-carrying pack's block is not visible yet it answers **500 on purpose**, so Chargebee redelivers once the block is there. Any other payment is ignored. |
| `grant_blocks_created` | Credits were added to a subscription — any credits: a pack's grant, a charge or grant made **by hand in the Chargebee dashboard**, a renewal's grant, billing's own allocate. The org whose **current** subscription it names is re-read (`syncFromChargebee`): its LiteLLM limit rises, and an exhausted team reopens, within seconds instead of at the daily resync. A declined pack's credits stay held back there. A subscription that is no org's current one (an ended one, a `cbdemo_` one) is logged `billing.webhook.grant_unlinked_subscription` and answered 200 — never retried. |
| `payment_failed`, `alert_status_changed` | Logged only. |
| Any event for a `cbdemo_` customer | Chargebee's sample data (the **Test Webhook** button, e.g. `subscription_created` for `cbdemo_tom`): 200, logged `billing.webhook.sample_event`, nothing done. |

Any other event type is acknowledged with **200** and ignored — nothing is logged
or stored for it. An unknown **real** customer on an event billing acts on answers
**500** (`unmapped customer`), so Chargebee retries it.

**Delivery, measured end to end (2026-09-28).** Endpoint `whv2_169rpvVWV3RVFFh0`
("test"): all events, API version v2, Basic auth, then pointed at a `cloudflared`
quick tunnel (to the platform, which forwarded it in those days). A ₹1 pack
charged straight in Chargebee — invoice 109, no billing page involved, so only the
webhook could record it — produced five events, every one delivered `succeeded`:

| Event | Billing |
|---|---|
| `payment_succeeded` | Recorded invoice 109's grant (`catalogue_grant`, 50) in `topup_grant`, 3 s after payment |
| `invoice_generated` | Acknowledged, ignored |
| `grant_blocks_created` | Acknowledged, ignored then; today it re-reads the org (above) |
| `ledger_updated` | Acknowledged, ignored |
| `ledger_account_balance_updated` | Acknowledged, ignored |

**Direct to billing, measured (2026-09-30)** on the test site through a tunnel to
Caddy's app host: real `customer_changed` deliveries `ev_AzyoW0VWhVc2QURM` and
`ev_AzZMkgVWhVgznUur` → `succeeded`. Chargebee's Test Webhook sample
(`subscription_created` for `cbdemo_tom`) got 500 before the `cbdemo_` rule and
200 after.

**Read delivery per endpoint, not per event.** `GET /events` returns a top-level
`webhook_status` that stays `not_configured` even when the event was delivered to
an endpoint added under Webhooks; the delivery is in `webhooks[]`:

```json
{ "event": { "event_type": "payment_succeeded", "api_version": "v2",
             "webhook_status": "not_configured",
             "webhooks": [ { "id": "whv2_169rpvVWV3RVFFh0", "webhook_status": "succeeded",
                             "object": "webhook" } ] } }
```

Before any endpoint existed (up to 2026-09-28 08:00), `webhooks` was empty on every
event. `GET /webhook_endpoints` lists the endpoints themselves.

**Subscribe to what is handled.** Three of the five events a top-up produces are
acknowledged and ignored, so an endpoint taking ALL events carries mostly noise.
Selecting only the events in the table above loses nothing.

**Setting it up.** *Settings → Configure Chargebee → Webhooks*: URL
`https://<app host>/api/webhooks/chargebee` (production
`https://app.enwithai.com/api/webhooks/chargebee`), *Protect webhook URL with
basic authentication* ticked with billing's `CHARGEBEE_WEBHOOK_USER` /
`CHARGEBEE_WEBHOOK_PASSWORD`, API version V2. Wrong or missing credentials answer
401 `webhook-unauthorized`, and Chargebee retries. A developer machine needs a
`cloudflared` tunnel to Caddy's app host — never straight to billing's `:4300`,
which would publish `/api/internal/*`:

```bash
cloudflared tunnel --url https://127.0.0.1:443 --http-host-header dev.127.0.0.1.nip.io \
  --origin-server-name dev.127.0.0.1.nip.io --no-tls-verify
```

The tunnel's URL changes on every restart, so the endpoint's URL has to be updated
in Chargebee each time.

A body with no `id` or `event_type` gets **400**. A failed handler returns **500**,
not 200, and Chargebee sees that status. Billing
keeps no record of the event (see **Webhook replays** in SCHEMA.md), so handing the
failure back is what keeps it from vanishing: Chargebee retries a non-2xx, and a
webhook that keeps failing shows up in Chargebee's own delivery log.
