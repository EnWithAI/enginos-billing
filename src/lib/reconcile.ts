/**
 * Consistency checks across the three systems that must agree.
 *
 * Each of these caught a real divergence during end-to-end testing, which is
 * why they exist as code rather than as a runbook step:
 *
 *   - a batch marked `captured` with NO ledger entry (money recorded as billed
 *     that was never charged and never audited)
 *   - a ledger entry whose `chargebee_operation_id` belongs to a DIFFERENT
 *     batch — the signature of a false-positive idempotency check
 *   - a captured batch whose cursor target is AHEAD of the tenant's cursor —
 *     the capture and the cursor advance commit together, so this means they
 *     diverged, and the next read would charge that usage again
 *
 * None of these would surface as an error at the time. They are only visible by
 * comparing, which is the whole argument for running this on a schedule rather
 * than trusting that the happy path held.
 */

import { BATCH, prisma as defaultPrisma } from "./db";

export interface ReconcileProblem {
  kind: "batch-without-entry" | "entry-without-batch" | "operation-id-mismatch" | "cursor-behind-capture";
  detail: string;
  tenantId: string;
}

export interface ReconcileResult {
  tenantsChecked: number;
  problems: ReconcileProblem[];
}

/**
 * Compare local state for one tenant. Returns problems rather than throwing, so
 * one bad tenant does not hide the rest.
 *
 * Deliberately does NOT auto-correct. Money that disagrees needs a human to
 * decide which side is right — silently "fixing" it would destroy the evidence
 * of how it diverged.
 */
export async function reconcileTenant(
  tenantId: string,
  prisma: typeof defaultPrisma = defaultPrisma,
): Promise<ReconcileProblem[]> {
  const problems: ReconcileProblem[] = [];

  const [account, batches, entries, cursor] = await Promise.all([
    prisma.billingAccount.findUnique({ where: { tenantId } }),
    prisma.usageSyncBatch.findMany({ where: { tenantId } }),
    prisma.creditLedgerEntry.findMany({ where: { tenantId } }),
    prisma.billingCursor.findUnique({ where: { tenantId } }),
  ]);

  if (!account) return problems;

  const entryBySource = new Map(entries.map((e) => [e.sourceRef, e]));
  const batchIds = new Set(batches.map((b) => b.id));

  for (const batch of batches) {
    if (batch.status !== BATCH.CAPTURED) continue;

    const entry = entryBySource.get(batch.id);

    // A captured batch with no entry means the usage is marked billed (its
    // event keys are recorded, so it is never read again) while no audit row
    // exists. Silent revenue loss, or an untracked charge.
    if (!entry) {
      problems.push({
        kind: "batch-without-entry",
        tenantId,
        detail: `batch ${batch.id} (${batch.windowStart.toISOString()}) is captured but has no ledger entry`,
      });
      continue;
    }

    // The entry should carry the operation id of ITS OWN capture. Carrying
    // another batch's id is how a false-positive idempotency check shows up.
    if (
      entry.chargebeeOperationId &&
      entry.chargebeeOperationId !== batch.chargebeeOperationId
    ) {
      problems.push({
        kind: "operation-id-mismatch",
        tenantId,
        detail: `batch ${batch.id} records operation ${batch.chargebeeOperationId} but its ledger entry cites ${entry.chargebeeOperationId}`,
      });
    }
  }

  for (const entry of entries) {
    // Grants are keyed on a Chargebee event id, not a batch — only consumption
    // must trace back to one.
    if (entry.entryType !== "consume") continue;
    if (!batchIds.has(entry.sourceRef)) {
      problems.push({
        kind: "entry-without-batch",
        tenantId,
        detail: `ledger entry ${entry.id} cites batch ${entry.sourceRef}, which does not exist`,
      });
    }
  }

  if (cursor) {
    for (const batch of batches) {
      if (batch.status !== BATCH.CAPTURED || !batch.cursorToAt) continue;
      const ahead =
        batch.cursorToAt > cursor.lastProcessedAt ||
        (batch.cursorToAt.getTime() === cursor.lastProcessedAt.getTime() &&
          (batch.cursorToEventId ?? "") > cursor.lastEventId);
      if (ahead) {
        problems.push({
          kind: "cursor-behind-capture",
          tenantId,
          detail: `batch ${batch.id} captured usage to ${batch.cursorToAt.toISOString()} but the cursor is at ${cursor.lastProcessedAt.toISOString()}`,
        });
      }
    }
  }

  return problems;
}

/** Sweep every account. Intended for a scheduled workflow. */
export async function reconcileAll(prisma: typeof defaultPrisma = defaultPrisma): Promise<ReconcileResult> {
  const accounts = await prisma.billingAccount.findMany();
  const problems: ReconcileProblem[] = [];

  for (const account of accounts) {
    problems.push(...(await reconcileTenant(account.tenantId, prisma)));
  }

  return { tenantsChecked: accounts.length, problems };
}
