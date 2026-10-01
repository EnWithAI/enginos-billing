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
import { createAccountService, TOPUP_CLAIM_LEASE_MS, TOPUP_KEY_REPLAY_MS, topUpUnits } from "@/services/account.service";
import { createCheckoutService } from "@/services/checkout.service";
import { createWebhookService } from "@/services/webhook.service";

import { lifecycleRig, MINUTE, PACK, PLAN, T0, TENANT, UNIT, type LifecycleRig } from "./failure-matrix-lifecycle-webhooks-litellm.helpers";
import { quietLogger, testCatalog } from "./harness";

const apply = (r: LifecycleRig) => r.accounts.applyPaidTopUps(TENANT, PACK, "1000");
const rows = (r: LifecycleRig) => [...r.prisma._topUps.values()];
const minutesPast = (ms: number) => ms / MINUTE + 1;

async function subscribed() {
  const r = lifecycleRig();
  await r.subscribe("sub_1");
  return r;
}

describe("a top-up of several units grants what the PAID invoice says", () => {
  it("grants credits per unit × the invoice line's quantity — once", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1", 3);

    expect(await apply(r)).toEqual({ applied: 1, credits: "3000" });
    expect(rows(r)).toEqual([expect.objectContaining({ invoiceId: "inv_1", status: "APPLIED" })]);
    expect(r.cb.liveCredits("sub_1")).toBe(4000); // the plan's 1000 + 3 × 1000

    expect(await apply(r)).toEqual({ applied: 0, credits: "0" });
    expect(r.cb.allocateCalls).toHaveLength(1);
  });

  it("each invoice is granted its own quantity", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1", 2);
    r.cb.payPack("inv_2", 5);

    expect(await apply(r)).toEqual({ applied: 2, credits: "7000" });
    expect(r.cb.liveCredits("sub_1")).toBe(8000);
  });

  it.each([1.5, 0, -2, "3", null])("holds an invoice whose quantity is %s — nothing sent, nothing claimed", async (quantity) => {
    const r = await subscribed();
    r.cb.payPack("inv_1", quantity);

    expect(await apply(r)).toEqual({ applied: 0, credits: "0" });
    expect(r.cb.allocateCalls).toHaveLength(0);
    expect(rows(r)).toEqual([]);
  });
});

describe("a pack billing must allocate itself, with TOPUP_CREDITS unset", () => {
  it("is held and said out loud — never granted a guessed amount — and granted once it is set", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1", 2);

    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "")).toEqual({ applied: 0, credits: "0" });
    expect(r.cb.allocateCalls).toHaveLength(0);
    expect(rows(r)).toEqual([]);
    expect(r.metrics()).toContain("billing.topup.credits_per_unit_unset");

    expect(await r.accounts.applyPaidTopUps(TENANT, PACK, "1000")).toEqual({ applied: 1, credits: "2000" });
    expect(r.cb.allocations).toHaveLength(1);
  });
});

describe("topUpUnits", () => {
  const line = (entity_id: string, quantity?: unknown) => ({ id: `li_${entity_id}`, entity_id, ...(quantity === undefined ? {} : { quantity }) });

  it("sums the quantity of every line for the top-up charge, and ignores other lines", () => {
    expect(topUpUnits({ line_items: [line(PACK, 2), line(PLAN, 9), line(PACK, 3)] }, PACK)).toBe(5);
  });

  it("counts a line with no quantity as one unit, as every top-up was before", () => {
    expect(topUpUnits({ line_items: [line(PACK)] }, PACK)).toBe(1);
  });

  it("refuses to guess: a quantity that is not a positive whole number, or no line at all, is null", () => {
    expect(topUpUnits({ line_items: [line(PACK, 2.5)] }, PACK)).toBeNull();
    expect(topUpUnits({ line_items: [line(PACK, 0)] }, PACK)).toBeNull();
    expect(topUpUnits({ line_items: [line(PLAN, 1)] }, PACK)).toBeNull();
    expect(topUpUnits({}, PACK)).toBeNull();
  });
});

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
});

/**
 * TOPUP_CHARGEBEE_GRANTS: the pack is charged onto the subscription
 * (`create_for_charge_items_and_charges`, the admin UI's Add Charge) and
 * Chargebee issues its Credit Grant — MEASURED, the grant block's `created_at`
 * one second after the invoice's `paid_at`.
 */
describe("a pack charged to the card on file, Chargebee granting", () => {
  const paid = (id: string, quantity = 1) => ({ id, status: "paid", totalMinor: 100 * quantity, amountDueMinor: 0, currencyCode: "INR" });

  function charging(r: LifecycleRig, chargeItem: ChargebeeClient["chargeItem"], sleep = vi.fn(async () => {})) {
    // The org has confirmed its billing address: no pack is sold before it
    // has (billing-address-required). Its subscription is in INR, the
    // currency of the pack sold here.
    r.prisma._accounts.get(TENANT)!.billingCountry = "IN";
    const checkout = createCheckoutService({
      chargebee: {
        ...(r.cb.client as unknown as ChargebeeClient),
        chargeItem,
        paymentSource: async () => ({ id: "pm_1", type: "card", status: "valid", brand: "visa", last4: "1111", expiryMonth: 12, expiryYear: 2030 }),
        unpaidInvoicesFor: async () => [],
      },
      accountService: r.accounts,
      accounts: createBillingAccountRepository(r.prisma as never),
      itemPriceIds: [PLAN],
      defaultItemPriceId: PLAN,
      catalog: testCatalog({ topUp: PACK, credits: "50" }),
      topUpChargebeeGrants: true,
      logger: { log() {}, warn: (o: unknown) => void r.warns.push(o as Record<string, unknown>), error: (o: unknown) => void r.errors.push(o as Record<string, unknown>) },
      sleep,
    });
    return { checkout, sleep };
  }

  it("waits out the second Chargebee takes to issue the grant block, then records it — never allocates", async () => {
    const r = await subscribed();
    let held: GrantBlockOf<LifecycleRig> | null = null;
    const chargeItem = vi.fn(async ({ quantity = 1 }: { quantity?: number }) => {
      held = payWithLateGrant(r, "96", 50 * quantity);
      return paid("96", quantity);
    });
    const sleep = vi.fn(async () => {
      if (held) r.cb.blocks.push(held);
      held = null;
    });
    const { checkout } = charging(r, chargeItem as never, sleep);

    expect(await checkout.startTopUp(TENANT, 2)).toMatchObject({ invoice: { id: "96", status: "paid" }, quantity: 2, applied: 1, credits: "100" });
    expect(chargeItem).toHaveBeenCalledWith({ subscriptionId: "sub_1", itemPriceId: PACK, quantity: 2 });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(r.cb.allocateCalls).toHaveLength(0);
    expect(rows(r)).toEqual([expect.objectContaining({ invoiceId: "96", source: "catalogue_grant", status: "APPLIED" })]);
  });

  it("a grant block that never shows is left for the next apply — nothing allocated in the meantime", async () => {
    const r = await subscribed();
    let held: GrantBlockOf<LifecycleRig> | null = null;
    const chargeItem = vi.fn(async () => {
      held = payWithLateGrant(r, "96", 50);
      return paid("96");
    });
    const { checkout, sleep } = charging(r, chargeItem as never);

    expect(await checkout.startTopUp(TENANT)).toMatchObject({ applied: 0, credits: "0" });
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(r.cb.allocateCalls).toHaveLength(0);
    expect(rows(r)).toEqual([]);
    expect(r.warns).toContainEqual(expect.objectContaining({ metric: "billing.topup.grant_not_visible", invoiceId: "96" }));

    r.cb.blocks.push(held!);
    expect(await checkout.applyTopUps(TENANT)).toEqual({ applied: 1, credits: "50" });
    expect(r.cb.allocateCalls).toHaveLength(0);
  });

  // No credits for a failed payment (2026-09-28). MEASURED: a declined card
  // leaves the invoice `payment_due` with Chargebee's block already issued.
  it("an invoice Chargebee could not collect grants nothing — its block is not recorded, nothing allocated, no wait", async () => {
    const r = await subscribed();
    const chargeItem = vi.fn(async () => {
      r.cb.payPackWithGrant("97", { unit: UNIT, credits: 50 });
      r.cb.paidInvoices.pop(); // issued with the invoice, but the invoice is not paid
      return { id: "97", status: "payment_due", totalMinor: 100, amountDueMinor: 100, currencyCode: "INR", nextRetryAt: null };
    });
    const { checkout, sleep } = charging(r, chargeItem as never);

    expect(await checkout.startTopUp(TENANT)).toEqual({
      invoice: expect.objectContaining({ id: "97", status: "payment_due" }),
      quantity: 1,
      applied: 0,
      credits: "0",
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(r.cb.allocateCalls).toHaveLength(0);
    expect(rows(r)).toEqual([]);
    expect(r.warns).toContainEqual(expect.objectContaining({ metric: "billing.topup.unpaid", invoiceId: "97" }));
  });

  it("payment_succeeded before the grant block exists is failed for redelivery, never allocated — and records it once redelivered", async () => {
    const r = await subscribed();
    const held = payWithLateGrant(r, "96", 50);
    const webhooks = createWebhookService({
      accountService: r.accounts,
      accounts: createBillingAccountRepository(r.prisma as never),
      topUps: [{ itemPriceId: PACK, creditsPerUnit: "50" }],
      chargebeeGrants: true,
      logger: quietLogger,
    });
    const event = {
      id: "ev_96",
      event_type: "payment_succeeded",
      content: { customer: { id: TENANT }, invoice: { id: "96", line_items: [{ entity_id: PACK }] } },
    };

    await expect(webhooks.handle(event)).rejects.toThrow(/not visible yet/);
    expect(r.cb.allocateCalls).toHaveLength(0);

    r.cb.blocks.push(held);
    await webhooks.handle(event);
    expect(rows(r)).toEqual([expect.objectContaining({ invoiceId: "96", source: "catalogue_grant", status: "APPLIED" })]);
    expect(r.cb.allocateCalls).toHaveLength(0);
  });
});

/** Pays the pack with its grant, but holds the grant block back — Chargebee has not issued it yet. */
function payWithLateGrant(r: LifecycleRig, invoiceId: string, credits: number) {
  r.cb.payPackWithGrant(invoiceId, { unit: UNIT, credits });
  return r.cb.blocks.pop()!;
}

type GrantBlockOf<R extends LifecycleRig> = R["cb"]["blocks"][number];

describe("payment_succeeded: a pack is granted even when the buyer closed the tab", () => {
  const paymentSucceeded = (invoiceId: string, itemPriceId: string) => ({
    id: `ev_${invoiceId}`,
    event_type: "payment_succeeded",
    content: { customer: { id: TENANT }, invoice: { id: invoiceId, line_items: [{ entity_id: itemPriceId }] } },
  });

  it("grants the paid pack — once, however often Chargebee delivers it, and whether or not the page applied it first", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1", 2);

    await r.deliver(paymentSucceeded("inv_1", PACK));
    expect(rows(r)).toEqual([expect.objectContaining({ invoiceId: "inv_1", status: "APPLIED", credits: "2000" })]);
    expect(r.cb.liveCredits("sub_1")).toBe(3000);

    await r.deliver(paymentSucceeded("inv_1", PACK));
    expect(await apply(r)).toEqual({ applied: 0, credits: "0" });
    expect(r.cb.allocateCalls).toHaveLength(1);
  });

  it("any other payment — the plan, a renewal — grants nothing", async () => {
    const r = await subscribed();
    r.cb.payPack("inv_1");

    await r.deliver(paymentSucceeded("inv_2", PLAN));
    expect(r.cb.allocateCalls).toHaveLength(0);
    expect(rows(r)).toEqual([]);
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
