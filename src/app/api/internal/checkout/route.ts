/** POST /api/internal/checkout — a hosted subscription checkout. See controllers/purchase.controller.ts. */
export { postCheckout as POST } from "@/controllers/purchase.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
