/**
 * The one error type a service throws to say "this request cannot be served,
 * and here is why".
 *
 * Transport-agnostic on purpose: a service names the KIND of failure and the
 * stable `code` crewpe-ui dispatches on, and only the HTTP layer decides what
 * status that becomes (see http/errors.ts). The worker, which has no HTTP at
 * all, can throw and catch the same type.
 *
 * Anything that is NOT an AppError is an unexpected failure. The route wrapper
 * logs it and answers with that route's fallback — it is never shown raw.
 */

export type ErrorKind = "invalid" | "not_found" | "conflict" | "upstream";

export class AppError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    /** Stable machine token the UI switches on. Omitted where the route never had one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const invalid = (message: string, code?: string) => new AppError("invalid", message, code);
export const notFound = (message: string, code?: string) => new AppError("not_found", message, code);
export const conflict = (message: string, code?: string) => new AppError("conflict", message, code);
export const upstream = (message: string, code?: string) => new AppError("upstream", message, code);

/**
 * The message of anything thrown.
 *
 * `(err as Error).message` is undefined for a thrown string or object, which
 * turns a log line into `err: undefined` exactly when it was needed.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
