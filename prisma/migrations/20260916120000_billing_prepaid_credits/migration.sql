-- Prepaid token billing.
--
-- Hand-authored rather than generated, deliberately. Two of the indexes below
-- are PARTIAL unique indexes, which Prisma's schema language cannot express.
-- `prisma migrate dev` reconciles against schema.prisma, sees objects it did
-- not model as drift, and drops them — which for these two would silently
-- remove the guarantee that a window bills exactly once. Apply with
-- `prisma migrate deploy`, never `migrate dev`.
--
-- This migration touches only billing tables. `tenants` and `org_llm_gateways`
-- are owned by enginos-platform and are referenced here by value, not by
-- foreign key, so this service can never propose a change to them.

-- ── billing_account ─────────────────────────────────────────────────────────
CREATE TABLE "billing_account" (
    "tenant_id"                 UUID           NOT NULL,
    "routing_slug"              VARCHAR(100)   NOT NULL,
    "chargebee_customer_id"     VARCHAR(100),
    "chargebee_subscription_id" VARCHAR(100),
    "chargebee_item_price_id"   VARCHAR(100),
    "ledger_unit_id"            VARCHAR(50),
    "granted_credits"           DECIMAL(20,10) NOT NULL DEFAULT 0,
    "budget_usd"                DECIMAL(20,10) NOT NULL DEFAULT 0,
    "cached_balance_credits"    DECIMAL(20,10),
    "cached_balance_at"         TIMESTAMPTZ,
    "billing_email"             VARCHAR(320),
    "current_term_start"        TIMESTAMPTZ,
    "current_term_end"          TIMESTAMPTZ,
    "status"                    VARCHAR(20)    NOT NULL DEFAULT 'unlinked',
    "sync_from"                 TIMESTAMPTZ    NOT NULL,
    "created_at"                TIMESTAMPTZ    NOT NULL DEFAULT now(),
    "updated_at"                TIMESTAMPTZ    NOT NULL DEFAULT now(),

    CONSTRAINT "billing_account_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "billing_account_status_check"
        CHECK ("status" IN ('unlinked','active','cancelled','exhausted')),
    -- A negative grant or budget is never a valid state; catching it here stops
    -- a sign error becoming a credit the customer did not buy.
    CONSTRAINT "billing_account_grant_nonneg"  CHECK ("granted_credits" >= 0),
    CONSTRAINT "billing_account_budget_nonneg" CHECK ("budget_usd" >= 0)
);

CREATE UNIQUE INDEX "billing_account_routing_slug_key"
    ON "billing_account" ("routing_slug");

-- Postgres allows many NULLs in a unique index, so these hold only once the
-- ids exist. One tenant, one Chargebee customer; one tenant, one subscription.
CREATE UNIQUE INDEX "billing_account_customer_key"
    ON "billing_account" ("chargebee_customer_id")
    WHERE "chargebee_customer_id" IS NOT NULL;

CREATE UNIQUE INDEX "billing_account_subscription_key"
    ON "billing_account" ("chargebee_subscription_id")
    WHERE "chargebee_subscription_id" IS NOT NULL;

CREATE INDEX "billing_account_status_idx" ON "billing_account" ("status");

-- ── credit_ledger_entry ─────────────────────────────────────────────────────
CREATE TABLE "credit_ledger_entry" (
    "id"                     UUID           NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"              UUID           NOT NULL,
    "entry_type"             VARCHAR(16)    NOT NULL,
    "delta_credits"          DECIMAL(20,10) NOT NULL,
    "source_ref"             VARCHAR(100)   NOT NULL,
    "billed_usd"             DECIMAL(20,10),
    "chargebee_operation_id" VARCHAR(50),
    "occurred_at"            TIMESTAMPTZ    NOT NULL DEFAULT now(),

    CONSTRAINT "credit_ledger_entry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credit_ledger_entry_tenant_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "billing_account" ("tenant_id") ON DELETE CASCADE,
    CONSTRAINT "credit_ledger_entry_type_check"
        CHECK ("entry_type" IN ('grant','consume','adjustment','expiry')),
    -- Direction is part of the type's meaning: a grant that decrements, or a
    -- consume that increments, is a bug that would corrupt the balance silently.
    CONSTRAINT "credit_ledger_entry_direction_check" CHECK (
        ("entry_type" = 'grant'   AND "delta_credits" >  0) OR
        ("entry_type" = 'consume' AND "delta_credits" <= 0) OR
        ("entry_type" = 'expiry'  AND "delta_credits" <= 0) OR
        ("entry_type" = 'adjustment')
    )
);

-- THE anti-double-charge. A replayed webhook (source_ref = Chargebee event id)
-- or a replayed capture (source_ref = batch UUID) collides here instead of
-- writing a second entry. This constraint, not any code path, is the guarantee.
CREATE UNIQUE INDEX "credit_ledger_tenant_source_uq"
    ON "credit_ledger_entry" ("tenant_id", "source_ref");

CREATE INDEX "credit_ledger_tenant_occurred_idx"
    ON "credit_ledger_entry" ("tenant_id", "occurred_at" DESC);

-- ── usage_sync_batch ────────────────────────────────────────────────────────
CREATE TABLE "usage_sync_batch" (
    "id"                        UUID           NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"                 UUID           NOT NULL,
    "chargebee_subscription_id" VARCHAR(100),
    "ledger_unit_id"            VARCHAR(50),
    "kind"                      VARCHAR(12)    NOT NULL DEFAULT 'window',
    "window_start"              TIMESTAMPTZ    NOT NULL,
    "window_end"                TIMESTAMPTZ    NOT NULL,
    "span_count"                BIGINT         NOT NULL DEFAULT 0,
    "billed_usd"                DECIMAL(20,10) NOT NULL DEFAULT 0,
    "provider_usd"              DECIMAL(20,10) NOT NULL DEFAULT 0,
    "margin_usd"                DECIMAL(20,10) NOT NULL DEFAULT 0,
    "consume_credits"           DECIMAL(20,10) NOT NULL DEFAULT 0,
    "status"                    VARCHAR(20)    NOT NULL DEFAULT 'pending',
    "attempts"                  INTEGER        NOT NULL DEFAULT 0,
    "last_error"                TEXT,
    "chargebee_operation_id"    VARCHAR(50),
    "balance_after"             DECIMAL(20,10),
    "hatchet_run_id"            VARCHAR(100),
    "created_at"                TIMESTAMPTZ    NOT NULL DEFAULT now(),
    "captured_at"               TIMESTAMPTZ,
    "updated_at"                TIMESTAMPTZ    NOT NULL DEFAULT now(),

    CONSTRAINT "usage_sync_batch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "usage_sync_batch_tenant_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "billing_account" ("tenant_id") ON DELETE CASCADE,
    CONSTRAINT "usage_sync_batch_status_check"
        CHECK ("status" IN ('pending','captured','failed','skipped')),
    CONSTRAINT "usage_sync_batch_kind_check"
        CHECK ("kind" IN ('window','adjustment')),
    -- Half-open [start, end): a zero-width or inverted window would either bill
    -- nothing forever or double-count its boundary.
    CONSTRAINT "usage_sync_batch_window_order" CHECK ("window_end" > "window_start"),
    CONSTRAINT "usage_sync_batch_amounts_nonneg"
        CHECK ("billed_usd" >= 0 AND "consume_credits" >= 0 AND "span_count" >= 0)
);

-- A time window bills EXACTLY ONCE. Adjustments are excluded because a window
-- can legitimately carry several — one per late-arrival sweep that found spans.
--
-- This is why the cron can overlap itself safely: the second run fails this
-- insert rather than charging the customer twice.
CREATE UNIQUE INDEX "usage_sync_batch_window_uq"
    ON "usage_sync_batch" ("tenant_id", "window_start")
    WHERE "kind" = 'window';

-- ONE capture in flight per tenant. Makes the recovery path and a fresh window
-- mutually exclusive without a lock, a lease, or anything that can expire.
CREATE UNIQUE INDEX "usage_sync_batch_pending_uq"
    ON "usage_sync_batch" ("tenant_id")
    WHERE "status" = 'pending';

CREATE INDEX "usage_sync_batch_cursor_idx"
    ON "usage_sync_batch" ("tenant_id", "window_end" DESC);

CREATE INDEX "usage_sync_batch_status_idx" ON "usage_sync_batch" ("status");

-- ── processed_billing_event ─────────────────────────────────────────────────
-- Chargebee does not sign webhooks and retries aggressively. Every event id is
-- claimed here before any effect, so a redelivery never reaches a handler.
CREATE TABLE "processed_billing_event" (
    "event_id"     VARCHAR(100) NOT NULL,
    "event_type"   VARCHAR(64)  NOT NULL,
    "tenant_id"    UUID,
    "received_at"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "processed_at" TIMESTAMPTZ,
    "error"        TEXT,

    CONSTRAINT "processed_billing_event_pkey" PRIMARY KEY ("event_id")
);

CREATE INDEX "processed_billing_event_received_idx"
    ON "processed_billing_event" ("received_at" DESC);
