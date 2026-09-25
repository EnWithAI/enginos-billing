/** GET /api/internal/billing/:tenantId/invoice/:invoiceId — an ownership-checked PDF link. See controllers/billing.controller.ts. */
export { getInvoiceDownload as GET } from "@/controllers/billing.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
