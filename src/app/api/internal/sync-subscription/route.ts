/** POST /api/internal/sync-subscription — re-read one tenant's subscription from Chargebee. See controllers/sync.controller.ts. */
export { postSyncSubscription as POST } from "@/controllers/sync.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
