/** POST /api/internal/topup — a top-up checkout, or `apply: true` to grant paid packs. See controllers/purchase.controller.ts. */
export { postTopUp as POST } from "@/controllers/purchase.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
