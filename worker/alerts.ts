/**
 * Sentry for the billing worker: four alerts, and nothing else.
 *
 *   postgres-down            the database could not be reached
 *   postgres-write-failed    the database is up, and refused a write
 *   chargebee-down           Chargebee is not answering, or will not serve us
 *   chargebee-update-failed  Chargebee refused a usage window
 *
 * A customer out of credits is never an alert: that is their state, not a
 * fault, and it clears on a top-up.
 *
 * Each is ONE Sentry issue however many tenants and ticks raise it (a fixed
 * fingerprint), so an outage is one alert rather than one per tenant per
 * minute. Everything else the SDK would send — an uncaught exception, any
 * other error — is dropped in beforeSend and stays in the logs, as before.
 *
 * The Postgres two come from the Prisma client itself (onQueryFailure), so a
 * write the sync catches and carries on past is still seen. The Chargebee two
 * are read off the usage sync's own error lines: metricFor() in
 * usage-sync.service.ts already names each failure by who has to act on it,
 * so this maps those names to alerts rather than deciding again what failed.
 *
 * With SENTRY_DSN unset nothing is sent and the worker runs as it did.
 */

import * as Sentry from "@sentry/node";

import { isDatabaseUnreachable, isUniqueViolation, isWriteOperation, onQueryFailure, type QueryFailure } from "../src/db/prisma";
import { errorMessage } from "../src/shared/errors";
import type { Logger } from "../src/shared/logger";

interface Alert {
  key: string;
  title: string;
}

export const ALERT = {
  postgresDown: { key: "postgres-down", title: "Billing worker cannot reach Postgres" },
  postgresWriteFailed: { key: "postgres-write-failed", title: "Billing worker could not write to Postgres" },
  chargebeeDown: { key: "chargebee-down", title: "Chargebee is down or refusing the billing worker" },
  chargebeeUpdateFailed: { key: "chargebee-update-failed", title: "Usage could not be written to Chargebee" },
} as const satisfies Record<string, Alert>;

/**
 * Which usage-sync error metric raises which alert.
 *
 * Left out on purpose: `out_of_credits` (see above), `rate_limited` backs off
 * and heals by itself, and `tenant_error` is any other failure — a database
 * one among them is raised from the client instead (alertOnQueryFailure).
 *
 * `stuck` is Chargebee-down, not a failed update: it is an unknown outcome
 * past BILLING_MAX_ATTEMPTS, and the attempt count is cumulative across
 * statuses. A window that sat out of credits for ten minutes is already past
 * it, so the first timeout after the top-up logs `stuck` — and as a failed
 * update that would be an alert raised by running out of credits.
 */
export const ALERT_FOR_METRIC: Readonly<Record<string, Alert>> = {
  "billing.sync.site_disabled": ALERT.chargebeeDown,
  "billing.sync.unauthenticated": ALERT.chargebeeDown,
  // A 5xx, a timeout or a dropped socket: Chargebee did not answer.
  "billing.sync.unknown_outcome": ALERT.chargebeeDown,
  "billing.sync.stuck": ALERT.chargebeeDown,
  "billing.sync.invalid": ALERT.chargebeeUpdateFailed,
  "billing.sync.no_ledger": ALERT.chargebeeUpdateFailed,
};

export function initAlerts() {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    // Only raise() tags an event with `alert`. No tracing is configured.
    beforeSend: (event) => (event.tags?.alert ? event : null),
  });
  onQueryFailure(alertOnQueryFailure);
}

function raise(alert: Alert, tags: Record<string, string | undefined>, details: Record<string, unknown>) {
  Sentry.captureMessage(alert.title, {
    level: "error",
    fingerprint: ["billing-worker", alert.key],
    tags: { alert: alert.key, ...tags },
    contexts: { details },
  });
}

/** Writes every line as `base` does, and raises the alert an error line names. */
export function alertingLogger(base: Logger = console): Logger {
  return {
    log: (obj, msg) => base.log?.(obj, msg),
    warn: (obj, msg) => base.warn?.(obj, msg),
    error: (obj, msg) => {
      base.error?.(obj, msg);
      const fields = (obj ?? {}) as Record<string, unknown>;
      const alert = ALERT_FOR_METRIC[String(fields.metric)];
      if (alert) {
        raise(alert, { metric: String(fields.metric), tenant: fields.tenantSlug as string | undefined }, { ...fields, message: msg });
      }
    },
  };
}

/**
 * A database call threw. Unreachable — on any call, read or write — is
 * postgres-down; any other failed write is postgres-write-failed: a read-only
 * failover, a full disk, a revoked grant, a value the column cannot hold.
 *
 * Not a unique violation: the guard indexes refuse a duplicate on purpose, and
 * the caller handles it. Nor a failed read on a reachable database, which is a
 * query defect rather than Postgres refusing to store anything.
 */
export function alertOnQueryFailure({ model, operation, err }: QueryFailure) {
  if (isUniqueViolation(err)) return;
  const tags = { model, operation };
  const details = { model, operation, code: (err as { code?: string })?.code, err: errorMessage(err) };
  if (isDatabaseUnreachable(err)) raise(ALERT.postgresDown, tags, details);
  else if (isWriteOperation(operation)) raise(ALERT.postgresWriteFailed, tags, details);
}
