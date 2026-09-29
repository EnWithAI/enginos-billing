-- Per-org free plan: whether the org is put on the free plan, or offered the
-- paid plans instead. NULL follows FREE_PLAN_DEFAULT. Additive and nullable,
-- so every existing row keeps following the default.
ALTER TABLE "billing_account" ADD COLUMN "free_plan" BOOLEAN;
