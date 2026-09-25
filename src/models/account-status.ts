/**
 * What a billing account is, operationally — and why a LiteLLM team is blocked.
 */

/** Account states. `exhausted` is display-only — the gateway is the real gate. */
export const ACCOUNT = {
  UNLINKED: "unlinked",
  /** Paid, but the LiteLLM budget is not set yet: no credits shown, team blocked, retried each minute. */
  ACTIVATING: "activating",
  ACTIVE: "active",
  CANCELLED: "cancelled",
  EXHAUSTED: "exhausted",
} as const;

export type AccountStatus = (typeof ACCOUNT)[keyof typeof ACCOUNT];

/**
 * Why billing blocked a tenant's LiteLLM team. Written to the team's metadata
 * so whoever reads the team can tell a paid-but-not-yet-live account from one
 * whose credits ran out.
 */
export type BlockReason = "activating" | "exhausted";
