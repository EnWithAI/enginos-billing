/**
 * Liveness and readiness.
 *
 * `livez` answers "is the process up" and must not touch a dependency — a
 * container health check that fails on a slow database restarts a healthy
 * process. `readyz` (`?ready`) answers "can this instance do its job" and
 * checks the one dependency every request needs.
 */

import { NextResponse } from "next/server";

import { route } from "../http/route";
import { createPlatformRepository } from "../repositories/platform.repository";
import { errorMessage } from "../shared/errors";

export const getHealth = route(
  {
    fallback: {
      status: 503,
      body: { status: "degraded" },
      metric: "billing.health.failed",
      message: "Health check failed",
    },
  },
  async (request) => {
    const ready = new URL(request.url).searchParams.has("ready");
    if (!ready) return NextResponse.json({ status: "ok" });

    // An unreachable database is the answer to the question, not a failure of
    // this handler — so it is reported here rather than thrown.
    try {
      await createPlatformRepository().ping();
      return NextResponse.json({ status: "ok", database: "ok" });
    } catch (err) {
      return NextResponse.json({ status: "degraded", database: errorMessage(err) }, { status: 503 });
    }
  },
);
