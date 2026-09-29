/**
 * The Chargebee webhook receiver.
 *
 * Chargebee does not call this directly. It delivers to enginos-platform, which
 * checks the HTTP Basic credentials set on the endpoint — Chargebee does NOT
 * sign webhooks, so those are its only authentication — and forwards the body
 * here verbatim. Nothing in this service checks the caller, so this route must
 * never be reachable from the internet.
 *
 * A failed handler answers 500, not 200, and the platform hands that status to
 * Chargebee unchanged. Nothing here remembers the event, so handing the failure
 * back is the only thing that keeps it from vanishing: Chargebee retries a
 * non-2xx and surfaces a permanently failing webhook in its own delivery log.
 * What each event does is webhook.service.ts.
 */

import { NextResponse } from "next/server";

import { createServices } from "../container";
import { readJson } from "../http/request";
import { route } from "../http/route";
import type { ChargebeeEvent } from "../services/webhook.service";
import { invalid } from "../shared/errors";

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
    const event = (await readJson(request)) as ChargebeeEvent;
    if (!event.id || !event.event_type) throw invalid("Malformed event");
    Object.assign(logContext, { eventId: event.id, eventType: event.event_type });

    await createServices().webhooks.handle(event);
    return NextResponse.json({ received: true });
  },
);
