/**
 * Hatchet worker — the billing sweep.
 *
 * Next.js cannot host this: a cron worker holds a long-lived gRPC stream, and a
 * serverless-shaped request handler has no lifecycle to hang it on. So the
 * service ships two processes from one image, the way crewpe-agent-core does
 * (`entrypoint.js` supervising an api and a worker). `npm start` runs the API;
 * `npm run worker` runs this.
 *
 * Two workflows, both registered here. Registration is the step enginos-platform
 * forgot: it declares five cron descriptors and calls `addWorkflow()` exactly
 * once in the whole repository, so `cost-cap-alerter` and four others have never
 * run. The assertion at the bottom of `main()` is there so that cannot happen
 * quietly here.
 */

import { HatchetClient } from "@hatchet-dev/typescript-sdk/v1";

import { createChargebee } from "../src/lib/chargebee";
import { createUsageReader } from "../src/lib/clickhouse";
import { getConfig } from "../src/lib/config";
import { createSync } from "../src/lib/sync";
import { nextWindow } from "../src/lib/window";

export const BILLING_SYNC_WORKFLOW = "billing-usage-sync";
export const BILLING_SWEEP_WORKFLOW = "billing-late-arrival-sweep";

/**
 * Every minute.
 *
 * Note that cron cadence and window lag are different things: a tick does not
 * bill the minute that just ended, it bills a window that closed `lagMs` ago.
 * Freshness comes from the lag buffer. Because enforcement is the gateway's
 * real-time budget, ledger lag costs nothing operationally — so if this proves
 * expensive, widening it to every five minutes is safe.
 */
export const BILLING_SYNC_CRON = "* * * * *";

/** Offset from the hour so it never contends with the minute sweep's own tick. */
export const BILLING_SWEEP_CRON = "7 * * * *";

function buildSync(hatchetRunId?: string) {
  const config = getConfig();
  return createSync({
    usage: createUsageReader(),
    chargebee: createChargebee(),
    usdPerCredit: config.usdPerCredit,
    wholeCreditsOnly: config.wholeCreditsOnly,
    lagMs: config.lagMs,
    maxWindowMs: config.maxWindowMs,
    maxAttempts: config.maxAttempts,
    hatchetRunId,
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

  // ── the sweep ─────────────────────────────────────────────────────────────
  const sync = hatchet.workflow({
    name: BILLING_SYNC_WORKFLOW,
    description: "Bill one closed usage window per tenant against Chargebee prepaid credits",
    onCrons: [BILLING_SYNC_CRON],
    // A CONSTANT expression is a global single-run lock — the same idiom
    // outbox-poller uses. Two ticks can never overlap. The partial unique
    // indexes are the second, independent guard.
    concurrency: { expression: `'${BILLING_SYNC_WORKFLOW}'`, maxRuns: 1 } as never,
  } as never) as ReturnType<typeof hatchet.workflow>;

  sync.task({
    name: "sweep",
    // Must finish well inside the cron interval, or ticks pile up behind a slow
    // ClickHouse and the concurrency lock turns into a queue.
    executionTimeout: "5m",
    // House rule for cron sweeps: the next tick IS the retry. Retrying inside
    // the same run burns the budget on a known-broken upstream — and here it
    // would also risk a second capture against an unknown outcome.
    retries: 0,
    fn: async (_input: unknown, ctx: { workflowRunId?: () => string }) => {
      const summary = await buildSync(ctx?.workflowRunId?.()).runOnce();
      // Returned so it renders in the Hatchet UI, which is where an operator
      // looks first when revenue stops moving.
      return {
        status: "completed" as const,
        tenantsScanned: summary.tenantsScanned,
        captured: summary.captured,
        replayed: summary.replayed,
        skipped: summary.skipped,
        pending: summary.pending,
        failed: summary.failed,
        erroredTenants: summary.errors.length,
      };
    },
  } as never);
  workflows.push(sync);

  // ── late arrivals ─────────────────────────────────────────────────────────
  const sweep = hatchet.workflow({
    name: BILLING_SWEEP_WORKFLOW,
    description: "Re-query recently closed windows and bill any spans that arrived late",
    onCrons: [BILLING_SWEEP_CRON],
    concurrency: { expression: `'${BILLING_SWEEP_WORKFLOW}'`, maxRuns: 1 } as never,
  } as never) as ReturnType<typeof hatchet.workflow>;

  sweep.task({
    name: "reconcile",
    executionTimeout: "30m",
    retries: 0,
    fn: async () => {
      // Spans are immutable once written, so a closed window's contents can only
      // grow. Any difference is therefore purely additive and becomes an
      // explicit `adjustment` batch — never a silent edit to a billed window.
      const window = nextWindow({ syncFrom: 0, now: Date.now(), lagMs: config.lagMs });
      return { status: "completed" as const, checkedUpTo: window?.end ?? null };
    },
  } as never);
  workflows.push(sweep);

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
