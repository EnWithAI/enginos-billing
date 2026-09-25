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
 *   billing-usage-sync        EVERY MINUTE — the usage path, and the whole of
 *                             it: read billing_account's cursor, take the next
 *                             window from ClickHouse, capture it in Chargebee,
 *                             move the cursor (usage-sync.service.ts).
 *   billing-subscription-reconcile
 *                             daily — re-read every subscription from Chargebee.
 *                             The webhook is the push path and it can be lost;
 *                             nothing else repairs a delivery that never landed.
 *
 * There is deliberately no late-arrival sweep, no backfill job and no retention
 * job. The cursor is on ClickHouse INGESTION time, so a span that lands late
 * lands in front of the cursor and is read by the next tick like any other; and
 * there are no idempotency keys to prune because there is no table of them —
 * the window's GROUP BY on TraceId:SpanId does that work now.
 *
 * The daily sweep is REPAIR, not progress: idempotent, safe to run repeatedly,
 * and not on the path of a normal tick — it exists because the happy path can be
 * missed, not because it usually is.
 *
 * Registration is the step enginos-platform forgot: it declares five cron
 * descriptors and calls `addWorkflow()` exactly once, so four have never run.
 * The assertion at the bottom of `main()` is there so that cannot happen here.
 */

import { ConcurrencyLimitStrategy, HatchetClient } from "@hatchet-dev/typescript-sdk/v1";

import { getConfig } from "../src/config/config";
import { createServices } from "../src/container";
import { errorMessage } from "../src/shared/errors";
import { renderSweep } from "../src/views/sweep.view";

export const BILLING_SYNC_WORKFLOW = "billing-usage-sync";
export const BILLING_SUBSCRIPTION_RECONCILE_WORKFLOW = "billing-subscription-reconcile";

/**
 * Every minute. Cadence is not freshness: a tick reads usage ingested up to
 * now − BILLING_LAG_MS. Enforcement is the gateway's real-time budget, so
 * Chargebee lagging a minute or two costs nothing operationally.
 */
export const BILLING_SYNC_CRON = "* * * * *";

/**
 * Daily, early, off the hour.
 *
 * Repairs a webhook that never arrived. A missed `subscription_renewed` leaves
 * the gateway enforcing the OLD term's cap: Chargebee has expired last term's
 * grant block and issued a new one, and until something re-reads them the
 * customer is capped on credits they no longer have — or, worse, on credits
 * they had before and have already spent. Nothing else in the system notices.
 */
export const BILLING_SUBSCRIPTION_RECONCILE_CRON = "11 2 * * *";

/**
 * How far into the sweep's 5-minute `executionTimeout` the gate check
 * (reopenBlockedActive) may still start another account. Leaves a minute for
 * the one in flight — two LiteLLM calls at 10s, and a Chargebee balance read.
 */
export const GATE_CHECK_DEADLINE_MS = 4 * 60_000;

async function main() {
  // Validate the configuration before registering anything: a bad value should
  // stop the worker at start, not surface as a failed tick a minute later.
  getConfig();

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
    description: "Bill each tenant's next ClickHouse usage window against its Chargebee prepaid credits, and move the cursor when it settles",
    onCrons: [BILLING_SYNC_CRON],
    // One run at a time. CANCEL_NEWEST, not the default CANCEL_IN_PROGRESS:
    // a tick still running when the next fires is mid-capture, and must finish
    // rather than be cancelled by it. Per-tenant correctness does not rest on
    // this — the window unique index, the compare-and-set cursor, the row
    // claim and the PROCESSING lease hold across replicas and beside the manual
    // sync route, and are what §29's "one active billing sync per tenant" means.
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
      const startedAt = Date.now();
      const services = createServices();
      // Accounts whose LiteLLM budget push failed are held `activating` with
      // their team blocked. Retried first, so one that lands is billed this tick.
      const activation = await services.accounts.activatePending();
      const summary = await services.usageSync(ctx?.workflowRunId?.()).runOnce();
      // Then any account marked active whose team a racing block closed. AFTER
      // the billing, not before it: it is one LiteLLM read per active account,
      // and a hung LiteLLM (10s a call) ahead of the sync would have spent the
      // whole timeout before a single capture was sent. Bounded, too, so it
      // cannot run the task into its timeout; what it does not reach this
      // minute it reaches the next.
      const gates = await services.accounts.reopenBlockedActive({ deadline: startedAt + GATE_CHECK_DEADLINE_MS });
      return renderSweep(activation, summary, gates);
    },
  } as never);
  workflows.push(sync);

  // ── subscription repair ───────────────────────────────────────────────────
  const subscriptionReconcile = hatchet.workflow({
    name: BILLING_SUBSCRIPTION_RECONCILE_WORKFLOW,
    description: "Re-read every subscription from Chargebee, repairing state a lost webhook left stale",
    onCrons: [BILLING_SUBSCRIPTION_RECONCILE_CRON],
  } as never) as ReturnType<typeof hatchet.workflow>;

  subscriptionReconcile.task({
    name: "resync",
    executionTimeout: "15m",
    retries: 0,
    fn: async () => {
      const { scanned, repaired, errors } = await createServices().accounts.resyncAll();
      return { status: "completed" as const, scanned, repaired, errors: errors.length };
    },
  } as never);
  workflows.push(subscriptionReconcile);

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
  console.error({ metric: "billing.worker.crash", err: errorMessage(err) }, "Billing worker failed to start");
  process.exit(1);
});
