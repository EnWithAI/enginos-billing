/**
 * Lazy provisioning of the local billing row.
 *
 * Opening the billing page is the first moment we know an org is looking at
 * billing, and it is the only lazy hook there is — billing is not wired into
 * tenant provisioning. The row must therefore appear on that read, and it must
 * appear WITHOUT creating anything in Chargebee: a customer record for every org
 * that merely browses is a third-party side effect nobody asked for.
 *
 * `$queryRaw` is stubbed per test because the harness models our own tables, not
 * `tenants` / `org_llm_gateways` — those belong to enginos-platform and this
 * service reads them raw precisely so Prisma can never propose changes to them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAccountService } from "@/services/account.service";
import { TENANT, SLUG, makeFakePrisma, quietLogger } from "./harness";

const RATE = "0.001";

/** A Chargebee that fails loudly if the provisioning path ever calls it. */
function forbiddenChargebee() {
  return {
    createCustomer: vi.fn(async () => {
      throw new Error("Chargebee must not be called while provisioning the local row");
    }),
  };
}

function platformTenantExists(prisma: Record<string, unknown>): void {
  prisma["$queryRaw"] = async () => [
    { tenant_id: TENANT, realm_name: "org-acme-com", org_name: "Acme", routing_slug: SLUG },
  ];
}

describe("ensureLocalAccount", () => {
  beforeEach(() => {
    process.env.CHARGEBEE_SITE = "test-site";
    process.env.CHARGEBEE_API_KEY = "test_key";
    process.env.CLICKHOUSE_PASSWORD = "pw";
  });

  it("creates an unlinked row on first read and never calls Chargebee", async () => {
    const prisma = makeFakePrisma();
    prisma._accounts.delete(TENANT); // the case that matters: no row yet
    platformTenantExists(prisma as never);

    const chargebee = forbiddenChargebee();
    const accounts = createAccountService({
      prisma: prisma as never,
      chargebee: chargebee as never,
      usdPerCredit: RATE,
      logger: quietLogger,
    });

    const account = await accounts.ensureLocalAccount(TENANT);

    expect(account).not.toBeNull();
    expect(account!.status).toBe("unlinked");
    expect(account!.routingSlug).toBe(SLUG);
    // Unlinked means exactly this: a row we can find later, with no customer.
    expect(account!.chargebeeCustomerId).toBeNull();
    expect(chargebee.createCustomer).not.toHaveBeenCalled();
    expect(prisma._accounts.size).toBe(1);
  });

  it("creates no usage cursor, so looking at the page does not start billing", async () => {
    const prisma = makeFakePrisma();
    prisma._accounts.delete(TENANT);
    platformTenantExists(prisma as never);

    const NOW = Date.parse("2026-09-17T10:00:00.000Z");
    const accounts = createAccountService({
      prisma: prisma as never,
      chargebee: forbiddenChargebee() as never,
      usdPerCredit: RATE,
      clock: () => NOW,
      logger: quietLogger,
    });

    const account = await accounts.ensureLocalAccount(TENANT);

    // `sync_from` used to be pinned here. The billing ORIGIN replaced it and is
    // laid down at SUBSCRIPTION, not at page load — an org that opens Billing
    // and walks away is not being polled, and the worker skips it for want of a
    // subscription rather than for want of an origin.
    expect(account!.status).toBe("unlinked");
    expect(prisma._cursor).toBeNull();
  });

  it("is idempotent — a refresh or two tabs cost one row, not two", async () => {
    const prisma = makeFakePrisma();
    prisma._accounts.delete(TENANT);
    platformTenantExists(prisma as never);

    const accounts = createAccountService({
      prisma: prisma as never,
      chargebee: forbiddenChargebee() as never,
      usdPerCredit: RATE,
      logger: quietLogger,
    });

    await accounts.ensureLocalAccount(TENANT);
    await accounts.ensureLocalAccount(TENANT);
    await accounts.ensureLocalAccount(TENANT);

    expect(prisma._accounts.size).toBe(1);
  });

  it("returns an existing row untouched, so a live subscription is never reset", async () => {
    const prisma = makeFakePrisma(); // seeded active, with sub_1 linked
    platformTenantExists(prisma as never);

    const accounts = createAccountService({
      prisma: prisma as never,
      chargebee: forbiddenChargebee() as never,
      usdPerCredit: RATE,
      logger: quietLogger,
    });

    const account = await accounts.ensureLocalAccount(TENANT);

    // The read path must not downgrade a paying customer to `unlinked`.
    expect(account!.status).toBe("active");
    expect(account!.chargebeeSubscriptionId).toBe("sub_1");
  });

  it("creates nothing for a tenant the platform does not know", async () => {
    const prisma = makeFakePrisma();
    prisma._accounts.delete(TENANT);
    (prisma as Record<string, unknown>)["$queryRaw"] = async () => [];

    const accounts = createAccountService({
      prisma: prisma as never,
      chargebee: forbiddenChargebee() as never,
      usdPerCredit: RATE,
      logger: quietLogger,
    });

    // Null rather than a synthesised row: an id that matches no tenant is either
    // a deleted org or a bad request, and inventing billing state for it would
    // put a row with a made-up routing slug in front of the sweep.
    expect(await accounts.ensureLocalAccount(TENANT)).toBeNull();
    expect(prisma._accounts.size).toBe(0);
  });
});
