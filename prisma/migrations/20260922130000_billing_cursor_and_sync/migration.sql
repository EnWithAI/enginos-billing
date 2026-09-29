-- The capture log splits into a cursor and a sync log.
--
--   billing_account.last_processed_ingested_at   WHERE THE WORKER IS
--   chargebee_sync                               WHAT CHARGEBEE SAID
--
-- `chargebee_capture` carried both at once: progress was `max(cursor_to)` over
-- the rows whose status happened to be settled. That worked, but it tied two
-- unrelated questions to one column — "how far has the worker got" could only
-- be answered by interpreting Chargebee outcomes — and it meant an empty
-- minute could not move the cursor without writing a row to move it with.
--
-- After this migration the cursor is a plain timestamp the worker owns, and
-- chargebee_sync is only ever the record of one Chargebee operation.
--
-- THREE THINGS CHANGE BESIDES THE SHAPE:
--
-- 1. The cursor is a TIME, not a (time, TraceId:SpanId) pair. The key half
--    existed because a LIMIT-ed page of events ends on an arbitrary event
--    inside a millisecond. Windows are now bounded by times — `ingested_at >
--    from AND ingested_at <= to` — so a boundary can never fall inside a
--    millisecond and there is nothing to tie-break. Event identity has not gone
--    anywhere: it moved into the query, which groups by TraceId:SpanId, which
--    is what actually deduplicates usage. See usage-events.ts.
--
-- 2. Statuses become the state of the CHARGEBEE OPERATION, spelled out:
--    PENDING, PROCESSING, SUCCESS, UNKNOWN, RATE_LIMITING, OUT_OF_CREDITS,
--    INVALID. `failed` is gone — it answered "it did not work" without saying
--    which of those four very different things happened, and they want four
--    different responses.
--
-- 3. A subscription with no prepaid ledger is now INVALID and HOLDS the cursor.
--    It used to be `skipped`, which moved billing past usage that would never
--    be charged. Holding means that once someone configures the ledger, the
--    usage that accrued in the meantime is still there to bill.
--
-- ORDER MATTERS. The cursor and chargebee_sync are populated from
-- chargebee_capture BEFORE it is dropped, so a failure part-way leaves the old
-- table intact and the service still able to bill from it.
--
-- Hand-authored like the others: `prisma migrate dev` reconciles against
-- schema.prisma and drops objects it did not model. Apply with
-- `prisma migrate deploy`, then `prisma migrate resolve`.

-- ── the cursor ──────────────────────────────────────────────────────────────
ALTER TABLE "billing_account"
    ADD COLUMN IF NOT EXISTS "last_processed_ingested_at" TIMESTAMPTZ(3);

COMMENT ON COLUMN "billing_account"."last_processed_ingested_at" IS
    'Billing cursor: span_nodes.ingested_at up to which this tenant is fully billed. Worker progress only — not a Chargebee, payment or subscription status.';

-- ── the sync log ────────────────────────────────────────────────────────────
CREATE TABLE "chargebee_sync" (
    -- ALSO the Chargebee ledger operation id. Written here BEFORE the capture
    -- is sent, which is what lets a lost response be resolved by lookup rather
    -- than guessed at.
    "id"                        UUID           NOT NULL,
    "tenant_id"                 UUID           NOT NULL,

    "chargebee_subscription_id" VARCHAR(100),
    "ledger_unit_id"            VARCHAR(50),

    -- The window: exclusive of `from`, inclusive of `to`. Times, not event
    -- positions — a half-open range on a time boundary cannot split the
    -- millisecond that several spans share.
    "from_ingested_at"          TIMESTAMPTZ(3) NOT NULL,
    "to_ingested_at"            TIMESTAMPTZ(3) NOT NULL,

    "status"                    VARCHAR(16)    NOT NULL,

    -- What was sent, in credits, at Chargebee's own ledger precision.
    "amount"                    DECIMAL(20,10) NOT NULL DEFAULT 0,
    -- The dollar figure behind it, for the billing page.
    "billed_usd"                DECIMAL(20,10) NOT NULL DEFAULT 0,
    "event_count"               INTEGER        NOT NULL DEFAULT 0,

    "error"                     TEXT,
    "attempt_count"             INTEGER        NOT NULL DEFAULT 0,

    "hatchet_run_id"            VARCHAR(100),

    "created_at"                TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "settled_at"                TIMESTAMPTZ(3),
    "updated_at"                TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "chargebee_sync_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chargebee_sync_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "billing_account" ("tenant_id") ON DELETE CASCADE,

    CONSTRAINT "chargebee_sync_status_check" CHECK (
        "status" IN ('PENDING', 'PROCESSING', 'SUCCESS', 'UNKNOWN',
                     'RATE_LIMITING', 'OUT_OF_CREDITS', 'INVALID')
    ),
    -- A window runs forwards and is never empty. Unlike the position-pair range
    -- it replaces, this can be STRICT: a window is a span of time, and one of
    -- zero length would move the cursor nowhere while still claiming a row.
    CONSTRAINT "chargebee_sync_window_order" CHECK ("to_ingested_at" > "from_ingested_at"),
    CONSTRAINT "chargebee_sync_amounts_nonneg" CHECK (
        "amount" >= 0 AND "billed_usd" >= 0 AND "event_count" >= 0 AND "attempt_count" >= 0
    ),
    -- A settled time is the mark of a resolved row and must not appear on one
    -- that is still owed.
    CONSTRAINT "chargebee_sync_settled_when_success" CHECK (
        ("status" = 'SUCCESS') = ("settled_at" IS NOT NULL)
    )
);

-- ONE row per window, ever.
--
-- This is §6 — "do not create duplicate sync records for the same unresolved
-- billing window" — as a constraint rather than as a rule a caller has to
-- remember. Two workers that read the same cursor and both open a window for it
-- collide here, so the loser backs off and the same range can never be sent
-- under two different operation ids.
CREATE UNIQUE INDEX "chargebee_sync_window_uq"
    ON "chargebee_sync" ("tenant_id", "from_ingested_at");

-- The billing page's "last synced", and the recovery scan's "oldest unresolved".
CREATE INDEX "chargebee_sync_progress_idx"
    ON "chargebee_sync" ("tenant_id", "to_ingested_at" DESC);

-- Finding work: every unresolved sync, across tenants.
CREATE INDEX "chargebee_sync_status_idx" ON "chargebee_sync" ("status");

-- ── carry the cursor across ─────────────────────────────────────────────────
--
-- The furthest SETTLED position each tenant reached. This is the only place the
-- old log's progress survives, and it must: starting at now() instead would
-- skip every span ingested since the last capture, and starting at epoch would
-- bill ClickHouse's whole 90-day retention.
--
-- The key half of the position is DISCARDED, not rounded down. A capture that
-- ended mid-millisecond (only possible at a LIMIT boundary) leaves the rest of
-- that millisecond unbilled, because `ingested_at > cursor` excludes it. That
-- is a fraction of a cent, once, at the cutover. Rounding down instead would
-- re-bill everything already charged in that millisecond, which is the error
-- worth avoiding.
UPDATE "billing_account" a
   SET "last_processed_ingested_at" = p.at
  FROM (
        SELECT "tenant_id", max("cursor_to_at") AS at
          FROM "chargebee_capture"
         WHERE "status" IN ('origin', 'captured', 'skipped')
         GROUP BY "tenant_id"
       ) p
 WHERE a."tenant_id" = p."tenant_id";

DO $$
DECLARE split INT;
BEGIN
    -- Tenants whose furthest settled capture ended ON an event rather than on a
    -- drained read. Only these can lose a sub-millisecond tail; named so the
    -- number is in the deploy log rather than inferred afterwards.
    SELECT count(*) INTO split
      FROM "chargebee_capture" c
      JOIN "billing_account" a
        ON a."tenant_id" = c."tenant_id"
       AND a."last_processed_ingested_at" = c."cursor_to_at"
     WHERE c."status" IN ('origin', 'captured', 'skipped')
       AND c."cursor_to_key" <> '';
    IF split > 0 THEN
        RAISE WARNING 'billing: % tenant(s) had a cursor inside a millisecond. Any further events sharing that exact millisecond are not billed. Sub-cent, one-off.', split;
    END IF;
END $$;

-- ── carry unresolved captures across ────────────────────────────────────────
--
-- Their ids MUST survive: an id that was on the wire is the only way to ask
-- Chargebee whether the money moved. Dropping these rows would leave a charge
-- that landed unrecorded and the usage billed a second time under a new id.
--
-- The status mapping is conservative in the one direction that matters:
--   pending      → UNKNOWN   it may have been sent, so it is resolved by lookup
--   insufficient → OUT_OF_CREDITS
--   failed       → INVALID   a person decides; it holds the cursor either way
--
-- `from_ingested_at` is the cursor set above, so the window lines up with where
-- billing now stands and the chain has no gap. `to_ingested_at` is nudged past
-- it where the old range was degenerate (a capture that began and ended in one
-- millisecond), which the strict window CHECK would otherwise refuse.
INSERT INTO "chargebee_sync" (
    "id", "tenant_id", "chargebee_subscription_id", "ledger_unit_id",
    "from_ingested_at", "to_ingested_at", "status",
    "amount", "billed_usd", "event_count",
    "error", "attempt_count", "hatchet_run_id",
    "created_at", "settled_at", "updated_at"
)
SELECT c."id", c."tenant_id", c."chargebee_subscription_id", c."ledger_unit_id",
       c."cursor_from_at",
       greatest(c."cursor_to_at", c."cursor_from_at" + INTERVAL '1 millisecond'),
       CASE c."status"
            WHEN 'pending'      THEN 'UNKNOWN'
            WHEN 'insufficient' THEN 'OUT_OF_CREDITS'
            ELSE                     'INVALID'
       END,
       c."credits", c."billed_usd", c."event_count",
       c."last_error", c."attempts", c."hatchet_run_id",
       c."created_at", NULL, now()
  FROM "chargebee_capture" c
 WHERE c."status" IN ('pending', 'insufficient', 'failed')
   -- One row per window. A tenant with two unresolved captures covering the
   -- same start cannot exist under the old indexes, but the migration must not
   -- depend on that to avoid aborting the deploy.
   AND c."id" = (
        SELECT c2."id" FROM "chargebee_capture" c2
         WHERE c2."tenant_id" = c."tenant_id"
           AND c2."cursor_from_at" = c."cursor_from_at"
           AND c2."status" IN ('pending', 'insufficient', 'failed')
         ORDER BY c2."created_at" ASC, c2."id" ASC
         LIMIT 1
       );

DO $$
DECLARE carried INT;
BEGIN
    SELECT count(*) INTO carried FROM "chargebee_sync" WHERE "status" <> 'SUCCESS';
    IF carried > 0 THEN
        RAISE NOTICE 'billing: % unresolved capture(s) carried across with their operation ids intact; the next tick resolves them by lookup.', carried;
    END IF;
END $$;

-- ── and the history it replaces ─────────────────────────────────────────────
--
-- Settled captures are not carried. They are a record of money Chargebee
-- already holds the authoritative version of, their ranges are expressed in a
-- position pair this table has no column for, and the one thing that had to
-- survive them — the cursor — is now in billing_account above.
DROP TABLE "chargebee_capture";
