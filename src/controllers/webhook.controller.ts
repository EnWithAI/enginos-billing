/**
 * The Chargebee webhook receiver — the one route in this service that
 * authenticates its caller.
 *
 * Chargebee delivers here DIRECTLY: the load balancer (Caddy locally) sends
 * this one path, POST only, to billing, and nothing else of billing is public.
 * This route checks the HTTP Basic credentials set on the endpoint before
 * anything else — Chargebee does NOT sign webhooks, so those are its only
 * authentication (http/webhook-auth.ts). Every other route trusts its caller
 * and stays on the private network.
 *
 * A failed handler answers 500, not 200, and Chargebee sees that status.
 * Nothing here remembers the event, so handing the failure back is the only
 * thing that keeps it from vanishing: Chargebee retries a non-2xx and surfaces
 * a permanently failing webhook in its own delivery log.
 * What each event does is webhook.service.ts.
 */

import { NextResponse } from "next/server";

import { getConfig } from "../config/config";
import { createServices } from "../container";
import { readJson } from "../http/request";
import { route } from "../http/route";
import { checkWebhookAuth } from "../http/webhook-auth";
import type { ChargebeeEvent } from "../services/webhook.service";
import { invalid } from "../shared/errors";

const REJECTED = { error: "Invalid webhook credentials", code: "webhook-unauthorized" };

export const postChargebeeWebhook = route(
  {
    fallback: {
      status: 500,
      body: { received: false, handled: false },
      metric: "billing.webhook.failed",
      message: "Chargebee webhook handler failed; returning 500 so Chargebee retries and records it",
    },
  },
  async (request, { logContext }) => {
    const auth = checkWebhookAuth(request.headers.get("authorization"), getConfig().chargebeeWebhook);
    if (auth !== "ok") {
      if (auth === "unset") {
        console.error(
          { metric: "billing.webhook.credentials_unset" },
          "CHARGEBEE_WEBHOOK_USER / CHARGEBEE_WEBHOOK_PASSWORD not set; refusing Chargebee webhook",
        );
      } else {
        console.warn(
          { metric: "billing.webhook.unauthorized", hadHeader: request.headers.has("authorization") },
          "Chargebee webhook rejected: bad or missing HTTP Basic credentials",
        );
      }
      return NextResponse.json(REJECTED, { status: 401 });
    }

    const event = (await readJson(request)) as ChargebeeEvent;
    if (!event.id || !event.event_type) throw invalid("Malformed event");
    Object.assign(logContext, { eventId: event.id, eventType: event.event_type });

    await createServices().webhooks.handle(event);
    return NextResponse.json({ received: true });
  },
);
