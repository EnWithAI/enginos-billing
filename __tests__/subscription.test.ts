/**
 * Which subscription receives the usage (§15).
 *
 * The rule lives in the business layer and is tested here on its own, without a
 * database, because that is the point of extracting it: the schema stores one
 * subscription id and has no opinion about how it was chosen.
 */

import { describe, expect, it } from "vitest";

import { chooseBillingSubscription, itemPriceIdOf } from "@/models/subscription";

const sub = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  created_at: 1000,
  status: "active",
  subscription_items: [{ item_price_id: "pre-paid-test-v1-INR-Monthly" }],
  ...over,
});

const PLANS = ["pre-paid-test-v1-INR-Monthly"];

describe("choosing the usage-billing subscription", () => {
  it("returns nothing when the customer has none", () => {
    expect(chooseBillingSubscription([])).toEqual({ subscription: null, reason: "none", alternatives: 0 });
  });

  it("takes the only one", () => {
    const choice = chooseBillingSubscription([sub("sub_1")]);
    expect(choice.subscription?.id).toBe("sub_1");
    expect(choice.reason).toBe("only");
    expect(choice.alternatives).toBe(0);
  });

  it("keeps the subscription already being billed, even when a newer one exists", () => {
    // STICKINESS. Usage accrued under a subscription is charged to that
    // subscription; a customer buying a second one must not silently redirect
    // the stream mid-term. The old `[0]` — newest first — did exactly that.
    const choice = chooseBillingSubscription([sub("sub_new", { created_at: 9000 }), sub("sub_old", { created_at: 1000 })], {
      currentId: "sub_old",
      billingItemPriceIds: PLANS,
    });

    expect(choice.subscription?.id).toBe("sub_old");
    expect(choice.reason).toBe("current");
    expect(choice.alternatives).toBe(1);
  });

  it("moves on once the subscription it was billing is no longer active", () => {
    // `activeSubscriptions` is the input, so a cancelled one is simply absent.
    const choice = chooseBillingSubscription([sub("sub_new", { created_at: 9000 })], {
      currentId: "sub_gone",
      billingItemPriceIds: PLANS,
    });

    expect(choice.subscription?.id).toBe("sub_new");
    expect(choice.reason).toBe("only");
  });

  it("prefers a usage plan over a top-up or add-on the customer also holds", () => {
    // The distinction §15 is about: credits arrive on the add-on, usage is
    // billed against the main subscription.
    const topUp = sub("sub_topup", { created_at: 9000, subscription_items: [{ item_price_id: "token-pack-5m-INR" }] });
    const main = sub("sub_main", { created_at: 1000 });

    const choice = chooseBillingSubscription([topUp, main], { billingItemPriceIds: PLANS });

    expect(choice.subscription?.id).toBe("sub_main");
    expect(choice.reason).toBe("billing_plan");
    expect(choice.alternatives).toBe(1);
  });

  it("takes the newest usage plan when there are several", () => {
    const choice = chooseBillingSubscription([sub("sub_a", { created_at: 1000 }), sub("sub_b", { created_at: 9000 })], {
      billingItemPriceIds: PLANS,
    });

    expect(choice.subscription?.id).toBe("sub_b");
    expect(choice.reason).toBe("billing_plan");
  });

  it("falls back to the newest when no candidate is on a known plan", () => {
    // An unconfigured allowlist, or a plan sold before it was added to one,
    // must not stop a paying customer being billed at all.
    const choice = chooseBillingSubscription(
      [sub("sub_a", { created_at: 1000, subscription_items: [{ item_price_id: "legacy" }] }),
       sub("sub_b", { created_at: 9000, subscription_items: [{ item_price_id: "legacy" }] })],
      { billingItemPriceIds: PLANS },
    );

    expect(choice.subscription?.id).toBe("sub_b");
    expect(choice.reason).toBe("newest");
    expect(choice.alternatives).toBe(1);
  });

  it("ignores an entry with no id rather than passing undefined to a capture", () => {
    const choice = chooseBillingSubscription([{ status: "active" }, sub("sub_1")]);
    expect(choice.subscription?.id).toBe("sub_1");
    expect(choice.alternatives).toBe(0);
  });

  it("reports how many were not chosen, which is what makes the case visible", () => {
    const choice = chooseBillingSubscription([sub("sub_a"), sub("sub_b", { created_at: 2 }), sub("sub_c", { created_at: 3 })], {
      billingItemPriceIds: PLANS,
    });
    expect(choice.alternatives).toBe(2);
  });
});

describe("itemPriceIdOf", () => {
  it("reads the first item's price id", () => {
    expect(itemPriceIdOf(sub("sub_1"))).toBe("pre-paid-test-v1-INR-Monthly");
  });

  it("is null rather than undefined when there is no item", () => {
    expect(itemPriceIdOf(sub("sub_1", { subscription_items: [] }))).toBeNull();
    expect(itemPriceIdOf(null)).toBeNull();
  });
});
