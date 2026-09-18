/**
 * Request authentication for the two surfaces this service exposes.
 *
 * Both comparisons are constant-time. That is not theatre: the webhook password
 * is the ONLY thing standing in front of an endpoint that grants credits,
 * because Chargebee does not sign its webhooks — it authenticates by sending
 * HTTP Basic credentials configured alongside the endpoint URL.
 */

import { timingSafeEqual } from "node:crypto";

import { getConfig } from "./config";

/** Length-safe constant-time compare. */
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Chargebee webhook: HTTP Basic, credentials from the dashboard config. */
export function webhookAuthorised(header: string | null): boolean {
  const { webhookUser, webhookPassword } = getConfig().chargebee;

  // An unset password must never mean "allow everything".
  if (!webhookUser || !webhookPassword) return false;
  if (!header?.startsWith("Basic ")) return false;

  const supplied = Buffer.from(header.slice(6), "base64").toString();
  return equals(supplied, `${webhookUser}:${webhookPassword}`);
}

/** Internal API: a shared secret, only ever sent server-to-server. */
export function internalAuthorised(header: string | null): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return equals(header.slice(7), getConfig().internalApiKey);
}
