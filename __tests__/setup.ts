/**
 * Every test runs WITHOUT the developer's .env.
 *
 * The generated Prisma client loads the project's .env into process.env
 * (`relativeEnvPaths.schemaEnvPath`) twice over: when its module is first
 * loaded (`warnEnvConflicts`), and again whenever a PrismaClient is
 * constructed — which db/prisma.ts does the first time it is imported, as
 * nearly every test does through a repository. So whatever a developer's .env
 * said configured every test that set nothing itself: MEASURED 2026-10-01, a
 * local `FREE_PLAN_CREDITS=0` (which the config refuses) failed every
 * webhook-route test, on that machine only. The suite is written for an empty
 * environment (config-*.test.ts set exactly what they test).
 *
 * So, before any test file runs:
 *   1. the generated module is loaded once — `require` caches it for the
 *      process, so it never loads .env again — and every variable that load
 *      ADDED is removed: the environment is what the process started with;
 *   2. the shared client is replaced by one that refuses to be used, on the
 *      globalThis slot db/prisma.ts reuses (its hot-reload guard), so no
 *      PrismaClient is ever constructed. No test talks to a database — each
 *      hands its services a fake (harness.ts makeFakePrisma).
 */

import { createRequire } from "node:module";

const started = new Set(Object.keys(process.env));
createRequire(import.meta.url)("../node_modules/.prisma/billing/index.js");
for (const key of Object.keys(process.env)) {
  if (!started.has(key)) delete process.env[key];
}

const refuse = new Proxy(
  {},
  {
    get(_target, key) {
      // Not a thenable, and inert to inspection: only a real use is refused.
      if (typeof key === "symbol" || key === "then" || key === "toJSON") return undefined;
      throw new Error(`A test reached the real Prisma client (prisma.${String(key)}): hand the service makeFakePrisma() instead`);
    },
  },
);

(globalThis as { billingPrisma?: unknown }).billingPrisma = refuse;
