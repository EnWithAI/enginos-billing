/**
 * What a billing account is, operationally — and why a LiteLLM team is blocked.
 */

/**
 * Account states. `exhausted` blocks the LiteLLM team and holds the usage sync
 * — nothing sent to Chargebee, nothing read — until credits come back.
 */
export const ACCOUNT = {
  UNLINKED: "unlinked",
  /** Paid, but the LiteLLM budget is not set yet: no credits shown, team blocked, retried each minute. */
  ACTIVATING: "activating",
  ACTIVE: "active",
  CANCELLED: "cancelled",
  /** Chargebee says the credits are used up. Only credits coming back (activate()) moves it on. */
  EXHAUSTED: "exhausted",
  /**
   * The org's credits are being moved to a subscription in another currency
   * (the currency switch, `currency_switch`). The usage sync opens no window
   * and sends no capture — usage waits in ClickHouse in front of a cursor that
   * does not move — no top-up is sold, and the LiteLLM team keeps the cap it
   * had, so the org keeps working. NOTHING but the currency switch changes the
   * account's status or subscription while it reads this: every other status
   * write and every relink refuses it (billing-account.repository.ts).
   */
  SWITCHING: "switching",
} as const;

export type AccountStatus = (typeof ACCOUNT)[keyof typeof ACCOUNT];

/**
 * Why billing blocked a tenant's LiteLLM team. Written to the team's metadata
 * so whoever reads the team can tell a paid-but-not-yet-live account from one
 * whose credits ran out.
 */
export type BlockReason = "activating" | "exhausted";
