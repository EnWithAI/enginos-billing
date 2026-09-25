-- The top-up guard becomes a local record: one row per paid top-up invoice.
--
-- WHY A TABLE. A paid pack must be granted exactly once, and Chargebee keeps
-- nothing that proves it already was. `/ledger_operations/allocate` accepts no
-- client-supplied id, and — MEASURED on the test site, 2026-09-24 — the
-- `metadata` sent with it (the invoice id) is never returned: not on the
-- ledger operation (list or retrieve), and the grant block it creates carries
-- only `{"done_by":"<api key name>"}`. The old guard scanned the ledger for
-- that metadata, never matched, and a repeated `apply` granted the pack again
-- as soon as the 30-minute `chargebee-idempotency-key` window had passed —
-- known defect #1 in docs/BILLING-ARCHITECTURE.md §10. (Defect #2, the scan
-- paging off a ledger that gains a capture a minute, goes with it.)
--
-- HOW IT IS WRITTEN (account.service.ts applyPaidTopUps):
--
--   SENDING   the row is claimed and COMMITTED before the allocate leaves,
--             carrying every parameter of that request
--   APPLIED   Chargebee answered; `chargebee_ref` is the operation id
--   PENDING   the allocate failed or its answer was lost: it may have landed.
--             Retried with the SAME request under the SAME idempotency key
--             while Chargebee still replays it (30 minutes), which returns the
--             original grant rather than making a second. Past that, the
--             subscription's grant blocks are read for the allocation before
--             anything is sent again (and a row still SENDING past that
--             window is never re-sent at all: it is left for a person).
--
-- A crash anywhere leaves a row, never nothing — so a paid invoice can be
-- delayed by a crash, but not granted twice and not forgotten.
--
-- `catalogue_grant` rows record a pack whose item price carries its OWN Credit
-- Grant: Chargebee granted it (the grant block names the invoice), so nothing
-- is allocated and the block is the proof.
--
-- NEVER DROP, TRUNCATE OR EMPTY THIS TABLE once it is in use, and never delete
-- a row from it. Chargebee lists every paid pack invoice for good; one with no
-- row here is granted AGAIN on the next `apply`. For the same reason the
-- foreign key to billing_account is RESTRICT, not CASCADE: deleting an account
-- row (a common dev repair) must fail while it has guard rows, rather than
-- quietly take the guard with it. There is no down migration on purpose.
--
-- Hand-authored like the others: `prisma migrate dev` reconciles against
-- schema.prisma and drops objects it did not model. Apply with
-- `prisma migrate deploy`, then `prisma migrate resolve`.

CREATE TABLE "topup_grant" (
    "id"                        UUID           NOT NULL,
    "tenant_id"                 UUID           NOT NULL,
    "invoice_id"                VARCHAR(100)   NOT NULL,

    -- Pinned at the claim: a retry after a resubscription still completes
    -- against the subscription and unit the first attempt was sent to.
    "chargebee_subscription_id" VARCHAR(100)   NOT NULL,
    "ledger_unit_id"            VARCHAR(50)    NOT NULL,
    "credits"                   DECIMAL(20,10) NOT NULL,

    -- The allocate request, stored before its first send so every retry is the
    -- same request — which is what lets the idempotency key replay it.
    "expires_at"                TIMESTAMPTZ(3),
    "idempotency_key"           VARCHAR(120),
    "key_issued_at"             TIMESTAMPTZ(3),

    "status"                    VARCHAR(16)    NOT NULL,
    "source"                    VARCHAR(20)    NOT NULL,
    -- `ledger_operation:<id>` or `grant_block:<id>`: what proves the grant.
    "chargebee_ref"             VARCHAR(120),
    -- When Chargebee made the grant: the allocation operation's `created_at`,
    -- which is the same second as its grant block's. The guard uses it to tell
    -- this row's block from another's when it searches the blocks for an
    -- allocation whose answer was lost. Null when Chargebee did not say; then
    -- it is read back by operation id when needed.
    "operation_at"              TIMESTAMPTZ(3),

    "attempt_count"             INTEGER        NOT NULL DEFAULT 0,
    "error"                     TEXT,

    "created_at"                TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at"                TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "applied_at"                TIMESTAMPTZ(3),

    CONSTRAINT "topup_grant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "topup_grant_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "billing_account" ("tenant_id") ON DELETE RESTRICT,

    CONSTRAINT "topup_grant_status_check" CHECK ("status" IN ('SENDING', 'PENDING', 'APPLIED')),
    CONSTRAINT "topup_grant_source_check" CHECK ("source" IN ('allocation', 'catalogue_grant')),
    CONSTRAINT "topup_grant_amounts_nonneg" CHECK ("credits" >= 0 AND "attempt_count" >= 0),
    -- An allocation cannot be retried safely without the request it was sent as.
    CONSTRAINT "topup_grant_allocation_request" CHECK (
        "source" <> 'allocation'
        OR ("expires_at" IS NOT NULL AND "idempotency_key" IS NOT NULL AND "key_issued_at" IS NOT NULL)
    ),
    -- Chargebee grants a catalogue pack itself: there is nothing in flight to record.
    CONSTRAINT "topup_grant_catalogue_applied" CHECK ("source" <> 'catalogue_grant' OR "status" = 'APPLIED'),
    -- APPLIED is the mark of a granted pack, and it always says what proves it.
    CONSTRAINT "topup_grant_applied_when_proven" CHECK (
        ("status" = 'APPLIED') = ("applied_at" IS NOT NULL AND "chargebee_ref" IS NOT NULL)
    )
);

-- THE GUARD. Two callers applying the same paid invoice collide here, so only
-- one of them ever sends its allocate.
CREATE UNIQUE INDEX "topup_grant_invoice_uq" ON "topup_grant" ("tenant_id", "invoice_id");
