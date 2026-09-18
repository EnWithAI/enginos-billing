-- `activating`: the subscription is paid and its credits are in the ledger,
-- but the LiteLLM team budget has not been set yet (the push failed).
--
-- Fail closed: the account shows no credits, its LiteLLM team is blocked, and
-- the per-minute sync retries the push until it lands, then marks it `active`.
-- Hand-authored like the first migration — apply with `prisma migrate deploy`.
ALTER TABLE "billing_account" DROP CONSTRAINT "billing_account_status_check";
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_status_check"
    CHECK ("status" IN ('unlinked','activating','active','cancelled','exhausted'));
