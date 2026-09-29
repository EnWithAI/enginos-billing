/**
 * The worker's Sentry alerts (worker/alerts.ts): four, and nothing else.
 *
 * The Postgres two are pinned against Prisma's own error classes, and the hook
 * that feeds them against a real Prisma client.
 *
 * The Chargebee two are driven through the REAL usage sync over the REAL
 * Chargebee client (matrixRig), so each fault is a real HTTP shape that passes
 * through classify() and metricFor() before it becomes an alert — the mapping
 * is pinned against what the sync actually logs, not against a guess at it.
 */

import * as Sentry from "@sentry/node";
import {
  PrismaClientInitializationError,
  PrismaClientKnownRequestError,
  PrismaClientUnknownRequestError,
} from "@prisma/client/runtime/library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { onQueryFailure, reportingFailures, type QueryFailure } from "@/db/prisma";
import { PrismaClient } from "../node_modules/.prisma/billing/index";
import { ALERT, alertOnQueryFailure, alertingLogger, initAlerts } from "../worker/alerts";

import { F, matrixRig, type Fault } from "./failure-matrix-chargebee-and-amounts.helpers";
import { SLUG, T0, TENANT } from "./harness";

vi.mock("@sentry/node", () => ({ init: vi.fn(), captureMessage: vi.fn() }));

const captured = () => vi.mocked(Sentry.captureMessage).mock.calls;

beforeEach(() => {
  vi.mocked(Sentry.captureMessage).mockClear();
});

/** One tenant, one billable window, Chargebee answering with `fault`. */
async function tickWith(fault: Fault, overrides: Record<string, unknown> = {}) {
  const r = matrixRig();
  const base = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  r.usage.add("t1:s1", T0 + 30_000, 0.002);
  r.cb.outage = fault;
  r.at(2);
  await r.build({ logger: alertingLogger(base), ...overrides }).runTenant(SLUG);
  return base;
}

describe("Chargebee alerts, from the usage sync's own error lines", () => {
  it.each([
    { label: "403 site disabled", fault: F.s403, metric: "billing.sync.site_disabled", alert: ALERT.chargebeeDown },
    { label: "401 bad key", fault: F.s401, metric: "billing.sync.unauthenticated", alert: ALERT.chargebeeDown },
    { label: "500, retried and still failing", fault: F.s500, metric: "billing.sync.unknown_outcome", alert: ALERT.chargebeeDown },
    { label: "a request that never answers", fault: F.hang, metric: "billing.sync.unknown_outcome", alert: ALERT.chargebeeDown },
    { label: "400 param_wrong_value", fault: F.paramWrongValue, metric: "billing.sync.invalid", alert: ALERT.chargebeeUpdateFailed },
  ])("$label raises $alert.key", async ({ fault, metric, alert }) => {
    const base = await tickWith(fault());

    expect(captured()).toEqual([
      [
        alert.title,
        expect.objectContaining({
          level: "error",
          fingerprint: ["billing-worker", alert.key],
          tags: { alert: alert.key, metric, tenant: SLUG },
        }),
      ],
    ]);
    // Still logged exactly as before.
    expect(base.error).toHaveBeenCalledWith(expect.objectContaining({ metric }), expect.any(String));
  });

  it("an unknown outcome that has run out of attempts is still Chargebee down", async () => {
    await tickWith(F.s500(), { maxAttempts: 1 });
    expect(captured().map(([title]) => title)).toEqual([ALERT.chargebeeDown.title]);
    expect(captured()[0]![1]).toMatchObject({ tags: { metric: "billing.sync.stuck" } });
  });

  it("never raises for out of credits, however long it lasts — nor lets it relabel the next timeout", async () => {
    const r = matrixRig({ balance: "0" });
    const sync = r.build({ logger: alertingLogger({}) });
    r.usage.add("t1:s1", T0 + 30_000, 0.002);

    // About seven hours exhausted: the tenant is held, so Chargebee is never
    // asked and the row's attempts do not run up.
    for (let m = 2; m <= 440; m += 1) {
      r.at(m);
      await sync.runTenant(SLUG);
    }
    expect(r.prisma._log[0]!.attemptCount).toBe(1);
    expect(captured()).toEqual([]);

    // Topped up — activate() takes the account out of `exhausted`, so the row
    // is due at once — and the retry times out: that is Chargebee not
    // answering, an unknown outcome on the row's second attempt.
    r.prisma._accounts.get(TENANT)!.status = "active";
    r.cb.outage = F.hang();
    r.at(441);
    await sync.runTenant(SLUG);
    expect(captured()).toEqual([
      [ALERT.chargebeeDown.title, expect.objectContaining({ tags: expect.objectContaining({ metric: "billing.sync.unknown_outcome" }) })],
    ]);
  });

  it.each([
    { label: "429 rate limiting — it backs off and heals", fault: F.s429 },
    { label: "out of credits — the customer's state, not a fault", fault: F.insufficient },
  ])("does not raise for $label", async ({ fault }) => {
    const base = await tickWith(fault());
    expect(captured()).toEqual([]);
    expect(base.warn.mock.calls.length + base.error.mock.calls.length).toBeGreaterThan(0);
  });

  it("does not raise for a window Chargebee accepted", async () => {
    await tickWith(null as never);
    expect(captured()).toEqual([]);
  });
});

describe("Postgres alerts, from the Prisma client", () => {
  const known = (code: string, message = code) => new PrismaClientKnownRequestError(message, { code, clientVersion: "6.19.3" });

  it("raises postgres-down when the database cannot be reached — on a read too, and the measured shape has no code", () => {
    const down = new PrismaClientInitializationError("Can't reach database server at `localhost:6432`", "6.19.3");
    alertOnQueryFailure({ model: "BillingAccount", operation: "findMany", err: down });
    alertOnQueryFailure({ model: "ChargebeeSync", operation: "updateMany", err: known("P1017", "Server has closed the connection.") });

    expect(captured()).toEqual([
      [ALERT.postgresDown.title, expect.objectContaining({ fingerprint: ["billing-worker", "postgres-down"], tags: { alert: "postgres-down", model: "BillingAccount", operation: "findMany" } })],
      [ALERT.postgresDown.title, expect.objectContaining({ tags: { alert: "postgres-down", model: "ChargebeeSync", operation: "updateMany" } })],
    ]);
  });

  it.each([
    { label: "a read-only failover", operation: "updateMany", err: new PrismaClientUnknownRequestError("cannot execute UPDATE in a read-only transaction", { clientVersion: "6.19.3" }) },
    { label: "a value the column cannot hold", operation: "create", err: known("P2020", "Value out of range for the type.") },
    { label: "an account row that is not there", operation: "update", err: known("P2025", "Record to update not found.") },
  ])("raises postgres-write-failed for $label", ({ operation, err }) => {
    alertOnQueryFailure({ model: "ChargebeeSync", operation, err });
    expect(captured()).toEqual([
      [
        ALERT.postgresWriteFailed.title,
        expect.objectContaining({
          fingerprint: ["billing-worker", "postgres-write-failed"],
          tags: { alert: "postgres-write-failed", model: "ChargebeeSync", operation },
        }),
      ],
    ]);
  });

  it("does not raise for the unique violation a guard index returns on purpose, or for a failed read", () => {
    alertOnQueryFailure({ model: "ChargebeeSync", operation: "create", err: known("P2002", "Unique constraint failed") });
    alertOnQueryFailure({ model: "BillingAccount", operation: "findMany", err: known("P2010", "Raw query failed") });
    expect(captured()).toEqual([]);
  });

  it("hears a real client's failed write however the caller handles it, and hands the caller the error unchanged", async () => {
    const heard: QueryFailure[] = [];
    const stop = onQueryFailure((f) => void heard.push(f));
    // Port 1: nothing listens, so the connect is refused at once.
    const client = reportingFailures(new PrismaClient({ datasourceUrl: "postgresql://u:p@127.0.0.1:1/x?connect_timeout=1" }));
    const thrown = await client.chargebeeSync.updateMany({ where: { id: "none" }, data: { attemptCount: 1 } }).catch((e: unknown) => e);
    stop();
    await client.$disconnect();

    expect((thrown as Error).name).toBe("PrismaClientInitializationError");
    expect(heard).toEqual([{ model: "ChargebeeSync", operation: "updateMany", err: thrown }]);
  });
});

describe("initAlerts", () => {
  it("lets through only the events raise() tagged — nothing else the SDK catches reaches Sentry", () => {
    initAlerts();
    const { beforeSend } = vi.mocked(Sentry.init).mock.calls[0]![0]!;
    const alert = { tags: { alert: "chargebee-down" } };

    expect(beforeSend!(alert as never, {})).toBe(alert);
    expect(beforeSend!({ exception: { values: [{ type: "TypeError" }] } } as never, {})).toBeNull();
  });
});
