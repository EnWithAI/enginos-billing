/**
 * The usage-sync sweep's output, as the Hatchet UI shows it — where an
 * operator looks first when revenue stops moving.
 */

import type { UsageSyncService } from "../services/usage-sync.service";

type PassSummary = Awaited<ReturnType<UsageSyncService["runOnce"]>>;

/**
 * Several passes of one run, as one summary: counts added up, the orgs scanned
 * as the most any pass saw, every error and result kept.
 */
export function mergePasses(passes: PassSummary[]): PassSummary {
  const [first, ...rest] = passes;
  if (!first) throw new Error("mergePasses needs at least one pass");
  return rest.reduce<PassSummary>(
    (all, pass) => ({
      tenantsScanned: Math.max(all.tenantsScanned, pass.tenantsScanned),
      synced: all.synced + pass.synced,
      replayed: all.replayed + pass.replayed,
      idle: all.idle + pass.idle,
      unknown: all.unknown + pass.unknown,
      rateLimited: all.rateLimited + pass.rateLimited,
      outOfCredits: all.outOfCredits + pass.outOfCredits,
      invalid: all.invalid + pass.invalid,
      holding: all.holding + pass.holding,
      exhausted: all.exhausted + pass.exhausted,
      locked: all.locked + pass.locked,
      writtenOff: all.writtenOff + pass.writtenOff,
      errors: [...all.errors, ...pass.errors],
      results: [...all.results, ...pass.results],
    }),
    first,
  );
}

export function renderSweep(
  activation: { pending: number; activated: number },
  summary: PassSummary,
  gates: { checked: number; reopened: number } = { checked: 0, reopened: 0 },
  passes = 1,
) {
  return {
    status: "completed" as const,
    // Usage-sync passes in this run — several when BILLING_SWEEP_INTERVAL_MS is under a minute.
    passes,
    activating: activation.pending,
    activated: activation.activated,
    // Active accounts found with a blocked team and re-opened. Should be 0.
    reopened: gates.reopened,
    tenantsScanned: summary.tenantsScanned,
    synced: summary.synced,
    replayed: summary.replayed,
    idle: summary.idle,
    unknown: summary.unknown,
    rateLimited: summary.rateLimited,
    outOfCredits: summary.outOfCredits,
    invalid: summary.invalid,
    holding: summary.holding,
    // Out of credits: team blocked, no Chargebee calls, until a top-up.
    exhausted: summary.exhausted,
    locked: summary.locked,
    // Tenants whose tick ended on a write-off (a refused window on an ended
    // subscription, given up). Every write-off is also its own
    // `billing.sync.written_off` error, which is the count to alert on.
    writtenOff: summary.writtenOff,
    erroredTenants: summary.errors.length,
  };
}
