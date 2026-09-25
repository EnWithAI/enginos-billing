/**
 * C57b: a subscription with TWO credit units.
 *
 * MEASURED on the test site (2026-09-24, org_aws_com, 16A6ReVW76FGuAc8): a
 * top-up whose charge item carries its own Credit Grant put a second ledger
 * account on the subscription — unit `token`, 1000 credits — beside the plan's
 * `token-test`, which was at 0. `GET /ledger_account_balances` listed `token`
 * FIRST. balance() took "the first balance" (limit=1, no unit filter), so
 * activate() read 1000 and opened an exhausted account, and a relink could
 * have moved `ledger_unit_id` onto `token`.
 *
 * The REAL client runs here, over a fetch fake that answers the way the live
 * site did — including honouring `unit_id[is]`, which it was seen to.
 */

import { describe, expect, it } from "vitest";

import { createChargebee } from "@/integrations/chargebee";
import { createAccountService } from "@/services/account.service";
import { createBillingOverviewService } from "@/services/billing-overview.service";
import { createBillingAccountRepository } from "@/repositories/billing-account.repository";
import { createChargebeeSyncRepository } from "@/repositories/chargebee-sync.repository";

import { TENANT, makeFakePrisma, quietLogger } from "./harness";

const SUB = "16A6ReVW76FGuAc8";

function balanceEntry(unit: string, usable: string, createdAt: number) {
  return {
    ledger_account_balance: {
      subscription_id: SUB,
      unit_id: unit,
      unit_external_name: unit,
      created_at: createdAt,
      provisioned_balance: { total_balance: usable, usable_balance: usable, hold_amount: "0.0000000000" },
    },
  };
}

/** The live answer: the top-up's unit first, the plan's (older, and empty) second. */
function twoUnitSite(opts: { planUsable?: string; topUpUsable?: string; ignoreUnitFilter?: boolean } = {}) {
  const requests: URL[] = [];
  const list = [
    balanceEntry("token", opts.topUpUsable ?? "1000.0000000000", 1790248715),
    balanceEntry("token-test", opts.planUsable ?? "0.0000000000", 1790228510),
  ];
  const fetchImpl = (async (input: URL | string) => {
    const url = new URL(String(input));
    requests.push(url);
    const path = url.pathname.replace(/^\/api\/v2/, "");
    if (path === "/ledger_account_balances") {
      const unit = opts.ignoreUnitFilter ? null : url.searchParams.get("unit_id[is]");
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const matching = unit ? list.filter((e) => e.ledger_account_balance.unit_id === unit) : list;
      return new Response(JSON.stringify({ list: matching.slice(0, limit) }), { status: 200 });
    }
    if (path === "/ledger_operations/op_1") {
      return new Response(JSON.stringify({ ledger_operation: { id: "op_1", type: "capture", subscription_id: SUB } }), { status: 200 });
    }
    if (path === "/grant_blocks") {
      return new Response(
        JSON.stringify({
          list: [
            { grant_block: { id: "b1", subscription_id: SUB, unit_id: "token-test", granted_amount: "0.0000000001", status: "available" } },
            { grant_block: { id: "b2", subscription_id: SUB, unit_id: "token-test", granted_amount: "1000000.0000000000", status: "available" } },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ api_error_code: "resource_not_found", message: `unrouted ${path}` }), { status: 404 });
  }) as unknown as typeof fetch;
  const client = createChargebee({ site: "s", apiKey: "k", fetchImpl, maxAttempts: 1, sleep: async () => {} });
  return { client, requests };
}

describe("C57b balance() reads the account's unit, never 'the first balance'", () => {
  it("with the unit: that unit's balance, asked for by unit_id[is]", async () => {
    const { client, requests } = twoUnitSite();
    const b = await client.balance(SUB, "token-test");
    expect(b).toMatchObject({ unitId: "token-test", usable: "0" });
    expect(requests[0]!.searchParams.get("unit_id[is]")).toBe("token-test");
  });

  it("even when the site ignores the unit filter and lists the other unit first", async () => {
    const { client } = twoUnitSite({ ignoreUnitFilter: true });
    // Filter dropped: both entries come back, `token` first.
    const b = await client.balance(SUB, "token-test");
    expect(b?.unitId).toBe("token-test");
    const unknown = await client.balance(SUB, "no-such-unit");
    expect(unknown).toBeNull();
  });

  it("without a unit (a first link only): the subscription's OLDEST unit — the plan's — and how many there were", async () => {
    const { client } = twoUnitSite();
    expect(await client.balance(SUB)).toMatchObject({ unitId: "token-test", usable: "0", unitCount: 2 });
  });

  it("a replayed capture reads the balance of ITS unit, so a drain to zero is still seen", async () => {
    const { client } = twoUnitSite();
    const result = await client.captureIdempotent({ id: "op_1", subscriptionId: SUB, unitId: "token-test", amount: "1" });
    expect(result).toMatchObject({ kind: "replayed", balanceAfter: "0" }); // not token's 1000
  });

  it("grantedCredits() sums exactly — a float sum loses the 1e-10", async () => {
    const { client } = twoUnitSite();
    expect(await client.grantedCredits(SUB, "token-test", 0)).toEqual({ credits: "1000000.0000000001", blocks: 2 });
  });
});

describe("C57b the account service never lets balance ordering move or open an account", () => {
  function service(client: ReturnType<typeof twoUnitSite>["client"], account: Record<string, unknown>) {
    const prisma = makeFakePrisma({ chargebeeCustomerId: TENANT, ...account } as never);
    const pushes: Array<Record<string, unknown>> = [];
    const warns: Array<Record<string, unknown>> = [];
    const svc = createAccountService({
      prisma: prisma as never,
      chargebee: client,
      usdPerCredit: "0.001",
      logger: { ...quietLogger, warn: (o: unknown) => void warns.push(o as Record<string, unknown>) },
      pushBudget: async (_t, opts) => void pushes.push({ ...opts }),
      blockBudget: async () => {},
    });
    return { prisma, svc, pushes, warns };
  }

  it("an account whose own unit is empty is EXHAUSTED, whatever another unit holds", async () => {
    const { client } = twoUnitSite();
    const { svc, prisma, pushes } = service(client, { chargebeeSubscriptionId: SUB, ledgerUnitId: "token-test", status: "active" });

    const after = await svc.syncSubscription({ tenantId: TENANT, subscriptionId: SUB });

    expect(after.status).toBe("exhausted");
    expect(pushes.at(-1)).toMatchObject({ unblock: false, usableCredits: "0" });
    expect(prisma._accounts.get(TENANT).ledgerUnitId).toBe("token-test"); // not relinked to `token`
  });

  it("activate() reads the ACCOUNT'S unit even when it is not the oldest: empty there is exhausted, whatever the plan unit holds", async () => {
    const { client } = twoUnitSite({ planUsable: "5.0000000000", topUpUsable: "0.0000000000" });
    const { svc, pushes } = service(client, { chargebeeSubscriptionId: SUB, ledgerUnitId: "token", status: "active" });

    const after = await svc.syncSubscription({ tenantId: TENANT, subscriptionId: SUB });

    expect(after.status).toBe("exhausted");
    expect(pushes.at(-1)).toMatchObject({ usableCredits: "0" });
  });

  it("the billing page's credits are the account's unit's — not the oldest's, not the first listed", async () => {
    const { client } = twoUnitSite({ planUsable: "7.5000000000", topUpUsable: "3.0000000000" });
    const prisma = makeFakePrisma({ chargebeeCustomerId: TENANT, chargebeeSubscriptionId: SUB, ledgerUnitId: "token", status: "active" } as never);
    const accounts = createBillingAccountRepository(prisma as never);
    const overview = createBillingOverviewService({
      chargebee: { ...client, transactionsFor: async () => [], subscription: async () => null, paymentSource: async () => null },
      accountService: { ensureLocalAccount: (t: string) => accounts.findByTenantId(t) } as never,
      accounts,
      syncs: createChargebeeSyncRepository(prisma as never),
      plansOffered: async () => [],
      logger: quietLogger,
    });

    const page = await overview.overview(TENANT);

    expect(page.kind === "linked" && page.credits).toMatchObject({ current: "3" }); // not token-test's 7.5
  });

  it("a relink of the SAME subscription keeps the stored unit, even one that is not the oldest", async () => {
    const { client } = twoUnitSite({ planUsable: "5.0000000000" });
    const { svc, prisma } = service(client, { chargebeeSubscriptionId: SUB, ledgerUnitId: "token", status: "active" });

    await svc.syncSubscription({ tenantId: TENANT, subscriptionId: SUB });

    expect(prisma._accounts.get(TENANT).ledgerUnitId).toBe("token");
  });

  it("a first link picks the oldest unit, and says there was a choice", async () => {
    const { client } = twoUnitSite({ planUsable: "5.0000000000" });
    const { svc, prisma, warns } = service(client, { chargebeeSubscriptionId: null, ledgerUnitId: null, status: "unlinked" });

    const after = await svc.syncSubscription({ tenantId: TENANT, subscriptionId: SUB });

    expect(prisma._accounts.get(TENANT).ledgerUnitId).toBe("token-test");
    expect(after.status).toBe("active");
    expect(warns).toContainEqual(expect.objectContaining({ metric: "billing.subscription.multiple_units", chosen: "token-test", units: 2 }));
  });
});
