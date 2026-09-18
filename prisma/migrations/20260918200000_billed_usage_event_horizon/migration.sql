-- 1. Usage-event keys are kept by position, not by age.
--
-- The cursor reads ClickHouse span_nodes by ingested_at. A span re-inserted
-- into span_nodes — a collector re-send, or a platform migration that rebuilds
-- the table from otel_traces — comes back with a NEW ingested_at, after the
-- cursor, and only its key stops it being charged again. So the rule is exact:
--
--   the sync never reads a span whose Timestamp is more than the key horizon
--   (BILLING_EVENT_KEY_RETENTION_MS) behind the cursor, and a key is deleted
--   only once its span has fallen below that floor.
--
-- Pruning by created_at broke that for a tenant whose cursor had stalled (held
-- for insufficient credits): its keys aged out while its floor did not move.
-- Pruning per tenant by ingested_at needs this index; created_at's is unused.

CREATE INDEX "billed_usage_event_ingested_idx" ON "billed_usage_event" ("tenant_id", "ingested_at");

DROP INDEX IF EXISTS "billed_usage_event_created_idx";

-- 2. A capture covers (cursor, last event], in ingested_at terms. When a full page
-- of events all share the cursor's millisecond (the key breaks the tie), that
-- range starts and ends at one instant — legitimate, and the old strict
-- check would reject it on every tick, wedging the tenant. Inverted stays out.
ALTER TABLE "usage_sync_batch" DROP CONSTRAINT "usage_sync_batch_window_order";
ALTER TABLE "usage_sync_batch" ADD CONSTRAINT "usage_sync_batch_window_order" CHECK ("window_end" >= "window_start");
