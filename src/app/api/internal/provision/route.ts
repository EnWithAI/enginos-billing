/** POST /api/internal/provision — put an org on the free plan. See controllers/purchase.controller.ts. */
export { postProvision as POST } from "@/controllers/purchase.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
