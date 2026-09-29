-- Allow more than one unsettled capture per tenant.
--
-- `usage_sync_batch_pending_uq` enforced ONE capture in flight per tenant. That
-- was the right shape while an unknown outcome stopped the tick: with reading
-- blocked, a second pending batch could not exist anyway, and the index made
-- the recovery path and a fresh window mutually exclusive for free.
--
-- Reading no longer stops. A capture Chargebee has not answered for is retried
-- by its own id and billing carries on past it, so new usage is captured into
-- its own batch while the older one is still owed. The index would refuse that
-- insert and put the tenant straight back to blocked.
--
-- What still prevents a double charge, none of which was this index:
--   * billed_usage_event PK (tenant_id, event_key) — an event belongs to one
--     capture, and the keys are written before the charge is sent.
--   * the capture id IS the batch id, retrieved from Chargebee before any send.
--   * credit_ledger_entry UNIQUE (tenant_id, source_ref) — one ledger row per
--     capture however often it replays.
--   * the per-tenant lease on billing_cursor, plus maxRuns:1 on the workflow,
--     so one worker handles a tenant at a time.
--
-- Hand-authored like the migrations before it — apply with `prisma migrate deploy`.

DROP INDEX IF EXISTS "usage_sync_batch_pending_uq";

-- Still worth an index: every tick lists a tenant's unsettled captures.
CREATE INDEX IF NOT EXISTS "usage_sync_batch_unsettled_idx"
    ON "usage_sync_batch" ("tenant_id", "window_start")
    WHERE "status" = 'pending';
