-- The cursor row becomes a capture log.
--
--   billing_account    tenant ↔ Chargebee mapping
--   chargebee_capture  one row per capture: what was sent, what came back, and
--                      the ClickHouse range it covers
--
-- `usage_sync` is removed. Progress is no longer a column anywhere: billing has
-- reached the furthest `cursor_to` among SETTLED captures, and an UNSETTLED one
-- holds its tenant at that point until it resolves. That is the whole retry
-- mechanism — nothing in front of an unknown outcome is read, so a capture that
-- may or may not have landed can never be covered by a second one.
--
-- ORDER MATTERS. chargebee_capture is created and seeded from usage_sync BEFORE
-- usage_sync is dropped, so a failure part-way leaves the old row intact.
--
-- Hand-authored like the others: `prisma migrate dev` reconciles against
-- schema.prisma and drops objects it did not model. Apply with
-- `prisma migrate deploy`, then `prisma migrate resolve`.

CREATE TABLE "chargebee_capture" (
    -- ALSO the Chargebee ledger operation id. Written here BEFORE the capture
    -- is sent, which is what lets a lost response be resolved by lookup rather
    -- than guessed at.
    "id"                        UUID           NOT NULL,
    "tenant_id"                 UUID           NOT NULL,

    "chargebee_subscription_id" VARCHAR(100),
    "ledger_unit_id"            VARCHAR(50),

    -- The range covered, exclusive of `from`, inclusive of `to`, in ClickHouse
    -- (ingested_at, TraceId:SpanId) order. COLLATE "C" so the key compares byte
    -- by byte exactly as ClickHouse orders it — the database default (en_US)
    -- ignores punctuation like ':' at the first level and would disagree about
    -- which key comes next.
    "cursor_from_at"            TIMESTAMPTZ(3) NOT NULL,
    "cursor_from_key"           VARCHAR(200) COLLATE "C" NOT NULL DEFAULT '',
    "cursor_to_at"              TIMESTAMPTZ(3) NOT NULL,
    "cursor_to_key"             VARCHAR(200) COLLATE "C" NOT NULL DEFAULT '',

    "event_count"               INTEGER        NOT NULL DEFAULT 0,

    "credits"                   DECIMAL(20,10) NOT NULL DEFAULT 0,
    "billed_usd"                DECIMAL(20,10) NOT NULL DEFAULT 0,
    "provider_usd"              DECIMAL(20,10) NOT NULL DEFAULT 0,
    "margin_usd"                DECIMAL(20,10) NOT NULL DEFAULT 0,

    "status"                    VARCHAR(16)    NOT NULL,
    "attempts"                  INTEGER        NOT NULL DEFAULT 0,
    "last_error"                TEXT,

    "chargebee_operation_id"    VARCHAR(50),
    "balance_after"             DECIMAL(20,10),
    "hatchet_run_id"            VARCHAR(100),

    "created_at"                TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "settled_at"                TIMESTAMPTZ(3),
    "updated_at"                TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "chargebee_capture_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chargebee_capture_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "billing_account" ("tenant_id") ON DELETE CASCADE,

    CONSTRAINT "chargebee_capture_status_check" CHECK (
        "status" IN ('origin', 'pending', 'captured', 'skipped', 'insufficient', 'failed')
    ),
    -- A range that runs backwards would let the cursor move backwards.
    CONSTRAINT "chargebee_capture_range_order" CHECK (
        ("cursor_to_at", "cursor_to_key") >= ("cursor_from_at", "cursor_from_key")
    ),
    CONSTRAINT "chargebee_capture_amounts_nonneg" CHECK (
        "credits" >= 0 AND "billed_usd" >= 0 AND "event_count" >= 0
    ),
    -- An origin row marks the activation point: no usage, no money, cursor only.
    CONSTRAINT "chargebee_capture_origin_empty" CHECK (
        "status" <> 'origin' OR ("event_count" = 0 AND "credits" = 0)
    )
);

-- ── the two guards that replace the old tenant lease ────────────────────────
--
-- A lease is a value a caller can forget to check. These are constraints, so a
-- second worker cannot get past them however it is written.

-- ONE capture per cursor position. Two workers that read the same last-settled
-- position and both try to create a capture for it collide here, so the same
-- range can never be covered by two rows — and a retry re-uses the row it
-- already has rather than opening a second one. Origin rows are excluded
-- because the first real capture starts exactly where the origin ends.
CREATE UNIQUE INDEX "chargebee_capture_position_uq"
    ON "chargebee_capture" ("tenant_id", "cursor_from_at", "cursor_from_key")
    WHERE "status" <> 'origin';

-- Exactly ONE activation point per tenant. Two concurrent activations would
-- otherwise lay down two origins, and the later one would silently become the
-- cursor — skipping whatever was ingested between them.
CREATE UNIQUE INDEX "chargebee_capture_origin_uq"
    ON "chargebee_capture" ("tenant_id")
    WHERE "status" = 'origin';

-- At most ONE capture in flight per tenant. Nothing new may be sent while an
-- outcome is unknown.
CREATE UNIQUE INDEX "chargebee_capture_pending_uq"
    ON "chargebee_capture" ("tenant_id")
    WHERE "status" = 'pending';

-- Reading the cursor: the furthest settled position for a tenant.
CREATE INDEX "chargebee_capture_cursor_idx"
    ON "chargebee_capture" ("tenant_id", "cursor_to_at" DESC, "cursor_to_key" DESC);

-- Finding work: every unsettled capture, across tenants.
CREATE INDEX "chargebee_capture_status_idx" ON "chargebee_capture" ("status");

-- ── seed the activation point from the cursor being retired ─────────────────
--
-- One origin row per tenant, carrying exactly where usage_sync had got to. This
-- is the only place the old cursor's value survives, and it must: starting the
-- log at now() instead would skip every span ingested since the last capture.
INSERT INTO "chargebee_capture" (
    "id", "tenant_id", "chargebee_subscription_id", "ledger_unit_id",
    "cursor_from_at", "cursor_from_key", "cursor_to_at", "cursor_to_key",
    "status", "created_at", "settled_at", "updated_at"
)
SELECT gen_random_uuid(), s."tenant_id", a."chargebee_subscription_id", a."ledger_unit_id",
       s."last_processed_ingested_at", s."last_processed_event_key",
       s."last_processed_ingested_at", s."last_processed_event_key",
       'origin', now(), now(), now()
  FROM "usage_sync" s
  JOIN "billing_account" a ON a."tenant_id" = s."tenant_id";

-- A capture that was in flight when this ran cannot be carried across: its id
-- was written against a row that is about to stop existing, and the origin above
-- puts the cursor BEHIND the range it covered, so the usage is simply read
-- again. Safe — the new capture gets a new id and Chargebee is asked about
-- nothing — but the old operation, if it landed, is money already taken that
-- this log will not show.
DO $$
DECLARE in_flight INT;
BEGIN
    SELECT count(*) INTO in_flight FROM "usage_sync" WHERE "pending_operation_id" IS NOT NULL;
    IF in_flight > 0 THEN
        RAISE WARNING 'billing: % tenant(s) had a capture in flight. Check those ids in Chargebee by hand — their usage will be read and captured again under a new id.', in_flight;
    END IF;
END $$;

DROP TABLE "usage_sync";
