-- The billing currency follows the billing address.
--
-- An org's billing country decides the currency it is billed in — India in
-- INR, everywhere else (and an org with no address yet) in USD; the rule is
-- configuration (models/currency.ts). Chargebee fixes a subscription's
-- currency for good and keys its credit ledger per subscription, so an org
-- whose address moves it to another currency gets a NEW subscription in that
-- currency, with its credit state carried across: the currency switch.
--
--   billing_account.billing_country   the country the org CONFIRMED; the one
--                                     part of the address kept here, because it
--                                     decides the org's subscription. The
--                                     address itself is on the Chargebee
--                                     customer.
--   billing_account.currency          the linked subscription's currency,
--                                     mirrored from Chargebee at every link.
--                                     NOT backfilled: SQL cannot know it, and
--                                     readers fall back to the live
--                                     subscription's `currency_code` until the
--                                     next sync stores it.
--   billing_account.status            gains `switching`: the credits are being
--                                     moved; no usage is sent and nothing but
--                                     the switch may write the row.
--   currency_switch                   one row per switch — the stored request
--                                     for each money movement of it.
--
-- Additive: every existing row keeps its status and gets NULL in both new
-- columns, which is "no address yet" and "currency not read yet".
--
-- Hand-authored like the others: `prisma migrate dev` reconciles against
-- schema.prisma and drops objects it did not model — here the partial unique
-- index below. Apply with `prisma migrate deploy`.

-- ── 1. billing_account ──────────────────────────────────────────────────────
ALTER TABLE "billing_account"
    ADD COLUMN "billing_country" VARCHAR(2),
    ADD COLUMN "currency"        VARCHAR(3);

-- Upper case, as billing compares them: `in` and `IN` must never be two
-- countries, nor `inr` and `INR` two currencies.
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_billing_country_check"
    CHECK ("billing_country" IS NULL OR "billing_country" ~ '^[A-Z]{2}$');
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_currency_check"
    CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$');

-- Restated whole, so the constraint matches ACCOUNT in src/models/account-status.ts exactly.
ALTER TABLE "billing_account" DROP CONSTRAINT IF EXISTS "billing_account_status_check";
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_status_check"
    CHECK ("status" IN ('unlinked', 'activating', 'active', 'cancelled', 'exhausted', 'switching'));

-- ── 2. currency_switch ──────────────────────────────────────────────────────
--
-- WHY A TABLE. A switch moves money in Chargebee three ways — allocates on the
-- new subscription B (the carry, guarded by `topup_grant` rows like any
-- allocate), captures on the old one A until it is empty (the drain), and one
-- capture on B carrying A's consumption so B's ledger continues A's (the
-- mirror). A capture takes a client-supplied operation id, and that id is
-- written HERE, with its amount, BEFORE it is sent; a retry re-sends the same
-- id, which Chargebee applies at most once. So a crash, a timeout or two
-- advancers at once can delay a switch, never move money twice.
--
--   REQUESTED   asked for; nothing has changed, in Chargebee or here
--   MOVING      the account is `switching`; credits carried, A drained, B mirrored
--   LINKED      billing points at B; the cap is re-set, then A is cancelled
--   DONE        finished
--   ABANDONED   given up before anything moved
--
-- NEVER DELETE A ROW. An open one is money in flight; a finished one is the
-- record of where an org's credits went. For the same reason the foreign key
-- is RESTRICT, not CASCADE, as for `topup_grant`.
CREATE TABLE "currency_switch" (
    "id"                   UUID           NOT NULL,
    "tenant_id"            UUID           NOT NULL,

    -- A, and where the org is going: B's currency and the plan B is made on.
    "from_subscription_id" VARCHAR(100)   NOT NULL,
    "from_currency"        VARCHAR(3)     NOT NULL,
    "to_currency"          VARCHAR(3)     NOT NULL,
    "to_item_price_id"     VARCHAR(100)   NOT NULL,
    -- B, once created or found. Set once.
    "to_subscription_id"   VARCHAR(100),
    -- The account's credit unit when MOVING started (null: A had no wallet,
    -- and there is nothing to move).
    "ledger_unit_id"       VARCHAR(50),

    "status"               VARCHAR(16)    NOT NULL,

    -- Credits captured off A by drains that SETTLED.
    "drained"              DECIMAL(20,10) NOT NULL DEFAULT 0,
    -- A drain on the wire or of unknown outcome: id and amount stored before
    -- it is sent, re-sent only under that id until it settles.
    "drain_operation_id"   UUID,
    "drain_amount"         DECIMAL(20,10),
    -- The capture on B that carries A's consumption. Stored before it is sent.
    "mirror_operation_id"  UUID,
    "mirror_amount"        DECIMAL(20,10),
    "mirrored_at"          TIMESTAMPTZ(3),

    -- One advancer at a time; a lease, so a dead advancer's runs out.
    "lease_until"          TIMESTAMPTZ(3),
    "attempt_count"        INTEGER        NOT NULL DEFAULT 0,
    "error"                TEXT,

    "created_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "moving_at"            TIMESTAMPTZ(3),
    "linked_at"            TIMESTAMPTZ(3),
    "completed_at"         TIMESTAMPTZ(3),

    CONSTRAINT "currency_switch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "currency_switch_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "billing_account" ("tenant_id") ON DELETE RESTRICT,

    CONSTRAINT "currency_switch_status_check"
        CHECK ("status" IN ('REQUESTED', 'MOVING', 'LINKED', 'DONE', 'ABANDONED')),
    -- A switch is between two currencies, both as billing writes them.
    CONSTRAINT "currency_switch_currencies" CHECK (
        "from_currency" ~ '^[A-Z]{3}$' AND "to_currency" ~ '^[A-Z]{3}$' AND "from_currency" <> "to_currency"
    ),
    CONSTRAINT "currency_switch_amounts_nonneg" CHECK (
        "drained" >= 0
        AND ("drain_amount" IS NULL OR "drain_amount" >= 0)
        AND ("mirror_amount" IS NULL OR "mirror_amount" >= 0)
        AND "attempt_count" >= 0
    ),
    -- A capture cannot be re-sent safely without the amount it was sent with,
    -- nor an amount settled without the id that proves it moved.
    CONSTRAINT "currency_switch_drain_complete" CHECK (("drain_operation_id" IS NULL) = ("drain_amount" IS NULL)),
    CONSTRAINT "currency_switch_mirror_complete" CHECK (("mirror_operation_id" IS NULL) = ("mirror_amount" IS NULL)),
    -- The state machine's own record, so a row cannot claim a step it did not take.
    CONSTRAINT "currency_switch_moving_when_started" CHECK (
        "status" NOT IN ('MOVING', 'LINKED', 'DONE') OR "moving_at" IS NOT NULL
    ),
    CONSTRAINT "currency_switch_linked_to_b" CHECK (
        "status" NOT IN ('LINKED', 'DONE') OR ("to_subscription_id" IS NOT NULL AND "linked_at" IS NOT NULL)
    ),
    -- Billing is relinked to B only once no capture of the switch is in
    -- flight: the drain settled, and the mirror, if there was one, landed.
    CONSTRAINT "currency_switch_settled_when_linked" CHECK (
        "status" NOT IN ('LINKED', 'DONE')
        OR ("drain_operation_id" IS NULL AND ("mirror_operation_id" IS NULL OR "mirrored_at" IS NOT NULL))
    ),
    CONSTRAINT "currency_switch_done_when_completed" CHECK (("status" = 'DONE') = ("completed_at" IS NOT NULL))
);

-- ONE OPEN SWITCH PER TENANT. Two would each carry the org's credits to a
-- subscription of their own. A partial index — Prisma cannot express it, which
-- is why this migration must never be replayed through `migrate dev`.
CREATE UNIQUE INDEX "currency_switch_open_uq" ON "currency_switch" ("tenant_id")
    WHERE "status" IN ('REQUESTED', 'MOVING', 'LINKED');

-- The worker's minute: every open switch, advanced.
CREATE INDEX "currency_switch_status_idx" ON "currency_switch" ("status");
