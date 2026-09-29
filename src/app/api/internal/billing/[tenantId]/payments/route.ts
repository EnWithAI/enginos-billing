/** GET /api/internal/billing/:tenantId/payments?offset= — a later page of payments. See controllers/billing.controller.ts. */
export { getPayments as GET } from "@/controllers/billing.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
