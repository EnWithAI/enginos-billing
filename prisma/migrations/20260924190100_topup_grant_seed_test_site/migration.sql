-- TEST-SITE DATA: top-up invoices that were allocated BEFORE topup_grant
-- existed, recorded as applied so they are never granted a second time.
--
-- The old guard (a ledger scan for metadata Chargebee never returns) left no
-- trace of what it granted, so a paid invoice allocated before the previous
-- migration looks unapplied to the new guard. On the Chargebee TEST site two
-- were, and both are recorded here from what Chargebee itself shows:
--
--   invoice 85  org_aws_com  subscription 16A6ReVW76FGuAc8
--               allocated during the 2026-09-24 live test as ledger operation
--               2082089592063869696 (1000 credits, unit token-test; grant block
--               B0FYuUVW8ThF8EO, created 1790248842, expires 1792820507).
--               Its pack item ALSO carries a Chargebee Credit Grant, which put
--               a second 1000 into unit `token` (block B0FYuUVW8TAKdE2) —
--               the catalogue problem documented in §10; not undone here.
--   invoice 83  org_fs_com   subscription 16BWEEVVwBRPbIGX
--               token-pack-5m-INR, paid 1790073027; allocated 16 seconds later
--               by the API key as grant block B0O7ADVVwa3sgD9 (1000 credits,
--               unit token-test, expires 1821603207). Inferred from that block
--               — the operation id is off the ledger's first page — and only
--               reachable while TOPUP_ITEM_PRICE_ID is token-pack-5m-INR.
--
-- `operation_at` is each grant block's `created_at` (an allocation's operation
-- and its block share the second), so the guard can tell these blocks from a
-- later pack's when it searches for an allocation whose answer was lost.
--
-- Each INSERT is conditional on the account still being linked to that
-- subscription, so on any other database — production included — it inserts
-- nothing. Re-runnable: ON CONFLICT on the guard itself.

INSERT INTO "topup_grant" (
    "id", "tenant_id", "invoice_id", "chargebee_subscription_id", "ledger_unit_id", "credits",
    "expires_at", "idempotency_key", "key_issued_at",
    "status", "source", "chargebee_ref", "operation_at", "attempt_count", "error",
    "created_at", "updated_at", "applied_at"
)
SELECT gen_random_uuid(), a."tenant_id", s."invoice_id", s."subscription_id", s."unit_id", s."credits",
       to_timestamp(s."expires_at"), 'invoice:' || s."invoice_id", to_timestamp(s."at"),
       'APPLIED', 'allocation', s."ref", to_timestamp(s."block_created_at"), 1,
       NULL,
       to_timestamp(s."at"), now(), to_timestamp(s."at")
  FROM (VALUES
        ('480e7a6c-9714-478d-beb6-9621bb90dda3'::uuid, '85', '16A6ReVW76FGuAc8', 'token-test', 1000::numeric,
         1792820507, 1790248842, 'ledger_operation:2082089592063869696', 1790248842),
        ('5d3fa58c-86c5-4141-a0d3-94d385af953f'::uuid, '83', '16BWEEVVwBRPbIGX', 'token-test', 1000::numeric,
         1821603207, 1790073043, 'grant_block:B0O7ADVVwa3sgD9', 1790073043)
       ) AS s("tenant_id", "invoice_id", "subscription_id", "unit_id", "credits", "expires_at", "at", "ref", "block_created_at")
  JOIN "billing_account" a
    ON a."tenant_id" = s."tenant_id"
   AND a."chargebee_subscription_id" = s."subscription_id"
ON CONFLICT ("tenant_id", "invoice_id") DO NOTHING;
