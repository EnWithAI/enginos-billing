/**
 * Reading what a caller sent.
 *
 * Every route treats a missing body and an unparsable one alike — as empty —
 * and lets the required-field check say what is wrong. That keeps one error
 * message per missing field instead of a second, vaguer "bad JSON" path.
 */

import { invalid } from "../shared/errors";

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  return body != null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** The tenant a request is about. Required by every internal route that acts on one. */
export function requireTenantId(body: Record<string, unknown>): string {
  const { tenantId } = body;
  if (typeof tenantId !== "string" || tenantId === "") throw invalid("tenantId is required");
  return tenantId;
}

/** A required true/false field. A string "true" is not one: say what you mean. */
export function requireBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== "boolean") throw invalid(`${field} must be true or false`);
  return value;
}

/** An optional string field; anything that is not a non-empty string counts as absent. */
export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}
