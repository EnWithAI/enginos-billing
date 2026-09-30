# How billing state gets updated

Which mechanism writes which field, and what happens when one of them does not fire.

"Is it the webhook?" is the usual question, and the answer is: for one third of the
state, yes. The rest is written by a cron that polls, and by a pull the UI triggers.
Knowing which is which is the difference between "a delivery was missed" and "the
worker is down" — two very different pages to open at 2am.

## The three mechanisms

```
                    ┌─ PUSH ──  Chargebee → billing  webhook, production default
subscription state ─┤
                    └─ PULL ──  billing → Chargebee  after checkout, from the UI

consumption ─────────  POLL ──  billing → ClickHouse → Chargebee     every minute
```

The push is Chargebee calling billing DIRECTLY at `POST /api/webhooks/chargebee`
— billing's only public path — and billing checks the HTTP Basic credentials
itself (`CHARGEBEE_WEBHOOK_USER` / `CHARGEBEE_WEBHOOK_PASSWORD`; either unset →
401). enginos-platform and crewpe-ui are not on that path.

There is no fourth, and there is deliberately no fifth that keeps a local copy of
the customer's credits. Anything about the money that is not in the list above is
answered by asking Chargebee.

---

## 1. Subscription and grant state — push, or pull

Both paths converge on `syncFromChargebee()`, which re-reads the customer's
subscriptions from Chargebee and applies them through `syncSubscription()`:

| Path | Trigger | Caller |
|---|---|---|
| Push | every `subscription_*` event (eight of them) — the body is only a trigger; nothing in it is written | [`webhooks/chargebee/route.ts`](../src/app/api/webhooks/chargebee/route.ts) |
| Push | `grant_blocks_created` — credits added to a subscription by any route (a grant or charge made by hand in the dashboard, a renewal's grant, a pack's grant, billing's own allocate). The event names no customer, so the org is found by its CURRENT subscription (`findTenantIdBySubscriptionId`; any other is logged `billing.webhook.grant_unlinked_subscription` and acknowledged) | as above |
| Provision | enginos-platform once an org is created, and the billing page for an org with no subscription: subscribe the free plan, then pull until Chargebee's credit ledger is there | [`internal/provision/route.ts`](../src/app/api/internal/provision/route.ts) |
| Pull | on request — an operator, or a caller repairing one tenant | [`internal/sync-subscription/route.ts`](../src/app/api/internal/sync-subscription/route.ts) |
| Repair | the daily reconcile, for every tenant with a Chargebee customer — the backstop for any webhook that was lost | [`worker/hatchet-worker.ts`](../worker/hatchet-worker.ts) |

**What it writes**

| Target | Field |
|---|---|
| `billing_account` | `chargebee_subscription_id`, `chargebee_item_price_id`, `ledger_unit_id`, `current_term_start/end`, `status` |
| `billing_account` | `last_processed_ingested_at` = `now()` — set once, never rewound; moved forward to `now()` only when an account comes back from a cancellation |
| Chargebee + `topup_grant` | on the free plan with `FREE_PLAN_CREDITS` set, the one-time allocate of `FREE_PLAN_CREDITS` less the plan's own grant, under the tenant's `free-plan-credits` row — once per org, ever |
| `billing_account` | `ledger_unit_id`, adopted from that allocate (`adoptLedgerUnit`) when the plan's zero grant left the subscription no wallet — only while null, only for the current subscription |
| LiteLLM | `max_budget` (spend baseline + Chargebee's live grant blocks), `budget_duration: null`, `billing_managed` / baseline / baseline-term metadata |

**It records no balance.** The plan's grant is Chargebee's, created from the item
price's Credit Grant configuration, and read back whenever the cap is set or the
page is rendered. The one grant this path makes itself — the free plan's
credits, into `FREE_PLAN_CREDIT_UNIT` when there is no wallet yet — is recorded
in `topup_grant` only as the fact that it was made.

**Why two paths exist.** The webhook is the production default, but push alone is not
enough: Chargebee cannot reach a developer machine without a tunnel, and even in
production a delivery can be delayed, dropped, or land mid-deploy. A customer who has paid must
not be left looking at "No subscription".

**Why running both is safe.** Neither adds anything twice. Both read the subscription
from Chargebee and apply what it says, so whichever lands second converges on the
same state; the free plan's credits, the one thing a link can grant, are claimed
in `topup_grant` first, so the second run finds the row and grants nothing. This
used to require a shared idempotency key on a grant entry (`termGrantRef()`),
and getting it wrong was not theoretical: the two paths once
used *different* keys, both fired after every checkout, and a 2,000-credit
purchase was recorded as 4,000 with a $4 cap. The class of bug is gone with the
entry.

**The one thing that must not be repeated** is setting the usage cursor. A second
run that reset `last_processed_ingested_at` to `now()` would silently skip every
call that ended in between, so `ensureBillingCursor()` is create-only — its UPDATE
carries `WHERE last_processed_ingested_at IS NULL` — and a test pins it.

---

## 2. Consumption — a poll, and the direction is inverted

This is the part that is *not* webhook-driven, and it is most of the movement.

```
billing-usage-sync, every minute
    cursor → range to now − lag (≤ BILLING_MAX_RANGE_MS) → capture in Chargebee → advance cursor
```

Nothing notifies us that usage happened. The worker polls ClickHouse and **pushes
charges to Chargebee**. For spend, we are the client, not the recipient.

It reads `tenant_<slug>.span_nodes FINAL` as it is — billing adds and changes
nothing in ClickHouse — and bills each LLM call by when it ENDED
(`addMilliseconds(Timestamp, duration_ms)`). A range runs from the cursor to
`now − BILLING_LAG_MS` (60 000 by default, never under 30 000), at most
`BILLING_MAX_RANGE_MS` (1 h) long: ordinarily the minute since the last pass,
an hour at a time in a catch-up.

**What it writes**

| Target | Field |
|---|---|
| Chargebee | `POST /ledger_operations/capture`, under an id written locally first |
| `chargebee_sync` | the row, with its id and its range, BEFORE the call — and only while the cursor still sits at the range's start (`openWindow`); its status after it |
| `billing_account` | `last_processed_ingested_at` (a call end time), by compare-and-set, once the range resolves — or past an empty range, while no row owns its start (`advancePastEmptyWindow`) |
| `billing_account` | `status → exhausted` when Chargebee reports no usable balance |

That is the entire write set. Nothing records which individual spans were billed:
the window's row records the range and the total, the cursor records how far the
worker got, and Chargebee holds the money.

The same tick first runs `activatePending()`, retrying every account held in
`activating` — which is why a failed budget push recovers on its own within a minute
without any Chargebee involvement, and why a free-plan org whose one-time credits
did not land is granted them on the next tick (once: the `free-plan-credits` row).

---

## 3. Lifecycle events

`subscription_cancelled` and `subscription_deleted` are triggers for the same pull
as every other subscription event: `syncFromChargebee` cancels the account when no
subscription is active and the one it is linked to has ended in Chargebee. So the
daily reconcile repairs a cancellation whose webhook never arrived, and a failed
release of the team (a LiteLLM outage at the moment of cancelling) fails the
webhook with a 500 and is retried by Chargebee's redelivery and by the reconcile.

`payment_failed` and `alert_status_changed` are still webhook-only, and only logged.
An event for Chargebee's `cbdemo_` sample customer or subscription (its **Test
Webhook** button) is answered 200 and nothing is done; an event billing acts on
for an unknown REAL customer answers 500, so Chargebee retries it.

---

## Which mechanism is responsible for a stale field

| Symptom | Mechanism to check |
|---|---|
| New org shows "Setting up your free plan" | Provision — the platform's call failed or has not run; each load of the billing page tries again. Check `billing.free_plan.*` in the logs |
| New free-plan org held "Activating" / no credits | The free plan's one-time grant — `activatePending()` retries it each minute. Check `billing.free_credits.*` (`no_credit_unit` means `FREE_PLAN_CREDIT_UNIT` is unset) and the tenant's `free-plan-credits` row in `topup_grant` |
| Credits missing after a top-up | The top-up's own apply, then `payment_succeeded` — both record Chargebee's grant block; check Chargebee's webhook delivery log (`webhooks[]` on the event) |
| Credits granted by hand in Chargebee not in the LiteLLM cap | Push — `grant_blocks_created` re-reads the org within seconds; check its delivery in Chargebee's log, and `billing.webhook.grant_unlinked_subscription` (granted on a subscription that is not the org's current one). The daily reconcile is the backstop for a lost webhook |
| Credits not decreasing with usage | Poll — is the worker up? Is there an unresolved `chargebee_sync` row, or is the account `exhausted`? Its `status` names which of the eight things happened. |
| "Last synced" frozen | Poll — the cursor only moves past a resolved range. Check the logs for `billing.sync.out_of_credits`, `billing.sync.rate_limited`, `billing.sync.invalid` or `billing.sync.unknown_outcome`. |
| Cursor moving but "last synced" old | Normal for a quiet tenant: an empty range advances the cursor and writes no row. The billing page reports both, and only the cursor means billing is healthy. |
| Stuck "Activating your credits" | Poll — `activatePending()` retries each minute; the push, or the free plan's allocate, is failing |
| Cancelled customer still serving | Webhook, then the daily reconcile — both re-read Chargebee and release the budget |
| Active customer refused by LiteLLM | Poll — `reopenBlockedActive()` re-opens an active account's team each minute when BILLING blocked it (`billing.budget.active_but_blocked`); a team blocked by hand is left alone. It runs after the usage sync, bounded by a deadline (`billing.budget.gate_check_deadline`) |
| Cancelled customer refused by LiteLLM | Expected: `release()` hands the team back, and the platform's budget for it is $0 |
| Refused usage on an ended subscription | Written off once (`billing.sync.written_off`); it no longer holds the tenant |
| Leftover credits survived a renewal | Expected: the plan's grant rolls over; the cap follows whatever `/grant_blocks` reports |
| A call's usage never billed | Its span landed more than `BILLING_LAG_MS` after the call ended, behind the cursor — see **Gaps** |

---

## Gaps

### A tenant stopped on credits is quieter than it looks

An account Chargebee refuses for want of balance logs
`billing.sync.out_of_credits` at `error` once, becomes `exhausted`, and from
then is held whole: no retry, no Chargebee call, no ClickHouse read, only the
LiteLLM block re-asserted each tick (the sweep counts it under `exhausted`).
That is correct and self-healing — the usage stays in ClickHouse in front of
the cursor and goes through the moment new credits take the account out of
`exhausted` (a top-up, or a grant made by hand, which `grant_blocks_created`
brings in within seconds), with no requeue step — but it is also indefinite.
`billing.sync.behind` fires once the cursor is more than seven days back, which
is the real alarm, because tenant tables drop spans after 90 days.

Indefinite only while the subscription is live. Once it has ENDED — the account
is cancelled, or now bills another subscription — no top-up can reach it, so
the refused window is written off (`billing.sync.written_off`, once, at
`error`) and stops holding the tenant; a cancelled account raises no
`billing.sync.behind`.

### A span that lands after the lag is never billed

A range is read once it is `BILLING_LAG_MS` old, measured on the call's END
time, and the cursor then moves past it for good. A span that reaches
ClickHouse later than that is behind the cursor and nothing reads it again.
MEASURED 2026-09-30 over 421 local spans: p50 23 s and p99 44 s from the call's
end to the row, 3 over 45 s and 1 over 60 s — so the 60 s default loses about
one span in four hundred, and the local `.env`'s 45 s about three. Below the
30 s floor (0 included) the process refuses to start, because the live `.env`
once carried `BILLING_LAG_MS=120`, meant as 120 s.

### An unknown capture outcome blocks that tenant until Chargebee answers

An unresolved `chargebee_sync` row holds the whole tenant: nothing newer is read
until `GET /ledger_operations/{id}` returns a definite answer. This is
deliberate — reading past an unknown would offer the same usage under a second
id, and if the first had landed the customer pays twice — but a long Chargebee
outage means a tenant billing nothing rather than billing late.
`billing.sync.unauthenticated` separates the case a person can fix (a rotated
API key, which stalls *every* tenant at once) from a transient one.

### A misconfigured subscription now holds instead of skipping

A subscription with no prepaid ledger is `INVALID` and stops the cursor, where it
used to be skipped past. That is the right trade — the usage is still there to
bill once the ledger exists — but it means a misconfiguration costs nothing until
someone notices, and then costs the whole backlog at once. `billing.sync.no_ledger`
fires every retry, and `billing.sync.behind` is the backstop at seven days.

### Nothing cross-checks Chargebee against ClickHouse

There is no equivalent of the old `reconcile.ts`, and there cannot be a local
one: the two records it compared — the ledger and the old batch table — no
longer exist. What can be compared is Chargebee's drawdown against the LiteLLM team's
spend, which the end-to-end script checks (`U8`) and nothing checks in
production. A drift there is the signal that usage is being read but not billed,
or billed twice.

---

## Local development

Chargebee cannot reach `localhost`, so on a developer machine:

- **The push path fires only through a tunnel.** Without one no webhook arrives
  at all — expected, not a bug. The tunnel goes to **Caddy's app host**, whose
  one-path rule sends only `POST /api/webhooks/chargebee` to billing:

  ```
  cloudflared tunnel --url https://127.0.0.1:443 --http-host-header dev.127.0.0.1.nip.io \
    --origin-server-name dev.127.0.0.1.nip.io --no-tls-verify
  ```

  **Never tunnel straight to billing's `:4300`**: that publishes
  `/api/internal/*`, which authenticates no caller. Set the tunnel's URL plus
  `/api/webhooks/chargebee` on the Chargebee webhook, with billing's
  credentials. MEASURED 2026-09-30 this way: two real `customer_changed`
  deliveries `succeeded`, and through the tunnel `/api/internal/sync` answered
  404. (2026-09-28, then through the platform, which no longer takes part: a
  top-up's five events all `succeeded`, and `payment_succeeded` recorded the
  grant three seconds after payment.) The quick tunnel's URL changes on every
  restart, and Chargebee's webhook URL with it.
- **The provision path runs at sign-up and on page load** for an org with no
  subscription; the plain pull runs only when asked.
- **The poll runs normally** — the worker reaches ClickHouse and Chargebee outbound
  without trouble.

So without a tunnel a change made in the Chargebee dashboard — credits granted by
hand included — does not arrive within seconds by `grant_blocks_created`: it
appears only at the worker's daily reconcile or a pull, and a term renewal waits
the same way. To exercise the push path, POST a synthetic event to billing's
`/api/webhooks/chargebee` — directly on `localhost:4300`, or through Caddy's app
host, which routes exactly that path to billing — with the basic-auth
credentials from billing's `.env` (`CHARGEBEE_WEBHOOK_USER` /
`CHARGEBEE_WEBHOOK_PASSWORD`): the same check Chargebee goes through.
