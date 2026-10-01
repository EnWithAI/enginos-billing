/** POST /api/internal/billing-address/sync — keep the country of the address saved in Chargebee's editor; it decides the currency. See controllers/billing-address.controller.ts. */
export { postBillingAddressSync as POST } from "@/controllers/billing-address.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
