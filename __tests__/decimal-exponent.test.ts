/**
 * C44: money below 1e-6 must bill, never wedge.
 *
 * Found live (2026-09-24, org_fs_com): a window worth $0.0000005 was written
 * as a PENDING sync row. Prisma returns DECIMAL columns as `Decimal`, whose
 * toString() is "5e-7" below 1e-6; the sync stringified the row and parsed it,
 * the parser rejected the exponent, and it threw BEFORE the claim — every
 * tick, for good. The row stayed unsent, the cursor never moved, and the
 * tenant's billing stopped. The harness passed throughout because FakePrisma
 * handed back plain strings; it now hands back Prisma's own Decimal.
 *
 * Two guards, each tested on its own below so a mutation of either is seen:
 *   - the repository converts every Decimal it reads with toFixed() (exact,
 *     plain notation) — chargebee-sync.repository.ts
 *   - decimal()/scaled() accept exponent notation exactly — models/decimal.ts
 */

import { describe, expect, it } from "vitest";

import { add, decimal, fromDb, scaled } from "@/models/decimal";
import { usdToCredits } from "@/models/rate";
import { createChargebeeSyncRepository } from "@/repositories/chargebee-sync.repository";
import { createUsageSyncService } from "@/services/usage-sync.service";
import { Prisma } from "../node_modules/.prisma/billing/index";

import {
  FakeChargebee,
  FakeUsageSource,
  MINUTE,
  RATE,
  SLUG,
  T0,
  TENANT,
  makeFakePrisma,
  quietLogger,
  randomUUID,
} from "./harness";

describe("decimal(): exponent notation, exactly", () => {
  it.each([
    ["5e-7", "0.0000005"],
    ["5E-7", "0.0000005"],
    ["-5e-7", "-0.0000005"],
    ["1e-7", "0.0000001"],
    ["1e-10", "0.0000000001"],
    ["1.2345e-7", "0.0000001235"], // the 11th place rounds half-up, as for any input
    ["4e-11", "0"], // below Chargebee's ten places
    ["5e-11", "0.0000000001"],
    ["1.25e+3", "1250"],
    ["1.25e3", "1250"],
    ["1e21", "1000000000000000000000"],
    ["0e-7", "0"],
  ])("%s → %s", (input, expected) => {
    expect(decimal(input)).toBe(expected);
  });

  it("parses a JS number through its shortest form, so 5e-7 is exactly 0.0000005", () => {
    expect(decimal(5e-7)).toBe("0.0000005");
    expect(decimal(1e-10)).toBe("0.0000000001");
    expect(decimal(1.23456789012e-7)).toBe("0.0000001235");
    expect(decimal(1e21)).toBe("1000000000000000000000");
  });

  it("still refuses what is not a number, and an exponent no amount of money needs", () => {
    for (const bad of ["e5", "1e", "1.e5", "1e5.5", "5e-7x", "1e999999999", "--5e-7"]) {
      expect(() => scaled(bad), bad).toThrow(TypeError);
    }
  });

  it("round-trips every Prisma Decimal the sync can read back — String(d) and d.toFixed() agree", () => {
    for (const column of ["0.0000005000", "0.0000001000", "0.0000000001", "0.0005000000", "0.0000012345", "1000.0000000000", "0"]) {
      const d = new Prisma.Decimal(column);
      expect(decimal(d)).toBe(decimal(d.toFixed()));
      expect(fromDb(d)).toBe(decimal(column));
      expect(fromDb(d)).not.toMatch(/e/i);
    }
    // The premise, pinned: this is what Prisma prints.
    expect(String(new Prisma.Decimal("0.0000005000"))).toBe("5e-7");
    expect(String(new Prisma.Decimal("0.0000001000"))).toBe("1e-7");
  });

  it("never renders exponent notation, however small", () => {
    expect(add("1e-10", "1e-10")).toBe("0.0000000002");
    expect(usdToCredits("1e-10", RATE)).toBe("0.0000001");
  });
});

describe("the repository hands the service strings, never Decimals", () => {
  it("FakePrisma answers with Prisma's Decimal, exponent and all — so the harness can no longer hide C44", async () => {
    const prisma = makeFakePrisma({}, T0);
    await prisma.chargebeeSync.create({ data: pendingRow({ amount: "0.0005", billedUsd: "0.0000005" }) });
    const raw = await prisma.chargebeeSync.findFirst({ where: { tenantId: TENANT } });
    expect(raw.billedUsd).toBeInstanceOf(Prisma.Decimal);
    expect(String(raw.billedUsd)).toBe("5e-7");
  });

  it("oldestUnresolved, findByWindowStart and latestSettled convert with toFixed(): plain, exact", async () => {
    const prisma = makeFakePrisma({}, T0);
    await prisma.chargebeeSync.create({ data: pendingRow({ amount: "0.0000001", billedUsd: "0.0000000001" }) });
    await prisma.chargebeeSync.create({
      data: pendingRow({
        fromIngestedAt: new Date(T0 - 2 * MINUTE),
        toIngestedAt: new Date(T0 - MINUTE),
        amount: "0.0005",
        billedUsd: "0.0000005",
        status: "SUCCESS",
        settledAt: new Date(T0),
      }),
    });
    const syncs = createChargebeeSyncRepository(prisma as never);

    const held = await syncs.oldestUnresolved(TENANT);
    expect([held!.amount, held!.billedUsd]).toEqual(["0.0000001", "0.0000000001"]);
    expect(typeof held!.amount).toBe("string");

    const byStart = await syncs.findByWindowStart(TENANT, new Date(T0));
    expect([byStart!.amount, byStart!.billedUsd]).toEqual(["0.0000001", "0.0000000001"]);

    // What the billing page renders as "last synced" — once "5e-7".
    const last = await syncs.latestSettled(TENANT);
    expect([last!.amount, last!.billedUsd]).toEqual(["0.0005", "0.0000005"]);
  });
});

describe("a window worth less than a millionth of a dollar bills, and never wedges", () => {
  function rig() {
    const prisma = makeFakePrisma({}, T0);
    const chargebee = new FakeChargebee(1000);
    const usage = new FakeUsageSource();
    const errors: Array<Record<string, unknown>> = [];
    let now = T0;
    const sync = createUsageSyncService({
      prisma: prisma as never,
      usage,
      chargebee,
      usdPerCredit: RATE,
      lagMs: MINUTE,
      maxRangeMs: MINUTE,
      clock: () => now,
      logger: { ...quietLogger, error: (o: unknown) => void errors.push(o as Record<string, unknown>) },
    });
    return {
      prisma,
      chargebee,
      usage,
      errors,
      sync,
      at(m: number) {
        now = T0 + m * MINUTE;
        usage.nowMs = now;
        prisma._now = now;
      },
    };
  }

  it.each([
    // [usd per window, credits captured]
    [5e-7, "0.0005"], // the live wedge: billed_usd reads back as "5e-7"
    [1e-10, "0.0000001"], // the smallest dollar amount DECIMAL(20,10) holds; both columns read back in exponent form
  ])("$%s: a lost answer is recovered from the row as READ BACK — settled once, cursor moved", async (usd, credits) => {
    const r = rig();
    r.usage.add("tiny:1", T0 + 30_000, usd);
    r.at(2);
    r.chargebee.loseResponseNext = true; // lands, answer lost: the row must be read back to be settled
    const first = await r.sync.runOnce([SLUG]);
    expect(first.errors).toEqual([]);
    expect(r.prisma._stuck).toMatchObject({ status: "UNKNOWN", amount: credits });

    r.at(3);
    const second = await r.sync.runOnce([SLUG]);

    expect(second.errors).toEqual([]); // once: billing.sync.tenant_error "Not a decimal value: \"5e-7\""
    expect(second.results[0]).toMatchObject({ outcome: "replayed", amount: credits });
    expect(r.prisma._stuck).toBeUndefined();
    expect(r.chargebee.appliedCount).toBe(1);
    expect(r.chargebee.applied.get(r.prisma._log[0].id)).toBe(credits);
    expect(r.prisma._cursor).toBe(T0 + 2 * MINUTE); // and it carried on past the empty window
    expect(r.errors.filter((e) => e.metric === "billing.sync.tenant_error")).toEqual([]);
  });

  it("the live shape exactly: a PENDING row worth $0.0000005 written by an earlier tick is sent on the next", async () => {
    const r = rig();
    // Its id is the live row's: c109d630 held org_fs_com's billing from 11:23 UTC.
    await r.prisma.chargebeeSync.create({
      data: pendingRow({ id: "c109d630-d64d-43ef-927b-2a82e05129b8", amount: "0.0005", billedUsd: "0.0000005" }),
    });
    r.at(1);

    const pass = await r.sync.runOnce([SLUG]);

    expect(pass.errors).toEqual([]);
    expect(pass.results[0]).toMatchObject({ outcome: "synced", amount: "0.0005", billedUsd: "0.0000005" });
    expect(r.chargebee.captures).toEqual([{ id: r.prisma._log[0].id, amount: "0.0005" }]);
    expect(r.prisma._log[0].status).toBe("SUCCESS");
    expect(r.prisma._cursor).toBe(T0 + MINUTE);
  });

  it("$0.00000000004 — below Chargebee's ten places — settles as zero-cost: no capture, cursor moved", async () => {
    const r = rig();
    r.usage.add("tinier:1", T0 + 30_000, 4e-11);
    r.at(2);

    const pass = await r.sync.runOnce([SLUG]);

    expect(pass.errors).toEqual([]);
    expect(r.chargebee.captures).toEqual([]);
    expect(r.prisma._log).toEqual([expect.objectContaining({ status: "SUCCESS", amount: "0", billedUsd: "0", eventCount: 1 })]);
    expect(r.prisma._cursor).toBe(T0 + MINUTE); // the one window inside now − lag, resolved
  });
});

function pendingRow(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    tenantId: TENANT,
    chargebeeSubscriptionId: "sub_1",
    ledgerUnitId: "token",
    fromIngestedAt: new Date(T0),
    toIngestedAt: new Date(T0 + MINUTE),
    eventCount: 1,
    status: "PENDING",
    settledAt: null,
    ...over,
  };
}
