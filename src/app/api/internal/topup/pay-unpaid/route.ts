/** POST /api/internal/topup/pay-unpaid — charge the card for top-ups it declined. See controllers/purchase.controller.ts. */
export { postPayUnpaidTopUps as POST } from "@/controllers/purchase.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
