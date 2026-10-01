/**
 * A billing address on its way INTO Chargebee, validated.
 *
 * Its COUNTRY is the one fact billing keeps (`billing_account.billing_country`):
 * it decides the currency the org is billed in (models/currency.ts). The rest
 * lives on Chargebee's customer, which is where invoices take it from.
 *
 * Since A29 the org enters its address in Chargebee's OWN editor, and billing
 * only reads it back (services/billing-address.service.ts) — no route writes
 * one. This shape stays as the input of the client's `updateBillingInfo`
 * (`update_billing_info`), for a caller that must set an address itself: it
 * is validated here, before anything is written anywhere, and a refusal names
 * the field.
 *
 * The limits are Chargebee's own for `billing_address[...]`, so an address
 * that passes here is not refused there for its length.
 */

import { invalid } from "../shared/errors";
import { normaliseCountry } from "./currency";

/** A validated address: every string trimmed, an empty optional field left out. */
export interface BillingAddress {
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  line1: string;
  city: string;
  line2?: string;
  state?: string;
  stateCode?: string;
  zip?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
}

/** The longest each field may be, in characters. */
export const BILLING_ADDRESS_LIMITS = {
  line1: 150,
  city: 50,
  line2: 150,
  state: 50,
  stateCode: 50,
  zip: 20,
  firstName: 150,
  lastName: 150,
  company: 250,
} as const;

const REQUIRED = ["line1", "city"] as const;
const OPTIONAL = ["line2", "state", "stateCode", "zip", "firstName", "lastName", "company"] as const;

/**
 * The address in a request body, or a 400 `billing-address-invalid` naming
 * the first field that is wrong. Keys it does not know (`tenantId` among them)
 * are not its business and are ignored.
 *
 * A field sent as anything but text is refused, not dropped: a postcode sent
 * as a number and silently left out would reach Chargebee as an address with
 * no postcode, which nobody asked for.
 */
export function parseBillingAddress(body: Record<string, unknown>): BillingAddress {
  if (body.country == null || body.country === "") throw refused("country is required");
  const country = normaliseCountry(body.country);
  if (country == null) {
    throw refused("country must be a two-letter ISO 3166-1 country code, such as IN or US");
  }

  const address: BillingAddress = { country, line1: "", city: "" };
  for (const field of REQUIRED) {
    const value = text(body, field);
    if (value === undefined) throw refused(`${field} is required`);
    address[field] = value;
  }
  for (const field of OPTIONAL) {
    const value = text(body, field);
    if (value !== undefined) address[field] = value;
  }
  return address;
}

/** The field trimmed, within its limit; undefined when it is absent, null or blank. */
function text(body: Record<string, unknown>, field: keyof typeof BILLING_ADDRESS_LIMITS): string | undefined {
  const raw = body[field];
  if (raw == null) return undefined;
  if (typeof raw !== "string") throw refused(`${field} must be text`);
  const value = raw.trim();
  if (value === "") return undefined;
  const limit = BILLING_ADDRESS_LIMITS[field];
  if (value.length > limit) throw refused(`${field} must be at most ${limit} characters`);
  return value;
}

const refused = (message: string) => invalid(message, "billing-address-invalid");
