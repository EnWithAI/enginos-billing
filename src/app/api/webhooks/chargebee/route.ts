/** POST /api/webhooks/chargebee — Chargebee event delivery. See controllers/webhook.controller.ts. */
export { postChargebeeWebhook as POST } from "@/controllers/webhook.controller";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
