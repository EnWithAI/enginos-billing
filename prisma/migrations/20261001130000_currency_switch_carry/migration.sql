-- The currency switch, hardened: what its carry holds back, what the new
-- subscription granted by itself, who is advancing it, when it was activated
-- — and a lease that keeps a top-up charge from racing its start.
--
-- A SEPARATE MIGRATION ON PURPOSE. 20261001120000_billing_currency is applied
-- (local database, 2026-10-01) and Prisma refuses an applied migration whose
-- file has changed, so everything after it goes here. Additive: every new
-- column is nullable or has a default, and every existing row satisfies the
-- new CHECKs (no switch has an advancer, a B or an activation yet).
--
--   currency_switch.held_back           credits on A that belong to top-up
--                                       invoices not settled (a voided pack's
--                                       grant stays on A): never carried, so
--                                       they never become paid credits on B
--   currency_switch.own_grant           what B's own plan granted when it was
--                                       created (MEASURED: the USD free plan
--                                       grants 1 credit; the INR one none) —
--                                       netted out of the mirror, so switching
--                                       back and forth mints nothing
--   currency_switch.to_subscription_at  when B was created or adopted: its own
--                                       grant is read only once it can have
--                                       landed
--   currency_switch.lease_owner         WHICH advancer holds the lease. Every
--                                       write of an advancing switch compares
--                                       it, so an advancer whose lease was
--                                       taken over writes nothing more
--   currency_switch.activated_at        when the org's cap moved to B. After
--                                       it, cancelling A is a background chore
--                                       that blocks nothing
--   billing_account.topup_charging_until
--                                       a top-up charge on the wire: a switch
--                                       does not start under it, and no charge
--                                       starts while a switch is open
--
-- Hand-authored like the others; apply with `prisma migrate deploy`.

-- ── 1. currency_switch ──────────────────────────────────────────────────────
ALTER TABLE "currency_switch"
    ADD COLUMN "held_back"          DECIMAL(20,10) NOT NULL DEFAULT 0,
    ADD COLUMN "own_grant"          DECIMAL(20,10) NOT NULL DEFAULT 0,
    ADD COLUMN "to_subscription_at" TIMESTAMPTZ(3),
    ADD COLUMN "lease_owner"        UUID,
    ADD COLUMN "activated_at"       TIMESTAMPTZ(3);

-- Amounts are credits, and credits are never negative: a computed own grant
-- below zero is a fault to stop on, never a value to store.
ALTER TABLE "currency_switch" ADD CONSTRAINT "currency_switch_carry_nonneg"
    CHECK ("held_back" >= 0 AND "own_grant" >= 0);

-- B and when it was made are recorded together: its own grant is read only
-- once enough time has passed since.
ALTER TABLE "currency_switch" ADD CONSTRAINT "currency_switch_to_subscription_dated"
    CHECK (("to_subscription_id" IS NULL) = ("to_subscription_at" IS NULL));

-- A lease is an owner AND a time, or neither.
ALTER TABLE "currency_switch" ADD CONSTRAINT "currency_switch_lease_complete"
    CHECK (("lease_owner" IS NULL) = ("lease_until" IS NULL));

-- Activated only once billing is on B, and never DONE without it.
ALTER TABLE "currency_switch" ADD CONSTRAINT "currency_switch_activated_when_linked" CHECK (
    ("activated_at" IS NULL OR "status" IN ('LINKED', 'DONE'))
    AND ("status" <> 'DONE' OR "activated_at" IS NOT NULL)
);

-- ── 2. billing_account ──────────────────────────────────────────────────────
-- Null when no top-up charge is on the wire. A lease, not a lock: a process
-- that dies mid-charge leaves it to run out.
ALTER TABLE "billing_account" ADD COLUMN "topup_charging_until" TIMESTAMPTZ(3);
