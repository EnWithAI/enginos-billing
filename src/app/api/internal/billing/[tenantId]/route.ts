/** GET /api/internal/billing/:tenantId — the billing page payload. See controllers/billing.controller.ts. */
export { getBillingOverview as GET } from "@/controllers/billing.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
