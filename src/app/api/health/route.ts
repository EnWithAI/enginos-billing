/**
 * Liveness and readiness.
 *
 * `livez` answers "is the process up" and must not touch a dependency — a
 * container health check that fails on a slow database restarts a healthy
 * process. `readyz` answers "can this instance do its job" and checks the one
 * dependency every request needs.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const ready = new URL(request.url).searchParams.has("ready");
  if (!ready) return NextResponse.json({ status: "ok" });

  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", database: "ok" });
  } catch (err) {
    return NextResponse.json(
      { status: "degraded", database: (err as Error).message },
      { status: 503 },
    );
  }
}
