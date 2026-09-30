/**
 * The one wrapper every route handler goes through.
 *
 * It owns the two things each route used to repeat, and occasionally forget:
 *
 *   1. EXPECTED FAILURES — an AppError a service threw on purpose — become the
 *      status and `{ error, code }` body that error names (http/errors.ts).
 *   2. UNEXPECTED FAILURES — anything else — are logged under the route's
 *      metric with whatever context the handler recorded, and answered with
 *      the route's fallback body. Never a raw message, never Next's HTML 500.
 *
 * So a controller is written for the path that works, throws AppError for the
 * paths it knows about, and cannot leak an exception it did not.
 *
 * There is NO caller authentication here. The caller of every internal route
 * is enginos-platform, which authenticates the user before forwarding and
 * passes the tenant id it resolved itself. Billing trusts that id, which is why
 * /api/internal/* must only be reachable from enginos-platform on the private
 * network and never published. The one exception is Chargebee's webhook, which
 * checks its own credentials (controllers/webhook.controller.ts).
 */

import { NextResponse } from "next/server";

import { AppError, errorMessage } from "../shared/errors";
import { errorResponse } from "./errors";

/** What an unexpected failure answers with, and how it is logged. */
export interface Fallback {
  status: number;
  body: Record<string, unknown>;
  metric: string;
  message: string;
}

export interface RouteContext<P> {
  params: P;
  /** Fields to attach to the log line if this request fails unexpectedly. */
  logContext: Record<string, unknown>;
}

type Handler<P> = (request: Request, ctx: RouteContext<P>) => Promise<Response>;

export function route<P = Record<string, never>>(options: { fallback: Fallback }, handler: Handler<P>) {
  return async (request: Request, next?: { params: Promise<P> }): Promise<Response> => {
    const ctx: RouteContext<P> = { params: {} as P, logContext: {} };
    try {
      ctx.params = (await next?.params) ?? ({} as P);
      return await handler(request, ctx);
    } catch (err) {
      if (err instanceof AppError) return errorResponse(err);

      const { fallback } = options;
      console.error({ metric: fallback.metric, ...ctx.logContext, err: errorMessage(err) }, fallback.message);
      return NextResponse.json(fallback.body, { status: fallback.status });
    }
  };
}
