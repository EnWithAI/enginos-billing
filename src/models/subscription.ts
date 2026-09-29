/**
 * Which subscription receives this customer's usage.
 *
 * A pricing question, answered in one place, by rules written down rather than
 * implied. It used to be `activeSubscriptions(customerId)[0]` — newest first —
 * buried inside `syncFromChargebee`, which is a business rule stated as an
 * array index: a customer who bought a second subscription had their usage move
 * to it silently, mid-term, with nothing recording that it had happened.
 *
 * The database is not asked to decide this. `billing_account` has ONE
 * `chargebee_subscription_id` column and it stores the answer; it does not
 * model the alternatives, rank them, or carry a flag saying which is billable.
 * A schema that did would make every reader re-derive the rule.
 *
 *   Customer
 *      ├── main subscription          ← usage is billed here
 *      └── top-up / add-on            ← credits arrive here, usage does not
 *
 * Note that in this deployment a top-up is a ONE-TIME charge against the main
 * subscription, not a second subscription (see `topUpItemPriceId` in config).
 * So the multi-subscription case is not routine — which is exactly why it needs
 * a rule rather than an accident: it will be rare, and therefore rarely noticed
 * when it goes wrong.
 */

/**
 * A Chargebee subscription, narrowed to the fields this service reads. Epoch
 * SECONDS on the term fields, as Chargebee sends them.
 */
export interface SubscriptionLike {
  id: string;
  created_at?: number;
  status?: string;
  current_term_start?: number;
  current_term_end?: number;
  subscription_items?: Array<{ item_price_id?: string }>;
  [key: string]: unknown;
}

/** Why this subscription, in a word — logged, and rendered nowhere. */
export type ChoiceReason =
  /** Already the billing subscription and still active. Nothing moves. */
  | "current"
  /** The customer has exactly one. */
  | "only"
  /** The newest one selling a plan we bill usage against. */
  | "billing_plan"
  /** No candidate carried a known plan, so the newest active one wins. */
  | "newest"
  | "none";

export interface SubscriptionChoice {
  subscription: SubscriptionLike | null;
  reason: ChoiceReason;
  /** Active subscriptions NOT chosen. Non-zero is worth an operator's attention. */
  alternatives: number;
}

export function itemPriceIdOf(subscription: SubscriptionLike | null | undefined): string | null {
  return subscription?.subscription_items?.[0]?.item_price_id ?? null;
}

/**
 * Pick the usage-billing subscription.
 *
 * `currentId` is what `billing_account` already holds, and it wins whenever it
 * is still active. STICKINESS IS THE POINT: usage accrued under a subscription
 * should be charged to that subscription, and a customer adding a second one
 * must not silently redirect the stream — moving it is a decision someone
 * makes, not something a sort order does.
 *
 * `billingItemPriceIds` is the configured plan allowlist (`ITEM_PRICE_IDS`).
 * A subscription selling one of those is a usage plan; anything else the
 * customer happens to hold is not, and is skipped before the newest-wins
 * fallback ever sees it.
 */
export function chooseBillingSubscription(
  subscriptions: Array<Record<string, any>>,
  opts: { currentId?: string | null; billingItemPriceIds?: string[] } = {},
): SubscriptionChoice {
  // Chargebee's list is typed as loosely as it arrives. An entry with no id is
  // not a subscription we can bill against, and silently dropping it here beats
  // discovering it as `undefined` in a capture call.
  const active = subscriptions.filter((s): s is SubscriptionLike => typeof s?.id === "string");
  if (active.length === 0) return { subscription: null, reason: "none", alternatives: 0 };

  const others = (chosen: SubscriptionLike) => active.filter((s) => s.id !== chosen.id).length;

  const current = opts.currentId ? active.find((s) => s.id === opts.currentId) : undefined;
  if (current) return { subscription: current, reason: "current", alternatives: others(current) };

  if (active.length === 1) return { subscription: active[0]!, reason: "only", alternatives: 0 };

  // Newest first, so "the plan they most recently bought" is what both branches
  // below mean by the first match.
  const byAge = [...active].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

  const allowlist = new Set(opts.billingItemPriceIds ?? []);
  if (allowlist.size > 0) {
    const onPlan = byAge.find((s) => {
      const priceId = itemPriceIdOf(s);
      return priceId != null && allowlist.has(priceId);
    });
    if (onPlan) return { subscription: onPlan, reason: "billing_plan", alternatives: others(onPlan) };
  }

  const newest = byAge[0]!;
  return { subscription: newest, reason: "newest", alternatives: others(newest) };
}
