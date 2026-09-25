/**
 * The usage-sync sweep's output, as the Hatchet UI shows it — where an
 * operator looks first when revenue stops moving.
 */

import type { UsageSyncService } from "../services/usage-sync.service";

type PassSummary = Awaited<ReturnType<UsageSyncService["runOnce"]>>;

export function renderSweep(
  activation: { pending: number; activated: number },
  summary: PassSummary,
  gates: { checked: number; reopened: number } = { checked: 0, reopened: 0 },
) {
  return {
    status: "completed" as const,
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
    locked: summary.locked,
    // Tenants whose tick ended on a write-off (a refused window on an ended
    // subscription, given up). Every write-off is also its own
    // `billing.sync.written_off` error, which is the count to alert on.
    writtenOff: summary.writtenOff,
    erroredTenants: summary.errors.length,
  };
}
