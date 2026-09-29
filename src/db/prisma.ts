/**
 * Prisma client for the master database.
 *
 * A module-level singleton, because Next.js hot-reload otherwise opens a new
 * pool on every edit until Postgres refuses connections. Behind PgBouncer in
 * transaction-pooling mode the runtime URL must carry
 * `?pgbouncer=true&connection_limit=1`; migrations use the direct URL.
 */

import { PrismaClient } from "../../node_modules/.prisma/billing/index";

/** A database call that threw: which model, which operation, and the error. */
export interface QueryFailure {
  model?: string;
  operation: string;
  err: unknown;
}

const failureListeners = new Set<(failure: QueryFailure) => void>();

/**
 * Hear about every database call that throws, wherever it is then caught.
 *
 * The usage sync catches a failed tenant and carries on with the next, so a
 * write that failed there never reaches the task — this is how the worker
 * still sees it (worker/alerts.ts). The API registers nothing. Returns the
 * unsubscribe.
 */
export function onQueryFailure(listener: (failure: QueryFailure) => void): () => void {
  failureListeners.add(listener);
  return () => void failureListeners.delete(listener);
}

/** Tells the listeners about any call that throws, then rethrows it unchanged. */
export function reportingFailures(client: PrismaClient): PrismaClient {
  // The extended client has the same model API under a different type name.
  return client.$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        try {
          return await query(args);
        } catch (err) {
          for (const listener of failureListeners) {
            try {
              listener({ model, operation, err });
            } catch {
              // A listener must never change what the caller sees.
            }
          }
          throw err;
        }
      },
    },
  }) as unknown as PrismaClient;
}

const globalForPrisma = globalThis as unknown as { billingPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.billingPrisma ??
  reportingFailures(
    new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    }),
  );

if (process.env.NODE_ENV !== "production") globalForPrisma.billingPrisma = prisma;

export type { PrismaClient };

const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
  "$executeRaw",
  "$executeRawUnsafe",
]);

/** Does this Prisma operation write? */
export function isWriteOperation(operation: string): boolean {
  return WRITE_OPERATIONS.has(operation);
}

/** Postgres 23505 — the signal that a guard index did its job. */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "P2002" || code === "23505";
}

/**
 * Prisma codes for "the database did not answer": can't reach it, timed out
 * connecting, an operation timed out, the server closed the connection, and
 * the pool ran out waiting for one.
 */
const UNREACHABLE_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);

/**
 * Is this the database being down, rather than a query being wrong?
 *
 * MEASURED 2026-09-25 with nothing listening, and again through PgBouncer with
 * its Postgres gone: both throw PrismaClientInitializationError "Can't reach
 * database server" with NO code at all — so the class name is checked as well.
 * Any initialization failure counts: whatever the cause, there is no database.
 */
export function isDatabaseUnreachable(err: unknown): boolean {
  const e = err as { name?: string; code?: string; errorCode?: string } | null;
  if (e?.name === "PrismaClientInitializationError") return true;
  return UNREACHABLE_CODES.has(e?.code ?? "") || UNREACHABLE_CODES.has(e?.errorCode ?? "");
}
