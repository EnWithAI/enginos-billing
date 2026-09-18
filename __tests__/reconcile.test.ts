/**
 * Reconciliation checks.
 *
 * Every case here is a divergence that actually occurred during end-to-end
 * testing against the live stack. None of them raised an error at the time —
 * they were only visible by comparing systems afterwards.
 */

import { describe, expect, it } from "vitest";

import { reconcileTenant } from "@/lib/reconcile";
import { TENANT, makeFakePrisma } from "./harness";

const T = Date.UTC(2026, 8, 16, 9, 0, 0);
const MIN = 60_000;

function seed(prisma: ReturnType<typeof makeFakePrisma>) {
  prisma._accounts.get(TENANT)!.syncFrom = new Date(T);
}

function batch(over: Record<string, unknown> = {}) {
  return {
    id: "batch-1",
    tenantId: TENANT,
    kind: "window",
    status: "captured",
    windowStart: new Date(T),
    windowEnd: new Date(T + MIN),
    chargebeeOperationId: "op-1",
    ...over,
  };
}

function entry(over: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    tenantId: TENANT,
    entryType: "consume",
    deltaCredits: "-1",
    sourceRef: "batch-1",
    chargebeeOperationId: "op-1",
    occurredAt: new Date(T + MIN),
    billedUsd: "0.001",
    ...over,
  };
}

describe("reconciliation", () => {
  it("passes when a captured batch has its matching ledger entry", async () => {
    const prisma = makeFakePrisma();
    seed(prisma);
    prisma._batches.set("batch-1", batch() as never);
    prisma._entries.push(entry() as never);

    expect(await reconcileTenant(TENANT, prisma as never)).toEqual([]);
  });

  it("flags a captured batch with NO ledger entry", async () => {
    // This one bit for real: a batch marked captured, no entry, no Chargebee
    // capture. The window can never be re-billed because the unique index
    // blocks it, so the revenue is simply gone and nothing complains.
    const prisma = makeFakePrisma();
    seed(prisma);
    prisma._batches.set("batch-1", batch() as never);

    const problems = await reconcileTenant(TENANT, prisma as never);
    expect(problems.map((p) => p.kind)).toContain("batch-without-entry");
  });

  it("flags a ledger entry citing another batch's operation id", async () => {
    // The signature of a false-positive idempotency check: Chargebee ignores
    // `id[is]` on /ledger_operations, so an unhardened lookup returns somebody
    // else's operation and the entry records money that never moved.
    const prisma = makeFakePrisma();
    seed(prisma);
    prisma._batches.set("batch-1", batch({ chargebeeOperationId: "op-1" }) as never);
    prisma._entries.push(entry({ chargebeeOperationId: "op-BELONGING-TO-ANOTHER-BATCH" }) as never);

    const problems = await reconcileTenant(TENANT, prisma as never);
    expect(problems.map((p) => p.kind)).toContain("operation-id-mismatch");
  });

  it("flags a consume entry whose batch no longer exists", async () => {
    const prisma = makeFakePrisma();
    seed(prisma);
    prisma._entries.push(entry({ sourceRef: "batch-that-was-deleted" }) as never);

    const problems = await reconcileTenant(TENANT, prisma as never);
    expect(problems.map((p) => p.kind)).toContain("entry-without-batch");
  });

  it("does not flag a grant, which is keyed on an event id rather than a batch", async () => {
    const prisma = makeFakePrisma();
    seed(prisma);
    prisma._entries.push(entry({ entryType: "grant", sourceRef: "evt_123", deltaCredits: "1000" }) as never);

    expect(await reconcileTenant(TENANT, prisma as never)).toEqual([]);
  });

  it("flags a gap between windows, where usage would fall through unbilled", async () => {
    const prisma = makeFakePrisma();
    seed(prisma);
    prisma._batches.set("batch-1", batch() as never);
    prisma._entries.push(entry() as never);
    prisma._batches.set(
      "batch-2",
      batch({
        id: "batch-2",
        status: "skipped",
        windowStart: new Date(T + 5 * MIN), // gap: previous ended at T + 1min
        windowEnd: new Date(T + 6 * MIN),
      }) as never,
    );

    const problems = await reconcileTenant(TENANT, prisma as never);
    expect(problems.map((p) => p.kind)).toContain("window-gap");
  });

  it("ignores failed batches when checking contiguity", async () => {
    // A failed batch deliberately holds the cursor; it is not a gap, and
    // flagging it would bury the real gaps in noise.
    const prisma = makeFakePrisma();
    seed(prisma);
    prisma._batches.set("batch-1", batch() as never);
    prisma._entries.push(entry() as never);
    prisma._batches.set(
      "batch-2",
      batch({ id: "batch-2", status: "failed", windowStart: new Date(T + MIN), windowEnd: new Date(T + 2 * MIN) }) as never,
    );

    const problems = await reconcileTenant(TENANT, prisma as never);
    expect(problems.filter((p) => p.kind === "window-gap")).toEqual([]);
  });
});
