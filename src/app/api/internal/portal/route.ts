/** POST /api/internal/portal — a Chargebee self-serve portal session. See controllers/purchase.controller.ts. */
export { postPortal as POST } from "@/controllers/purchase.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
