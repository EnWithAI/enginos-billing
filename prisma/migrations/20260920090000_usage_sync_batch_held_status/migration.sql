-- Split `held` out of `failed` on usage_sync_batch.
--
-- Both statuses stop billing for a tenant and freeze its cursor. The difference
-- is who clears them: a capture Chargebee refused for lack of credits is a
-- business state the customer fixes by topping up, and it reopens on the next
-- grant. Anything else is a defect that waits for a human.
--
-- They were one status, told apart by matching the TEXT of `last_error`
-- ("insufficient credits: ..." written in usage-sync.ts, matched with
-- startsWith in account.ts). Nothing enforced that contract across the two
-- files: rewording the message would have silently stranded every held tenant,
-- with billing stopped and no error raised anywhere.
--
-- Hand-authored like the migrations before it — apply with `prisma migrate deploy`.

-- The CHECK has to admit the new value before any row can carry it.
ALTER TABLE "usage_sync_batch" DROP CONSTRAINT "usage_sync_batch_status_check";
ALTER TABLE "usage_sync_batch" ADD CONSTRAINT "usage_sync_batch_status_check"
    CHECK ("status" IN ('pending','captured','held','failed','skipped'));

-- Move existing rows, using the prefix the old reader matched on, one last time.
UPDATE usage_sync_batch
   SET status = 'held'
 WHERE status = 'failed'
   AND last_error LIKE 'insufficient credits%';
