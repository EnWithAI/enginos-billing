/**
 * Prisma client for the master database.
 *
 * A module-level singleton, because Next.js hot-reload otherwise opens a new
 * pool on every edit until Postgres refuses connections. Behind PgBouncer in
 * transaction-pooling mode the runtime URL must carry
 * `?pgbouncer=true&connection_limit=1`; migrations use the direct URL.
 */

import { PrismaClient } from "../../node_modules/.prisma/billing/index";

const globalForPrisma = globalThis as unknown as { billingPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.billingPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.billingPrisma = prisma;

export type { PrismaClient };

/** Account states. `exhausted` is display-only — the gateway is the real gate. */
export const ACCOUNT = {
  UNLINKED: "unlinked",
  ACTIVE: "active",
  CANCELLED: "cancelled",
  EXHAUSTED: "exhausted",
} as const;

export const BATCH = {
  PENDING: "pending",
  CAPTURED: "captured",
  FAILED: "failed",
  SKIPPED: "skipped",
} as const;

export const KIND = { WINDOW: "window", ADJUSTMENT: "adjustment" } as const;

export const ENTRY = {
  GRANT: "grant",
  CONSUME: "consume",
  ADJUSTMENT: "adjustment",
  EXPIRY: "expiry",
} as const;

/** Postgres 23505 — the signal that a guard index did its job. */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "P2002" || code === "23505";
}
