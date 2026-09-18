/**
 * Hatchet worker — usage billing.
 *
 * Next.js cannot host this: a cron worker holds a long-lived gRPC stream, and a
 * serverless-shaped request handler has no lifecycle to hang it on. So the
 * service ships two processes from one image, the way crewpe-agent-core does
 * (`entrypoint.js` supervising an api and a worker). `npm start` runs the API;
 * `npm run worker` runs this.
 *
 * Two workflows:
 *
 *   billing-usage-sync        every minute — THE usage path: poll ClickHouse from
 *                             billing_cursor, capture in Chargebee, record in the
 *                             ledger, advance the cursor (usage-sync.ts).
 *   billing-event-retention   hourly — prune usage-event idempotency keys.
 *
 * There is deliberately no late-arrival sweep and no window job: the cursor is
 * on ClickHouse ingestion time, so usage that lands late is simply read on the
 * next tick.
 *
 * Registration is the step enginos-platform forgot: it declares five cron
 * descriptors and calls `addWorkflow()` exactly once, so four have never run.
 * The assertion at the bottom of `main()` is there so that cannot happen here.
 */

import { ConcurrencyLimitStrategy, HatchetClient } from "@hatchet-dev/typescript-sdk/v1";

import { createAccounts } from "../src/lib/account";
import { createChargebee } from "../src/lib/chargebee";
import { getConfig } from "../src/lib/config";
import { gatewayBudgetHooks } from "../src/lib/gateway";
import { pruneBilledEventKeys } from "../src/lib/retention";
import { createUsageSource } from "../src/lib/usage-events";
import { createUsageSync } from "../src/lib/usage-sync";

export const BILLING_SYNC_WORKFLOW = "billing-usage-sync";
export const BILLING_RETENTION_WORKFLOW = "billing-event-retention";

/**
 * Every minute. Cadence is not freshness: a tick reads usage ingested up to
 * now − BILLING_LAG_MS. Enforcement is the gateway's real-time budget, so the
 * ledger lagging a minute or two costs nothing operationally.
 */
export const BILLING_SYNC_CRON = "* * * * *";

/** Hourly, off the top of the hour. A missed run just prunes more next time. */
export const BILLING_RETENTION_CRON = "37 * * * *";

function buildSync(hatchetRunId?: string) {
  const config = getConfig();
  return createUsageSync({
    usage: createUsageSource(),
    chargebee: createChargebee(),
    usdPerCredit: config.usdPerCredit,
    wholeCreditsOnly: config.wholeCreditsOnly,
    lagMs: config.lagMs,
    maxEventsPerCapture: config.maxEventsPerCapture,
    maxAttempts: config.maxAttempts,
    eventKeyRetentionMs: config.eventKeyRetentionMs,
    hatchetRunId,
    blockBudget: gatewayBudgetHooks().blockBudget,
  });
}

async function main() {
  const config = getConfig();

  const hatchet = new HatchetClient({
    token: process.env.HATCHET_CLIENT_TOKEN!,
    ...(process.env.HATCHET_CLIENT_HOST_PORT
      ? { host_port: process.env.HATCHET_CLIENT_HOST_PORT }
      : {}),
    tls_config: {
      // The local engine serves plaintext gRPC; the SDK default breaks the
      // handshake with an error that does not mention TLS.
      tls_strategy: (process.env.HATCHET_CLIENT_TLS_STRATEGY as "none" | "tls" | "mtls") ?? "none",
    },
  } as never);

  const workflows: unknown[] = [];

  // ── usage sync ────────────────────────────────────────────────────────────
  const sync = hatchet.workflow({
    name: BILLING_SYNC_WORKFLOW,
    description: "Poll ClickHouse usage from each tenant's billing cursor and capture it against Chargebee prepaid credits",
    onCrons: [BILLING_SYNC_CRON],
    // One run at a time. CANCEL_NEWEST, not the default CANCEL_IN_PROGRESS:
    // a tick still running when the next fires is mid-capture, and must finish
    // rather than be cancelled by it. Per-tenant correctness does not rest on
    // this — the cursor lease and the idempotency keys hold across replicas.
    concurrency: {
      expression: `'${BILLING_SYNC_WORKFLOW}'`,
      maxRuns: 1,
      limitStrategy: ConcurrencyLimitStrategy.CANCEL_NEWEST,
    },
  } as never) as ReturnType<typeof hatchet.workflow>;

  sync.task({
    name: "sweep",
    executionTimeout: "5m",
    // House rule for cron sweeps: the next tick IS the retry — the cursor did
    // not move, so it reads the same usage again.
    retries: 0,
    fn: async (_input: unknown, ctx: { workflowRunId?: () => string }) => {
      // Accounts whose LiteLLM budget push failed are held `activating` with
      // their team blocked. Retried first, so one that lands is billed this tick.
      const activation = await createAccounts({
        chargebee: createChargebee(),
        usdPerCredit: config.usdPerCredit,
        ...gatewayBudgetHooks(),
      }).activatePending();

      const summary = await buildSync(ctx?.workflowRunId?.()).runOnce();
      // Returned so it renders in the Hatchet UI, which is where an operator
      // looks first when revenue stops moving.
      return {
        status: "completed" as const,
        activating: activation.pending,
        activated: activation.activated,
        tenantsScanned: summary.tenantsScanned,
        captured: summary.captured,
        replayed: summary.replayed,
        idle: summary.idle,
        pending: summary.pending,
        failed: summary.failed,
        held: summary.held,
        locked: summary.locked,
        erroredTenants: summary.errors.length,
      };
    },
  } as never);
  workflows.push(sync);

  // ── idempotency-key retention ─────────────────────────────────────────────
  const retention = hatchet.workflow({
    name: BILLING_RETENTION_WORKFLOW,
    description: "Prune usage-event idempotency keys whose spans the sync can no longer read",
    onCrons: [BILLING_RETENTION_CRON],
  } as never) as ReturnType<typeof hatchet.workflow>;

  retention.task({
    name: "prune",
    executionTimeout: "10m",
    retries: 0,
    fn: async () => {
      const { deleted } = await pruneBilledEventKeys({ retentionMs: config.eventKeyRetentionMs });
      return { status: "completed" as const, deleted, retentionMs: config.eventKeyRetentionMs };
    },
  } as never);
  workflows.push(retention);

  // The failure mode this guards against is silent: a declared cron that was
  // never registered simply does not exist in Hatchet, and nothing complains.
  if (workflows.length === 0) throw new Error("No workflows registered — the cron would silently not exist");

  const worker = await hatchet.worker("enginos-billing", {
    workflows,
    slots: Number(process.env.HATCHET_WORKER_SLOTS ?? 5),
  } as never);

  console.log(
    { metric: "billing.worker.start", workflows: workflows.length, cron: BILLING_SYNC_CRON },
    "Billing worker starting",
  );

  await worker.start();
}

main().catch((err) => {
  console.error({ metric: "billing.worker.crash", err: err?.message }, "Billing worker failed to start");
  process.exit(1);
});
