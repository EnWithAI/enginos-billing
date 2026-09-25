/**
 * AppError → HTTP response. The only place an error kind becomes a status.
 *
 * The body is `{ error, code? }`. enginos-platform passes a named `code` through
 * to crewpe-ui as it is, and maps a codeless failure to one of its own per
 * route. `code` is included only when the service named one, so a route that
 * never had a code does not grow one.
 */

import { NextResponse } from "next/server";

import type { AppError, ErrorKind } from "../shared/errors";

const STATUS: Record<ErrorKind, number> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  upstream: 502,
};

export function errorResponse(err: AppError): NextResponse {
  return NextResponse.json(err.code ? { error: err.message, code: err.code } : { error: err.message }, {
    status: STATUS[err.kind],
  });
}
