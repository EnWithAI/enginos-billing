/**
 * Manual check of the worker's Sentry alerts (worker/alerts.ts): fires every
 * scenario for real, sends it to the Sentry project in .env, and says for each
 * whether the right alert — or, for the quiet ones, nothing — reached Sentry.
 *
 * What is real, and what stands in for it:
 *
 *   Sentry        real. Events are tagged environment=manual-check, so they
 *                 can be told apart from the worker's and resolved afterwards.
 *   Postgres      the local database. Unreachable = a dead port. Write refused =
 *                 a direct connection forced read-only, writing to a random id,
 *                 so no row could change even if the write went through.
 *   Chargebee     a bad key goes to the REAL Chargebee site, which answers 401
 *                 and does nothing else. The site cannot be made to send the
 *                 other answers, so those are its measured error bodies served
 *                 by the HTTP-level fake the failure-matrix tests use.
 *   Usage sync    the real service and real Chargebee client, over the test
 *                 harness's in-memory Postgres and ClickHouse — nothing is
 *                 billed and no billing row is written. The tenant is the
 *                 harness's `org_acme_com`.
 *
 *   npx tsx scripts/sentry-alerts-check.ts                      # every scenario
 *   npx tsx scripts/sentry-alerts-check.ts chargebee-403 out-of-credits
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as Sentry from "@sentry/node";

import { reportingFailures } from "../src/db/prisma";
import { createChargebee } from "../src/integrations/chargebee";
import { createChargebeeSyncRepository } from "../src/repositories/chargebee-sync.repository";
import { PrismaClient } from "../node_modules/.prisma/billing/index";
import { alertingLogger, initAlerts } from "../worker/alerts";
import { F, matrixRig, type Fault } from "../__tests__/failure-matrix-chargebee-and-amounts.helpers";
import { SLUG, T0 } from "../__tests__/harness";

// ── env ─────────────────────────────────────────────────────────────────────
function loadEnv(path: string) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}
loadEnv(resolve(__dirname, "../.env"));

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set in enginos-billing/.env`);
  return v;
};

// ── scenarios ───────────────────────────────────────────────────────────────

/** A Postgres client that reports failures to the alerts, like the worker's own. */
function postgres(url: string) {
  return reportingFailures(new PrismaClient({ datasourceUrl: url, log: [] }));
}

/** One tenant, one billable window, run through the real usage sync. Returns what the sync did. */
async function sync(opts: { fault?: Fault | null; balance?: string; chargebee?: unknown; maxAttempts?: number } = {}) {
  const r = matrixRig(opts.balance ? { balance: opts.balance } : {});
  const logged: string[] = [];
  const base = {
    warn: (o: unknown) => void logged.push((o as { metric?: string }).metric ?? "?"),
    error: (o: unknown) => void logged.push((o as { metric?: string }).metric ?? "?"),
  };
  r.usage.add("t1:s1", T0 + 30_000, 0.002);
  r.cb.outage = opts.fault ?? null;
  r.at(2);
  const result = await r
    .build({
      logger: alertingLogger(base),
      ...(opts.chargebee ? { chargebee: opts.chargebee } : {}),
      ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
    })
    .runTenant(SLUG);
  return `sync outcome ${result.outcome}${logged.length ? `, logged ${logged.join(", ")}` : ""}`;
}

interface Scenario {
  name: string;
  /** The alert key that must reach Sentry, or null for "nothing may". */
  expect: string | null;
  run(): Promise<string>;
}

const SCENARIOS: Scenario[] = [
  {
    name: "postgres-down",
    expect: "postgres-down",
    async run() {
      // Port 1: nothing listens, so the connect is refused at once.
      const client = postgres("postgresql://billing:x@127.0.0.1:1/billing?connect_timeout=2");
      const outcome = await createChargebeeSyncRepository(client).tenantIdsWithUnresolved().then(
        () => "read succeeded",
        (e: Error) => `read failed: ${e.name}`,
      );
      await client.$disconnect();
      return outcome;
    },
  },
  {
    name: "postgres-write-refused",
    expect: "postgres-write-failed",
    async run() {
      const direct = env("DATABASE_DIRECT_URL");
      const readOnly = `${direct}${direct.includes("?") ? "&" : "?"}options=-c%20default_transaction_read_only%3Don`;
      const client = postgres(readOnly);
      const outcome = await createChargebeeSyncRepository(client)
        .claim({ id: randomUUID(), status: "PENDING", attemptCount: 0 } as never)
        .then(
          () => "write accepted",
          (e: Error) => `write refused: ${String(e.message).match(/code: "(\w+)", message: "([^"]+)"/)?.slice(1).join(" ") ?? e.name}`,
        );
      await client.$disconnect();
      return outcome;
    },
  },
  {
    name: "chargebee-401-real",
    expect: "chargebee-down",
    run: () =>
      sync({
        chargebee: createChargebee({ site: env("CHARGEBEE_SITE"), apiKey: "sentry-alerts-check-not-a-key", maxAttempts: 1 }),
      }),
  },
  { name: "chargebee-403", expect: "chargebee-down", run: () => sync({ fault: F.s403() }) },
  { name: "chargebee-500", expect: "chargebee-down", run: () => sync({ fault: F.s500() }) },
  { name: "chargebee-timeout", expect: "chargebee-down", run: () => sync({ fault: F.hang() }) },
  { name: "chargebee-network", expect: "chargebee-down", run: () => sync({ fault: F.network() }) },
  { name: "chargebee-stuck", expect: "chargebee-down", run: () => sync({ fault: F.s500(), maxAttempts: 1 }) },
  { name: "chargebee-400", expect: "chargebee-update-failed", run: () => sync({ fault: F.paramWrongValue() }) },
  { name: "chargebee-404", expect: "chargebee-update-failed", run: () => sync({ fault: F.notFound() }) },
  { name: "out-of-credits", expect: null, run: () => sync({ balance: "0" }) },
  { name: "rate-limited", expect: null, run: () => sync({ fault: F.s429() }) },
  { name: "charge-accepted", expect: null, run: () => sync() },
  {
    name: "other-error",
    expect: null,
    async run() {
      Sentry.captureException(new Error("sentry-alerts-check: an error that is not one of the four"));
      return "captureException called";
    },
  },
];

// ── run ─────────────────────────────────────────────────────────────────────

async function main() {
  env("SENTRY_DSN");
  process.env.SENTRY_ENVIRONMENT = "manual-check";
  initAlerts();

  const sent: Array<{ alert?: string; metric?: string; eventId?: string; status?: number }> = [];
  Sentry.getClient()?.on("afterSendEvent", (event, res) =>
    sent.push({
      alert: event.tags?.alert as string | undefined,
      metric: event.tags?.metric as string | undefined,
      eventId: event.event_id,
      status: res.statusCode,
    }),
  );

  const only = process.argv.slice(2);
  const unknown = only.filter((n) => !SCENARIOS.some((s) => s.name === n));
  if (unknown.length) throw new Error(`No such scenario: ${unknown.join(", ")}. Known: ${SCENARIOS.map((s) => s.name).join(", ")}`);

  let failed = 0;
  for (const s of SCENARIOS.filter((s) => only.length === 0 || only.includes(s.name))) {
    const from = sent.length;
    const detail = await s.run();
    await Sentry.flush(15_000);
    const got = sent.slice(from);

    const ok = s.expect ? got.length > 0 && got.every((e) => e.alert === s.expect && e.status === 200) : got.length === 0;
    if (!ok) failed += 1;
    const what = got.length
      ? got.map((e) => `${e.alert}${e.metric ? ` (${e.metric})` : ""} → HTTP ${e.status}, event ${e.eventId}`).join("; ")
      : "nothing sent";
    console.log(`${ok ? "PASS" : "FAIL"}  ${s.name.padEnd(24)} expected ${s.expect ?? "nothing"}`);
    console.log(`      ${detail}`);
    console.log(`      Sentry: ${what}`);
  }

  console.log(failed ? `\n${failed} scenario(s) did not behave as expected.` : "\nEvery scenario behaved as expected.");
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
