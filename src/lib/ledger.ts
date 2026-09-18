/**
 * The credit ledger: append-only entries, balance derived.
 *
 * There is no `UPDATE balance SET balance = balance - n` anywhere in this
 * service. A stored running balance goes wrong the moment two writes race, and
 * it cannot answer "why is the balance this number" a year later. Every row is
 * immutable and carries the reason it exists.
 *
 * `(tenant_id, source_ref)` is unique, and that single constraint is what makes
 * both a replayed webhook and a replayed capture into no-ops. It is the
 * anti-double-charge, and it lives in the database rather than in a code path
 * that can be bypassed.
 */

import { ENTRY, isUniqueViolation, prisma } from "./db";

export interface LedgerBalanceView {
  allocated: string;
  consumed: string;
  current: string;
}

export interface AppendArgs {
  tenantId: string;
  entryType: (typeof ENTRY)[keyof typeof ENTRY];
  /** Signed: positive grants, negative consumption. */
  deltaCredits: string;
  /** Batch UUID for a consume, Chargebee event id for a grant. */
  sourceRef: string;
  billedUsd?: string | null;
  chargebeeOperationId?: string | null;
  occurredAt?: Date;
}

/**
 * Write an entry, or report that it already existed.
 *
 * Returns `{ created: false }` rather than throwing on a duplicate, because a
 * duplicate is the expected outcome of a replay, not an error. Callers use it
 * to distinguish "I just charged this" from "this was already charged".
 */
export async function appendEntry(
  args: AppendArgs,
  /**
   * The client to write through. Defaults to the singleton, but callers that
   * own a transaction (or a test) MUST pass theirs — writing the ledger through
   * a different connection than the batch update would break the atomicity the
   * whole recovery story depends on.
   */
  client: { creditLedgerEntry: typeof prisma.creditLedgerEntry } = prisma,
): Promise<{ created: boolean }> {
  try {
    await client.creditLedgerEntry.create({
      data: {
        tenantId: args.tenantId,
        entryType: args.entryType,
        deltaCredits: args.deltaCredits,
        sourceRef: args.sourceRef,
        billedUsd: args.billedUsd ?? null,
        chargebeeOperationId: args.chargebeeOperationId ?? null,
        ...(args.occurredAt ? { occurredAt: args.occurredAt } : {}),
      },
    });
    return { created: true };
  } catch (err) {
    // Expected on replay: the unique index on (tenant_id, source_ref) is the
    // guarantee, so a collision means the work was already done.
    if (isUniqueViolation(err)) return { created: false };
    throw err;
  }
}

/**
 * Current balance, derived.
 *
 * Three aggregates over one index rather than a stored counter. Cheap enough to
 * call on a page render, and it cannot disagree with the entries it sums.
 */
export async function balanceOf(
  tenantId: string,
  client: { creditLedgerEntry: typeof prisma.creditLedgerEntry } = prisma,
): Promise<LedgerBalanceView> {
  const grouped = await client.creditLedgerEntry.groupBy({
    by: ["entryType"],
    where: { tenantId },
    _sum: { deltaCredits: true },
  });

  let allocated = 0;
  let consumed = 0;
  let current = 0;

  for (const row of grouped) {
    const sum = Number(row._sum.deltaCredits ?? 0);
    current += sum;
    if (row.entryType === ENTRY.GRANT) allocated += sum;
    // Consumption and expiry are both negative; report consumption as positive.
    if (row.entryType === ENTRY.CONSUME) consumed -= sum;
  }

  return {
    allocated: String(allocated),
    consumed: String(consumed),
    current: String(current),
  };
}

/** Recent entries for the account page, newest first. */
export function recentEntries(
  tenantId: string,
  limit = 50,
  client: { creditLedgerEntry: typeof prisma.creditLedgerEntry } = prisma,
) {
  return client.creditLedgerEntry.findMany({
    where: { tenantId },
    orderBy: { occurredAt: "desc" },
    take: limit,
  });
}
