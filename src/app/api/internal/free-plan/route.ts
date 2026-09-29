/** POST /api/internal/free-plan — turn the free plan on or off for one org. Operators only; see controllers/purchase.controller.ts. */
export { postFreePlan as POST } from "@/controllers/purchase.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
