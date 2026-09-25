-- Six billing tables become two.
--
--   billing_account   tenant ↔ Chargebee mapping
--   usage_sync        the ClickHouse polling cursor
--
-- Everything else in the usage-billing path is removed, because Chargebee
-- already holds it: credits, grants, top-ups, consumption and balance. What
-- Postgres keeps is the mapping and the cursor.
--
-- `processed_billing_event` is untouched. It is webhook replay protection, not
-- a usage-billing table, and with the ledger's (tenant_id, source_ref) unique
-- index gone it is now the ONLY thing standing between a replayed Chargebee
-- webhook and a second subscription change.
--
-- ORDER MATTERS. usage_sync is created and populated BEFORE anything is
-- dropped, so a failure part-way leaves the old tables intact and the service
-- still able to bill from them.
--
-- This migration does NOT preserve billing history. Cursors, captures, ledger
-- entries and event keys are all discarded; every subscribed tenant restarts
-- its poll at now(). See section 2.
--
-- Hand-authored like the others: `prisma migrate dev` reconciles against
-- schema.prisma and drops objects it did not model. Apply with
-- `prisma migrate deploy`, then `prisma migrate resolve`.

-- ── 1. usage_sync ───────────────────────────────────────────────────────────
CREATE TABLE "usage_sync" (
    "tenant_id"                  UUID           NOT NULL,

    -- THE cursor: span_nodes.ingested_at of the last event captured.
    "last_processed_ingested_at" TIMESTAMPTZ(3) NOT NULL,

    -- Tie-break for events sharing that millisecond: TraceId:SpanId, '' = none.
    -- COLLATE "C" so it compares byte by byte, exactly as ClickHouse orders it.
    -- The database default (en_US) ignores punctuation like ':' at the first
    -- level and would disagree with ClickHouse about which key comes next.
    "last_processed_event_key"   VARCHAR(200) COLLATE "C" NOT NULL DEFAULT '',

    -- A capture whose outcome is unknown, written BEFORE it is sent. This is
    -- the whole of the old usage_sync_batch: the id to ask Chargebee about,
    -- and where the cursor moves if the answer is "it landed".
    "pending_operation_id"       UUID,
    "pending_ingested_at"        TIMESTAMPTZ(3),
    "pending_event_key"          VARCHAR(200) COLLATE "C",

    -- Tenant lease: one worker per tenant. PgBouncer runs in transaction mode,
    -- so session advisory locks are not reliable and a FOR UPDATE would hold a
    -- transaction open across the Chargebee HTTP call.
    "locked_until"               TIMESTAMPTZ(3),
    "locked_by"                  VARCHAR(100),

    "updated_at"                 TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "usage_sync_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "usage_sync_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "billing_account" ("tenant_id") ON DELETE CASCADE,

    -- All three pending columns move together or not at all. A half-written
    -- pending capture is an id nobody can resolve, or a position with no id.
    CONSTRAINT "usage_sync_pending_complete" CHECK (
        ("pending_operation_id" IS NULL AND "pending_ingested_at" IS NULL AND "pending_event_key" IS NULL)
     OR ("pending_operation_id" IS NOT NULL AND "pending_ingested_at" IS NOT NULL AND "pending_event_key" IS NOT NULL)
    ),

    -- A pending capture covers usage AFTER the cursor. Behind it would mean the
    -- cursor had already passed usage that is still in flight.
    CONSTRAINT "usage_sync_pending_ahead" CHECK (
        "pending_ingested_at" IS NULL
     OR "pending_ingested_at" >= "last_processed_ingested_at"
    )
);

-- ── 2. start every subscribed tenant's cursor at now() ─────────────────────
--
-- DELIBERATELY NOT a backfill from billing_cursor. Carrying the old positions
-- across was written and then dropped at the owner's request: the cutover
-- starts billing fresh, so usage already in ClickHouse before this migration
-- is never billed, whether or not the old cursor had reached it.
--
-- What that costs, stated plainly: any span ingested before now() is invisible
-- to the new poller for ever. What it cannot do is charge anyone twice — a
-- cursor that starts ahead of every existing span can only skip, never repeat.
--
-- A tenant with no subscription gets no row. It gets one at activation
-- (account.ts ensureUsageSync), which is the ordinary path.
INSERT INTO "usage_sync" ("tenant_id", "last_processed_ingested_at")
SELECT "tenant_id", now()
  FROM "billing_account"
 WHERE "chargebee_subscription_id" IS NOT NULL
ON CONFLICT ("tenant_id") DO NOTHING;

-- Say out loud what is being discarded. An unsettled capture may have landed in
-- Chargebee without us ever learning so; its money is Chargebee's record now,
-- and nothing here will try to settle, re-send or reconcile it. That is safe
-- in one direction only — no one is charged again — and lossy in the other.
DO $$
DECLARE unsettled INT; billed INT;
BEGIN
    SELECT count(*) INTO unsettled FROM "usage_sync_batch" WHERE "status" IN ('pending', 'held');
    SELECT count(*) INTO billed FROM "usage_sync_batch" WHERE "status" = 'captured';
    RAISE WARNING 'billing: discarding % settled and % unsettled usage_sync_batch rows, and every cursor position. Chargebee keeps whatever it was told; ClickHouse usage from before this migration will not be billed.', billed, unsettled;
END $$;

-- ── 3. drop the usage-billing tables ────────────────────────────────────────
--
-- billed_usage_event first: it has FKs into both of the others.
DROP TABLE IF EXISTS "billed_usage_event";
DROP TABLE IF EXISTS "usage_sync_batch";
DROP TABLE IF EXISTS "credit_ledger_entry";
DROP TABLE IF EXISTS "billing_cursor";

-- ── 4. trim billing_account to the mapping ──────────────────────────────────
--
-- Credit state belongs to Chargebee. `granted_credits` and `budget_usd` are
-- re-read from /grant_blocks on every budget push; the cached balance is read
-- from /ledger_account_balances when the page asks; `sync_from` is replaced by
-- usage_sync.last_processed_ingested_at, which is set at activation.
ALTER TABLE "billing_account"
    DROP CONSTRAINT IF EXISTS "billing_account_grant_nonneg",
    DROP CONSTRAINT IF EXISTS "billing_account_budget_nonneg",
    DROP COLUMN IF EXISTS "granted_credits",
    DROP COLUMN IF EXISTS "budget_usd",
    DROP COLUMN IF EXISTS "cached_balance_credits",
    DROP COLUMN IF EXISTS "cached_balance_at",
    DROP COLUMN IF EXISTS "sync_from";

-- `activating` was added by a later migration than the original CHECK; restate
-- the whole list so the constraint matches ACCOUNT in src/lib/db.ts exactly.
ALTER TABLE "billing_account" DROP CONSTRAINT IF EXISTS "billing_account_status_check";
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_status_check"
    CHECK ("status" IN ('unlinked', 'activating', 'active', 'cancelled', 'exhausted'));
