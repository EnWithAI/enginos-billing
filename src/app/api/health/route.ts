/** GET /api/health — liveness, and readiness with `?ready`. See controllers/health.controller.ts. */
export { getHealth as GET } from "@/controllers/health.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
