/**
 * The fake Prisma (harness.ts) — the parts the currency work extended.
 *
 * Every guard billing writes is a `where` clause, and the fake is what tests
 * them; a fake that evaluated a condition differently from Postgres would let
 * a guard pass a test it fails in production. So the operators it models are
 * pinned here, and an operator it does not model must fail loudly — it used
 * to match nothing, silently. The CHECKs and the unique index of the new
 * table are pinned too: what Postgres would refuse, the fake refuses.
 */

import { describe, expect, it } from "vitest";

import { Prisma } from "../node_modules/.prisma/billing/index";
import { T0, TENANT, makeFakePrisma, matches } from "./harness";

const OTHER = "22222222-2222-4222-8222-222222222222";

describe("matches(): Prisma's where, evaluated as SQL", () => {
  const row = { status: "active", n: 5, amount: "12.5000000000", at: new Date(T0), none: null as string | null };

  it.each([
    [{ status: { notIn: ["cancelled", "switching"] } }, true],
    [{ status: { notIn: ["active"] } }, false],
    [{ n: { gt: 4 } }, true],
    [{ n: { gt: 5 } }, false],
    [{ n: { gte: 5 } }, true],
    [{ n: { lte: 5 } }, true],
    [{ n: { lt: 5 } }, false],
    [{ at: { lte: new Date(T0) } }, true],
    [{ at: { gt: new Date(T0) } }, false],
    [{ amount: { gte: 12.5 } }, true],
    [{ amount: 12.5 }, true],
    [{ amount: new Prisma.Decimal("12.5") }, true],
    [{ status: { equals: "active" } }, true],
    [{ AND: [{ status: "active" }, { n: 5 }] }, true],
    [{ AND: [{ status: "active" }, { n: 6 }] }, false],
    [{ NOT: { status: "cancelled" } }, true],
    [{ NOT: [{ status: "active" }, { n: 6 }] }, false],
    [{ OR: [{ n: 6 }, { status: "active" }] }, true],
    // Every operator in one filter must hold, as in Prisma — not just the first.
    [{ n: { gt: 1, lt: 5 } }, false],
    [{ n: { gt: 1, lt: 6 } }, true],
    // Undefined is no condition at all: Prisma leaves it out.
    [{ status: undefined, n: 5 }, true],
  ])("%o → %s", (where, expected) => {
    expect(matches(row, where as Record<string, any>)).toBe(expected);
  });

  it("matches a NULL column with no comparison but IS NULL — `not` and `notIn` included, as SQL does", () => {
    expect(matches(row, { none: null })).toBe(true);
    expect(matches(row, { none: { not: null } })).toBe(false);
    expect(matches(row, { none: { not: "x" } })).toBe(false);
    expect(matches(row, { none: { notIn: ["x"] } })).toBe(false);
    expect(matches(row, { none: { lt: "z" } })).toBe(false);
    expect(matches(row, { none: 0 })).toBe(false);
  });

  it("throws on an operator it does not model, rather than matching nothing", () => {
    expect(() => matches(row, { status: { contains: "act" } })).toThrow(/filter operator "contains" is not modelled/);
    expect(() => matches(row, { status: { mode: "insensitive", equals: "ACTIVE" } })).toThrow(/"mode"/);
  });
});

describe("an UPDATE's data, as Prisma sends it", () => {
  it("leaves a column alone when its value is undefined — Prisma drops the key", async () => {
    const prisma = makeFakePrisma({ chargebeeItemPriceId: "plan-monthly", currency: "INR" });

    await prisma.billingAccount.updateMany({
      where: { tenantId: TENANT },
      data: { chargebeeSubscriptionId: "sub_2", chargebeeItemPriceId: undefined, currency: undefined },
    });

    expect(prisma._accounts.get(TENANT)).toMatchObject({ chargebeeSubscriptionId: "sub_2", chargebeeItemPriceId: "plan-monthly", currency: "INR" });
  });
});

describe("billing_account's CHECKs", () => {
  it("refuses a status, country or currency Postgres would — and changes nothing", async () => {
    const prisma = makeFakePrisma();

    await expect(prisma.billingAccount.updateMany({ where: { tenantId: TENANT }, data: { status: "paused" } })).rejects.toThrow(
      "billing_account_status_check",
    );
    await expect(prisma.billingAccount.update({ where: { tenantId: TENANT }, data: { billingCountry: "in" } })).rejects.toThrow(
      "billing_account_billing_country_check",
    );
    await expect(prisma.billingAccount.updateMany({ where: { tenantId: TENANT }, data: { currency: "RUPEE" } })).rejects.toThrow(
      "billing_account_currency_check",
    );
    expect(prisma._accounts.get(TENANT)).toMatchObject({ status: "active" });
    expect(prisma._accounts.get(TENANT)).not.toHaveProperty("currency");

    await prisma.billingAccount.updateMany({ where: { tenantId: TENANT }, data: { status: "switching", billingCountry: "IN", currency: "INR" } });
    expect(prisma._accounts.get(TENANT)).toMatchObject({ status: "switching", billingCountry: "IN", currency: "INR" });
  });
});

describe("currency_switch's constraints", () => {
  const base = { tenantId: TENANT, fromSubscriptionId: "sub_A", fromCurrency: "INR", toCurrency: "USD", toItemPriceId: "free-usd" };
  /** Everything a LINKED row must carry. */
  const LINKED = { status: "LINKED", movingAt: new Date(T0), linkedAt: new Date(T0), toSubscriptionId: "sub_B", toSubscriptionAt: new Date(T0) };

  it("allows ONE open switch per tenant (currency_switch_open_uq), and another once it has ended", async () => {
    const prisma = makeFakePrisma();
    prisma._accounts.set(OTHER, { tenantId: OTHER, routingSlug: "org_other", chargebeeSubscriptionId: null, ledgerUnitId: null, status: "active", lastProcessedIngestedAt: null });

    const first = await prisma.currencySwitch.create({ data: { ...base, status: "REQUESTED" } });
    await expect(prisma.currencySwitch.create({ data: { ...base, status: "REQUESTED" } })).rejects.toMatchObject({ code: "P2002" });
    // Another tenant's is its own.
    await prisma.currencySwitch.create({ data: { ...base, tenantId: OTHER, status: "REQUESTED" } });

    await prisma.currencySwitch.updateMany({ where: { id: first.id }, data: { status: "ABANDONED" } });
    await expect(prisma.currencySwitch.create({ data: { ...base, status: "REQUESTED" } })).resolves.toMatchObject({ status: "REQUESTED" });
  });

  it("refuses a second open switch made by an UPDATE as well, and leaves both rows as they were", async () => {
    const prisma = makeFakePrisma();
    const ended = await prisma.currencySwitch.create({ data: { ...base, status: "ABANDONED" } });
    await prisma.currencySwitch.create({ data: { ...base, status: "REQUESTED" } });

    await expect(prisma.currencySwitch.updateMany({ where: { id: ended.id }, data: { status: "REQUESTED" } })).rejects.toThrow(
      "currency_switch_open_uq",
    );
    expect(prisma._switches.get(ended.id)!.status).toBe("ABANDONED");
  });

  it.each([
    [{ status: "PAUSED" }, "currency_switch_status_check"],
    [{ toCurrency: "INR" }, "currency_switch_currencies"],
    [{ toCurrency: "usd" }, "currency_switch_currencies"],
    [{ status: "REQUESTED", drainOperationId: "op_1" }, "currency_switch_drain_complete"],
    [{ status: "REQUESTED", mirrorAmount: "5" }, "currency_switch_mirror_complete"],
    [{ status: "REQUESTED", drained: "-1" }, "currency_switch_amounts_nonneg"],
    [{ status: "MOVING" }, "currency_switch_moving_when_started"],
    [{ status: "LINKED", movingAt: new Date(T0) }, "currency_switch_linked_to_b"],
    [{ ...LINKED, drainOperationId: "op_1", drainAmount: "5" }, "currency_switch_settled_when_linked"],
    [{ ...LINKED, mirrorOperationId: "op_2", mirrorAmount: "5" }, "currency_switch_settled_when_linked"],
    [{ ...LINKED, status: "DONE", activatedAt: new Date(T0) }, "currency_switch_done_when_completed"],
    [{ status: "ABANDONED", completedAt: new Date(T0) }, "currency_switch_done_when_completed"],
    // 20261001130000_currency_switch_carry.
    [{ status: "REQUESTED", heldBack: "-1" }, "currency_switch_carry_nonneg"],
    [{ status: "REQUESTED", ownGrant: "-0.5" }, "currency_switch_carry_nonneg"],
    [{ status: "REQUESTED", toSubscriptionId: "sub_B" }, "currency_switch_to_subscription_dated"],
    [{ status: "REQUESTED", leaseOwner: "11111111-2222-4333-8444-555555555555" }, "currency_switch_lease_complete"],
    [{ status: "REQUESTED", leaseUntil: new Date(T0) }, "currency_switch_lease_complete"],
    [{ status: "MOVING", movingAt: new Date(T0), activatedAt: new Date(T0) }, "currency_switch_activated_when_linked"],
    [{ ...LINKED, status: "DONE", completedAt: new Date(T0) }, "currency_switch_activated_when_linked"],
  ])("refuses %o (%s)", async (over, check) => {
    const prisma = makeFakePrisma();
    await expect(prisma.currencySwitch.create({ data: { ...base, status: "REQUESTED", ...over } })).rejects.toThrow(check);
  });

  it("refuses a switch for a tenant with no billing account (the foreign key)", async () => {
    const prisma = makeFakePrisma();
    await expect(prisma.currencySwitch.create({ data: { ...base, tenantId: OTHER, status: "REQUESTED" } })).rejects.toThrow(
      "currency_switch_tenant_fkey",
    );
  });

  it("adds an increment to a DECIMAL column exactly, and hands Decimals back as Prisma does", async () => {
    const prisma = makeFakePrisma();
    const row = await prisma.currencySwitch.create({ data: { ...base, status: "REQUESTED" } });

    await prisma.currencySwitch.updateMany({ where: { id: row.id }, data: { drained: { increment: new Prisma.Decimal("0.1") } } });
    await prisma.currencySwitch.updateMany({ where: { id: row.id }, data: { drained: { increment: "0.2" }, attemptCount: { increment: 1 } } });
    await prisma.currencySwitch.updateMany({ where: { id: row.id }, data: { heldBack: "12.50", ownGrant: new Prisma.Decimal("1") } });

    expect(prisma._switches.get(row.id)).toMatchObject({ drained: "0.3", attemptCount: 1, heldBack: "12.50", ownGrant: "1" });
    const read = await prisma.currencySwitch.findUnique({ where: { id: row.id } });
    expect(read.drained).toBeInstanceOf(Prisma.Decimal);
    expect(read.drained.toFixed()).toBe("0.3");
  });
});
