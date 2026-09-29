/** POST /api/internal/payment-method — Chargebee's Manage Payment Sources page. See controllers/purchase.controller.ts. */
export { postPaymentMethod as POST } from "@/controllers/purchase.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
