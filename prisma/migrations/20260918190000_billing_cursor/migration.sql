-- Usage billing moves from time WINDOWS to a CURSOR.
--
-- Before: progress was max(window_end) over usage_sync_batch, which is why an
-- empty `skipped` row was written every minute for every tenant, and a unique
-- index on (tenant_id, window_start) doubled as the lock.
--
-- After: billing_cursor is the ONE record of how far billing has reached, as
-- (last_processed_at, last_event_id) over ClickHouse span_nodes.ingested_at.
-- billed_usage_event holds one deterministic key per usage event
-- (TraceId:SpanId), so a range read twice, or a span the collector re-sends
-- with a later ingested_at, can never be charged twice. usage_sync_batch
-- remains the CAPTURE log only: one row per Chargebee capture, pending while
-- the outcome is unknown, and where the cursor moves when it settles.
--
-- Hand-authored like the others — apply as SQL, then `prisma migrate resolve`.

CREATE TABLE "billing_cursor" (
    "tenant_id"         UUID            NOT NULL,
    -- ClickHouse span_nodes.ingested_at of the last event fully processed.
    "last_processed_at" TIMESTAMPTZ(3)  NOT NULL,
    -- Tie-break for events sharing that instant: TraceId:SpanId, '' = none yet.
    -- COLLATE "C": compared byte by byte, exactly as ClickHouse orders it. The
    -- database default (en_US) ignores punctuation like ':' at the first level
    -- and would disagree with ClickHouse about which key comes next.
    "last_event_id"     VARCHAR(200)    COLLATE "C" NOT NULL DEFAULT '',
    -- Lease, not a transaction lock: billing talks to Postgres through
    -- PgBouncer in transaction mode, where session advisory locks are not
    -- reliable, and a FOR UPDATE would hold a transaction open across the
    -- Chargebee HTTP call.
    "locked_until"      TIMESTAMPTZ(3),
    "locked_by"         VARCHAR(100),
    "updated_at"        TIMESTAMPTZ(3)  NOT NULL DEFAULT now(),

    CONSTRAINT "billing_cursor_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "billing_cursor_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "billing_account" ("tenant_id") ON DELETE CASCADE
);

CREATE TABLE "billed_usage_event" (
    "tenant_id"   UUID            NOT NULL,
    "event_key"   VARCHAR(200)    NOT NULL,
    -- The capture that charged it. NULL for events billed by the old window
    -- mechanism, seeded at cutover so the cursor cannot charge them again.
    "batch_id"    UUID,
    "ingested_at" TIMESTAMPTZ(3)  NOT NULL,
    "created_at"  TIMESTAMPTZ(3)  NOT NULL DEFAULT now(),

    CONSTRAINT "billed_usage_event_pkey" PRIMARY KEY ("tenant_id", "event_key"),
    CONSTRAINT "billed_usage_event_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "billing_account" ("tenant_id") ON DELETE CASCADE,
    CONSTRAINT "billed_usage_event_batch_fkey" FOREIGN KEY ("batch_id")
        REFERENCES "usage_sync_batch" ("id") ON DELETE SET NULL
);

-- For retention: keys only matter while a re-sent copy of the span can still
-- arrive, so old ones are pruned.
CREATE INDEX "billed_usage_event_created_idx" ON "billed_usage_event" ("created_at");

-- Where the cursor moves when this capture settles. NULL on window-era rows.
ALTER TABLE "usage_sync_batch"
    ADD COLUMN "cursor_to_at"       TIMESTAMPTZ(3),
    ADD COLUMN "cursor_to_event_id" VARCHAR(200) COLLATE "C";

-- The window index WAS the progress lock. The cursor lease replaces it; one
-- pending capture per tenant (usage_sync_batch_pending_uq) is kept.
DROP INDEX IF EXISTS "usage_sync_batch_window_uq";
