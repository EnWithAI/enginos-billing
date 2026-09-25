/**
 * C57a / C57d: a paid top-up pack is granted exactly once — against the
 * Chargebee site as it really behaves.
 *
 * MEASURED on the test site (2026-09-24):
 *   - `/ledger_operations/allocate` takes no client id, and the metadata sent
 *     with it (the invoice id) is never returned — not on the ledger operation
 *     (list or retrieve), and the grant block it makes says only
 *     `{"done_by":"full_access_key_v1"}`. The old guard scanned for that
 *     metadata and never matched; a repeat `apply` inside the 30-minute
 *     idempotency window answered 502 ("key already used for a different
 *     request" — `expires_at` came from the clock), and after it granted again.
 *   - A pack whose charge item carries its OWN Credit Grant is granted by
 *     Chargebee at payment, into the grant's unit (`token`, not the plan's
 *     `token-test`), and the grant block names the invoice line.
 *
 * The rig's Chargebee (ChargebeeWorld) now answers exactly so: no metadata on
 * operations, grant blocks that name their invoice only for a catalogue grant,
 * and an idempotency key that replays the same request for 30 minutes and
 * refuses a different one.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { ChargebeeClient } from "@/integrations/chargebee";
import { createBillingAccountRepository } from "@/repositories/billing-account.repository";
import { createAccountService, TOPUP_CLAIM_LEASE_MS, TOPUP_KEY_REPLAY_MS } from "@/services/account.service";
import { createCheckoutService } from "@/services/checkout.service";

import { lifecycleRig, MINUTE, PACK, PLAN, T0, TENANT, UNIT, type LifecycleRig } from "./failure-matrix-lifecycle-webhooks-litellm.helpers";
import { makeFakePrisma, quietLogger } from "./harness";

const apply = (r: LifecycleRig) => r.accounts.applyPaidTopUps(TENANT, PACK, "1000");
const rows = (r: LifecycleRig) => [...r.prisma._topUps.values()];
const minutesPast = (ms: number) => ms / MINUTE + 1;

async function subscribed() {
  const r = lifecycleRig();
  await r.subscribe("sub_1");
  return r;
}

describe("C57a the local guard: one grant per paid invoice, whatever repeats", () => {
  it("a repeat apply answers {applied: 0} — at once, and long after Chargebee's 30-minute key window — and sends nothing", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1");

    expect(await apply(r)).toEqual({ applied: 1, credits: "1000" });
    expect(rows(r)).toEqual([
      expect.objectContaining({ invoiceId: "inv_1", status: "APPLIED", source: "allocation", chargebeeRef: "ledger_operation:alloc_1" }),
    ]);

    expect(await apply(r)).toEqual({ applied: 0, credits: "0" }); // inside the window: once a 502
    r.at(45);
    expect(await apply(r)).toEqual({ applied: 0, credits: "0" }); // past it: once a second grant

    expect(r.cb.allocations).toHaveLength(1);
    expect(r.cb.allocateCalls).toHaveLength(1); // decided from the database alone
    expect(r.cb.liveCredits("sub_1")).toBe(2000);
  });

  it("the row is claimed, with the whole request, BEFORE the allocate leaves", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1");
    const client = r.cb.client as unknown as { allocate: (a: Record<string, unknown>) => Promise<unknown> };
    const original = client.allocate;
    let seenAtSend: unknown[] = [];
    client.allocate = async (args) => {
      seenAtSend = rows(r).map((row) => ({ ...row }));
      return original(args);
    };

    await apply(r);

    expect(seenAtSend).toEqual([
      expect.objectContaining({
        invoiceId: "inv_1",
        status: "SENDING",
        idempotencyKey: "invoice:inv_1",
        chargebeeSubscriptionId: "sub_1",
        ledgerUnitId: UNIT,
        credits: "1000",
        expiresAt: expect.any(Date),
      }),
    ]);
  });

  it("a lost answer: the next apply re-sends the SAME request under the SAME key — Chargebee replays it, nothing is granted twice", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1");
    r.cb.allocateFaults.push("lose-response");

    await expect(apply(r)).rejects.toThrow(/unreachable/);
    expect(r.cb.allocations).toHaveLength(1); // it landed
    expect(rows(r)[0]).toMatchObject({ status: "PENDING", attemptCount: 1 });

    r.at(3);
    expect(await apply(r)).toEqual({ applied: 1, credits: "1000" });

    expect(r.cb.allocations).toHaveLength(1);
    expect(r.cb.allocateCalls).toHaveLength(2);
    const [first, second] = r.cb.allocateCalls;
    expect(second).toEqual(first); // byte for byte: the key, the expiry, the amount
    expect(rows(r)[0]).toMatchObject({ status: "APPLIED", chargebeeRef: "ledger_operation:alloc_1", attemptCount: 2 });
    expect(await apply(r)).toEqual({ applied: 0, credits: "0" });
  });

  it("an allocate that never reached Chargebee is retried and granted — once", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1");
    r.cb.allocateFaults.push("unreachable");

    await expect(apply(r)).rejects.toThrow();
    expect(r.cb.allocations).toHaveLength(0);

    r.at(1);
    expect(await apply(r)).toEqual({ applied: 1, credits: "1000" });
    expect(r.cb.allocations).toHaveLength(1);
    expect(r.account().status).toBe("active");
  });

  it("a crash between the grant and the record: left to its sender for the lease, then completed by replay — no second grant", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1");
    // The process dies after Chargebee granted, before markApplied commits.
    const delegate = r.prisma.topUpGrant;
    const updateMany = delegate.updateMany;
    delegate.updateMany = vi.fn(async () => {
      delegate.updateMany = updateMany;
      throw new Error("worker killed");
    });

    await expect(apply(r)).rejects.toThrow("worker killed");
    expect(r.cb.allocations).toHaveLength(1);
    expect(rows(r)[0]).toMatchObject({ status: "SENDING" });

    // Inside the lease the row still belongs to its (dead) sender.
    expect(await apply(r)).toEqual({ applied: 0, credits: "0" });
    expect(r.cb.allocateCalls).toHaveLength(1);
    expect(r.metrics()).toContain("billing.topup.in_progress");

    r.at(minutesPast(TOPUP_CLAIM_LEASE_MS));
    expect(await apply(r)).toEqual({ applied: 1, credits: "1000" });
    expect(r.cb.allocations).toHaveLength(1);
    expect(rows(r)[0]).toMatchObject({ status: "APPLIED" });
  });

  it("two applies at once: one allocate", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1");

    const results = await Promise.all([apply(r), apply(r)]);

    expect(results.reduce((n, x) => n + x.applied, 0)).toBe(1);
    expect(r.cb.allocations).toHaveLength(1);
    expect(r.cb.allocateCalls).toHaveLength(1);
  });

  it("a refused allocate (a 400) fails the request and grants nothing; fixed, it is granted once", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1");
    r.cb.allocateFaults.push("refuse");

    await expect(apply(r)).rejects.toThrow(/invalid value/);
    expect(r.cb.allocations).toHaveLength(0);
    expect(r.metrics()).toContain("billing.topup.allocate_failed");

    r.at(1);
    expect(await apply(r)).toEqual({ applied: 1, credits: "1000" });
    expect(r.cb.allocations).toHaveLength(1);
  });
});

describe("C57a past Chargebee's replay window, the key is dead: look before sending", () => {
  const pastWindow = minutesPast(TOPUP_KEY_REPLAY_MS) + 10;

  it("the allocation DID land: recognised from its grant block, recorded, nothing sent", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1");
    r.cb.allocateFaults.push("lose-response");
    await expect(apply(r)).rejects.toThrow();

    r.at(pastWindow);
    expect(await apply(r)).toEqual({ applied: 1, credits: "1000" });

    expect(r.cb.allocateCalls).toHaveLength(1);
    expect(r.cb.allocations).toHaveLength(1);
    expect(rows(r)[0]).toMatchObject({ status: "APPLIED", chargebeeRef: expect.stringMatching(/^grant_block:gb_/) });
    expect(r.metrics()).toContain("billing.topup.resolved_from_ledger");
    expect(r.account().status).toBe("active");
  });

  it("it never landed: sent again under a NEW key, and granted once", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1");
    r.cb.allocateFaults.push("unreachable");
    await expect(apply(r)).rejects.toThrow();

    r.at(pastWindow);
    expect(await apply(r)).toEqual({ applied: 1, credits: "1000" });

    expect(r.cb.allocations).toHaveLength(1);
    expect(r.cb.allocateCalls.map((c) => c.idempotencyKey)).toEqual(["invoice:inv_1", "invoice:inv_1:2"]);
    expect(rows(r)[0]).toMatchObject({ status: "APPLIED", idempotencyKey: "invoice:inv_1:2" });
  });

  it("the grant-block list was cut short: nothing is sent, and a person is told", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1");
    r.cb.allocateFaults.push("unreachable");
    await expect(apply(r)).rejects.toThrow();

    r.at(pastWindow);
    r.cb.grantBlocksIncomplete = true;
    expect(await apply(r)).toEqual({ applied: 0, credits: "0" });

    expect(r.cb.allocateCalls).toHaveLength(1);
    expect(r.errors).toContainEqual(expect.objectContaining({ metric: "billing.topup.unresolved", invoiceId: "inv_1" }));
    expect(rows(r)[0]).toMatchObject({ status: "PENDING" });
  });

  it("another pack's grant, made while this one was in doubt, is not taken for this one's", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1");
    r.cb.allocateFaults.push("unreachable"); // inv_1 never lands
    await expect(apply(r)).rejects.toThrow();
    const inDoubt = rows(r)[0]!;

    // A second pack was granted in the same minute, by another caller.
    const block = await r.cb.client.allocate({ subscriptionId: "sub_1", unitId: UNIT, amount: "1000", expiresAt: 4_000_000_000, idempotencyKey: "invoice:inv_2" });
    r.prisma._topUps.set("tg_2", {
      ...inDoubt,
      id: "tg_2",
      invoiceId: "inv_2",
      idempotencyKey: "invoice:inv_2",
      status: "APPLIED",
      chargebeeRef: `ledger_operation:${block.operationId}`,
      appliedAt: inDoubt.createdAt,
      error: null,
    });

    r.at(pastWindow);
    expect(await apply(r)).toEqual({ applied: 1, credits: "1000" });

    expect(r.cb.allocations).toHaveLength(2); // inv_2's, and inv_1's at last
    expect(rows(r).find((x) => x.invoiceId === "inv_1")).toMatchObject({ status: "APPLIED", idempotencyKey: "invoice:inv_1:2" });
  });
});

describe("C57d a pack whose item price carries its OWN Credit Grant", () => {
  it("granted by Chargebee into the account's unit: recorded, counted, never allocated", async () => {
    const r = await subscribed();
    r.cb.payPackWithGrant("inv_1", { unit: UNIT });

    expect(await apply(r)).toEqual({ applied: 1, credits: "1000" });
    expect(r.cb.allocateCalls).toHaveLength(0);
    expect(rows(r)[0]).toMatchObject({ source: "catalogue_grant", status: "APPLIED", chargebeeRef: expect.stringMatching(/^grant_block:/) });
    expect(await apply(r)).toEqual({ applied: 0, credits: "0" });
    expect(r.cb.liveCredits("sub_1")).toBe(2000);
  });

  it("granted into ANOTHER unit, as on the live site: nothing allocated (a second grant), the owner told, the account's unit untouched", async () => {
    const r = await subscribed();
    r.cb.payPackWithGrant("inv_85", { unit: "token" });

    expect(await apply(r)).toEqual({ applied: 0, credits: "0" });
    expect(r.cb.allocateCalls).toHaveLength(0);
    expect(r.errors).toContainEqual(
      expect.objectContaining({ metric: "billing.topup.catalogue_grant_wrong_unit", invoiceId: "inv_85", grantedUnits: ["token"], accountUnit: UNIT }),
    );

    // Once: it is recorded, so a repeat neither allocates nor re-raises.
    const raised = r.errors.length;
    expect(await apply(r)).toEqual({ applied: 0, credits: "0" });
    expect(r.errors).toHaveLength(raised);

    // And the second unit never moves billing onto itself (C57b).
    await r.accounts.syncFromChargebee(TENANT);
    expect(r.account().ledgerUnitId).toBe(UNIT);
  });

  it("an invoice with a plan line AND a pack line: the plan's grant block is not the pack's", async () => {
    const r = await subscribed();
    const planBlock = r.cb.blocks.find((b) => b.kind === "plan")!;
    // The subscription's own invoice also carried a pack, whose item has no grant.
    r.cb.paidInvoices.push({
      id: planBlock.invoice!.id,
      line_items: [
        { id: planBlock.invoice!.lineItemId, entity_id: PLAN },
        { id: "li_pack", entity_id: PACK },
      ],
    });

    expect(await apply(r)).toEqual({ applied: 1, credits: "1000" });
    expect(r.cb.allocations).toHaveLength(1);
  });

  it("checkout for such a pack is refused by Chargebee — answered as a named misconfiguration, not a 502", async () => {
    const prisma = makeFakePrisma({ chargebeeCustomerId: TENANT } as never);
    const errors: Array<Record<string, unknown>> = [];
    const chargebee = {
      checkoutOneTime: async () => {
        throw Object.assign(new Error("Charges with grants are not supported for customer one off charges"), {
          status: 400,
          apiErrorCode: "invalid_request",
        });
      },
    } as unknown as ChargebeeClient;
    const accounts = createBillingAccountRepository(prisma);
    const checkout = createCheckoutService({
      chargebee,
      accountService: createAccountService({ prisma, chargebee, usdPerCredit: "0.001", logger: quietLogger }),
      accounts,
      itemPriceIds: [PLAN],
      defaultItemPriceId: PLAN,
      topUpItemPriceId: PACK,
      topUpCredits: "1000",
      logger: { ...quietLogger, error: (o: unknown) => void errors.push(o as Record<string, unknown>) },
    });

    await expect(checkout.startTopUp(TENANT)).rejects.toMatchObject({ kind: "conflict", code: "topup-misconfigured" });
    expect(errors).toContainEqual(expect.objectContaining({ metric: "billing.topup.pack_carries_grant", itemPriceId: PACK }));
  });
});

describe("invoices granted before the guard existed", () => {
  it("a pre-existing APPLIED row — what the seed migration writes — means no grant, and no Chargebee call", async () => {
    const r = await subscribed();
    r.cb.payPack("85");
    r.prisma._topUps.set("seed_85", {
      id: "seed_85",
      tenantId: TENANT,
      invoiceId: "85",
      chargebeeSubscriptionId: "sub_1",
      ledgerUnitId: UNIT,
      credits: "1000",
      expiresAt: new Date(T0 + 30 * 86_400_000),
      idempotencyKey: "invoice:85",
      keyIssuedAt: new Date(T0),
      status: "APPLIED",
      source: "allocation",
      chargebeeRef: "ledger_operation:2082089592063869696",
      attemptCount: 1,
      error: null,
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
      appliedAt: new Date(T0),
    });

    expect(await apply(r)).toEqual({ applied: 0, credits: "0" });
    expect(r.cb.allocateCalls).toHaveLength(0);
  });

  it("the seed migration records invoice 85 (org_aws_com, op 2082089592063869696) and is a no-op anywhere else", () => {
    const sql = readFileSync(
      new URL("../prisma/migrations/20260924190100_topup_grant_seed_test_site/migration.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toMatch(/'480e7a6c-9714-478d-beb6-9621bb90dda3'::uuid, '85', '16A6ReVW76FGuAc8', 'token-test'/);
    expect(sql).toContain("'ledger_operation:2082089592063869696'");
    expect(sql).toMatch(/JOIN "billing_account" a\s+ON a."tenant_id" = s."tenant_id"\s+AND a."chargebee_subscription_id" = s."subscription_id"/);
    expect(sql).toContain('ON CONFLICT ("tenant_id", "invoice_id") DO NOTHING');
  });
});
