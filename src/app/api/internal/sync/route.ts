/** POST /api/internal/sync — run the usage sync now. See controllers/sync.controller.ts. */
export { postUsageSync as POST } from "@/controllers/sync.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
