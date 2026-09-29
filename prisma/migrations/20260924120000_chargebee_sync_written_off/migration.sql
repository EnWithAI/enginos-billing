-- A final state for a refused sync whose subscription has ENDED.
--
-- OUT_OF_CREDITS and INVALID wait for something to change — a top-up, a
-- renewal, a fixed configuration — and are retried until it does. Once the
-- subscription the row is pinned to has ended (the account was cancelled, or
-- it has moved to another subscription), nothing can change: no top-up or
-- renewal reaches an ended subscription. Such a row used to hold its tenant for
-- ever — re-sent every minute, the handed-back team blocked again as
-- `exhausted`, and a `billing.sync.behind` error every minute after a week.
--
-- WRITTEN_OFF is RESOLVED: it no longer holds the tenant, and the cursor may
-- move past it. It is not SUCCESS — nothing was charged — so it carries no
-- settled time, exactly as the settled-when-success CHECK requires.

ALTER TABLE "chargebee_sync" DROP CONSTRAINT "chargebee_sync_status_check";
ALTER TABLE "chargebee_sync" ADD CONSTRAINT "chargebee_sync_status_check" CHECK (
    "status" IN ('PENDING', 'PROCESSING', 'SUCCESS', 'UNKNOWN',
                 'RATE_LIMITING', 'OUT_OF_CREDITS', 'INVALID', 'WRITTEN_OFF')
);
