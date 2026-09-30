/**
 * Chargebee's webhook credentials: the HTTP Basic user and password set on the
 * webhook endpoint in Chargebee (Settings > Configure Chargebee > Webhooks).
 *
 * Chargebee does not sign webhooks, so these are the whole of its
 * authentication — and they are the only thing between the internet and a
 * route that grants credits. Checked here, in billing, before the body is read.
 *
 * Unset credentials refuse every delivery: a missing env var must read as
 * "webhooks are off", never as "webhooks are open".
 */

import { timingSafeEqual } from "node:crypto";

export type WebhookAuth = "ok" | "unset" | "rejected";

export function checkWebhookAuth(
  header: string | null,
  expected: { user: string; password: string },
): WebhookAuth {
  if (!expected.user || !expected.password) return "unset";
  const supplied = parseBasicAuth(header);
  // Both halves are always compared, so the response time does not say which
  // one was wrong.
  const userMatches = constantTimeEqual(supplied?.user ?? "", expected.user);
  const passwordMatches = constantTimeEqual(supplied?.password ?? "", expected.password);
  return supplied && userMatches && passwordMatches ? "ok" : "rejected";
}

/** `Basic base64(user:password)` → its halves. The password may contain ":". */
function parseBasicAuth(header: string | null): { user: string; password: string } | undefined {
  const encoded = /^Basic\s+(\S+)\s*$/i.exec(header ?? "")?.[1];
  if (!encoded) return undefined;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return undefined;
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** Length mismatch returns false fast (length is not a secret); equal lengths go through `timingSafeEqual`. */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
