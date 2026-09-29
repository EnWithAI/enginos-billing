/**
 * The Chargebee webhook, with NO local replay guard.
 *
 * `processed_billing_event` used to claim each event id before any work. It is
 * gone, so these tests pin what replaces it — which is not a table but a
 * property: every handler is CONVERGENT, so a redelivery lands on the same
 * state instead of doubling it.
 *
 * The two that would not be convergent on their own are guarded where they
 * live, and both are pinned below: the billing cursor is create-only, so a
 * replayed activation cannot rewind it; and a failure is handed back to
 * Chargebee as a 500 rather than acknowledged, because nothing here remembers
 * the event any more.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { TENANT, makeFakePrisma } from "./harness";

const held = vi.hoisted(() => ({
  prisma: null as unknown as ReturnType<typeof import("./harness").makeFakePrisma>,
  chargebee: null as unknown as Record<string, unknown>,
}));

vi.mock("@/db/prisma", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/prisma")>()),
  get prisma() {
    return held.prisma;
  },
}));
vi.mock("@/integrations/chargebee", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/chargebee")>()),
  createChargebee: () => held.chargebee,
}));
// No gateway in these tests: they are about the event log, not the cap.
vi.mock("@/container/budget-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/container/budget-hooks")>()),
  gatewayBudgetHooks: () => ({}),
}));

const { POST } = await import("@/app/api/webhooks/chargebee/route");

/** The subscription as Chargebee holds it — what every handler now reads, whatever the body says. */
const SUBSCRIPTION = {
  id: "sub_1",
  customer_id: TENANT,
  status: "active",
  current_term_start: 1789731843,
  current_term_end: 1792410243,
  subscription_items: [{ item_price_id: "plan" }],
};

const SUBSCRIPTION_ENDED = { ...SUBSCRIPTION, status: "cancelled" };

function chargebee(over: Record<string, unknown> = {}) {
  return {
    balance: async () => ({ unitId: "token-test", unitName: "token-test", usable: "1000", onHold: "0" }),
    grantedCredits: async () => ({ credits: "1000", blocks: 1 }),
    activeSubscriptions: async (customerId: string) => (customerId === TENANT ? [{ ...SUBSCRIPTION }] : []),
    subscription: async (id: string) => (id === SUBSCRIPTION.id ? { ...SUBSCRIPTION } : null),
    customer: async (id: string) => (id === TENANT ? { id } : null),
    ...over,
  };
}

function created(id: string, customerId = TENANT) {
  return {
    id,
    event_type: "subscription_created",
    content: {
      subscription: {
        id: "sub_1",
        customer_id: customerId,
        current_term_start: 1789731843,
        current_term_end: 1792410243,
        subscription_items: [{ item_price_id: "plan" }],
      },
    },
  };
}

async function deliver(event: unknown) {
  const res = await POST(
    new Request("http://billing.test/api/webhooks/chargebee", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * What a handled `subscription_created` leaves behind, now that there is no
 * grant entry to count: the subscription is linked and the usage cursor exists.
 * Nothing in this service records the credits themselves any more.
 */
const linked = () => held.prisma._accounts.get(TENANT)!.chargebeeSubscriptionId;
/** Where billing has reached, in epoch ms, or null before activation. */
const cursor = () => held.prisma._cursor;
/** Pretend the worker billed a minute of usage, so a replay has something to clobber. */
const advanceCursor = async (fromAt: number, toAt: number) => {
  await held.prisma.chargebeeSync.create({
    data: {
      tenantId: TENANT,
      fromIngestedAt: new Date(fromAt),
      toIngestedAt: new Date(toAt),
      eventCount: 1,
      amount: "1",
      billedUsd: "0.001",
      status: "SUCCESS",
      settledAt: new Date(toAt),
    },
  });
  await held.prisma.billingAccount.update({
    where: { tenantId: TENANT },
    data: { lastProcessedIngestedAt: new Date(toAt) },
  });
};

beforeEach(async () => {
  process.env.CHARGEBEE_SITE = "test-site";
  process.env.CHARGEBEE_API_KEY = "test_key";
  process.env.CLICKHOUSE_PASSWORD = "pw";
  (await import("@/config/config")).resetConfig();

  // Unlinked and never polled: linking and the first cursor are what these
  // tests observe, in place of the grant entry the ledger used to record.
  held.prisma = makeFakePrisma({ chargebeeSubscriptionId: null, ledgerUnitId: null });
  held.prisma._accounts.get(TENANT)!.chargebeeCustomerId = TENANT;
  held.chargebee = chargebee();
});

describe("a webhook with no claim row in front of it", () => {
  it("links the subscription and lays down the billing cursor", async () => {
    const res = await deliver(created("ev_1"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(linked()).toBe("sub_1");
    // The cursor is set, and NO sync row is written for it. The activation
    // point is a column now, not a row in the log every reader must skip.
    expect(cursor()).toBeGreaterThan(0);
    expect(held.prisma._log).toEqual([]);
  });

  it("converges rather than doubling when the same event is delivered twice", async () => {
    // THE property the claim row used to provide, now provided by the handlers
    // themselves: each re-reads Chargebee and applies what it says.
    await deliver(created("ev_2"));
    const afterFirst = {
      subscription: linked(),
      cursor: cursor(),
      termStart: held.prisma._accounts.get(TENANT)!.currentTermStart,
    };

    const again = await deliver(created("ev_2"));
    const again2 = await deliver(created("ev_2"));

    expect(again.status).toBe(200);
    expect(again2.status).toBe(200);
    expect(linked()).toBe(afterFirst.subscription);
    expect(cursor()).toBe(afterFirst.cursor);
    expect(held.prisma._accounts.get(TENANT)!.currentTermStart).toEqual(afterFirst.termStart);
    expect(held.prisma._log).toEqual([]);
  });

  it("does not rewind the billing cursor on a replay, however late it arrives", async () => {
    // THE replay hazard. A second activation that reset the cursor to now()
    // would silently skip every span ingested between the two, and nothing
    // would notice. `ensureBillingCursor` is create-only for exactly this.
    await deliver(created("ev_3"));
    const start = cursor()!;
    await advanceCursor(start, start + 60_000);

    // The same event body, replayed after billing has moved on.
    expect((await deliver(created("ev_3"))).status).toBe(200);

    expect(cursor()).toBe(start + 60_000);
  });

  it("takes the body as a trigger only: an old term or plan in it changes nothing — Chargebee's current state is applied", async () => {
    // A `subscription_created` Chargebee retried after a 500 can arrive long
    // after the term it describes. Its dates used to be written verbatim.
    await deliver(created("ev_7"));
    const stale = created("ev_8");
    stale.content.subscription.current_term_start = 1700000000;
    stale.content.subscription.current_term_end = 1702592000;
    stale.content.subscription.subscription_items = [{ item_price_id: "some-old-plan" }];

    expect((await deliver(stale)).status).toBe(200);

    const account = held.prisma._accounts.get(TENANT)!;
    expect(account.currentTermStart).toEqual(new Date(1789731843 * 1000));
    expect(account.chargebeeItemPriceId).toBe("plan");
  });

  it("a cancellation event cancels the account only once Chargebee says the linked subscription has ended", async () => {
    await deliver(created("ev_9"));
    const cancelled = { ...created("ev_10"), event_type: "subscription_cancelled" };

    // Chargebee still reports it active (a stale or misdirected event): nothing changes.
    expect((await deliver(cancelled)).status).toBe(200);
    expect(held.prisma._accounts.get(TENANT)!.status).toBe("active");

    // Now it has really ended.
    held.chargebee = chargebee({
      activeSubscriptions: async () => [],
      subscription: async () => ({ ...SUBSCRIPTION_ENDED }),
    });
    expect((await deliver(cancelled)).status).toBe(200);
    expect(held.prisma._accounts.get(TENANT)!.status).toBe("cancelled");
  });

  it("hands a failed handler back to Chargebee as a 500, rather than acknowledging it", async () => {
    // With no claim row there is nothing that remembers this event, so a 200
    // would drop it silently. A non-2xx makes Chargebee retry, and a webhook
    // that keeps failing shows up in ITS delivery log — which is the audit
    // trail this service gave up.
    held.chargebee = chargebee({
      balance: async () => {
        throw new Error("Chargebee unreachable");
      },
    });

    const res = await deliver(created("ev_4"));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ received: false, handled: false });
    expect(linked()).toBeNull();
  });

  it("recovers on the redelivery once the cause is fixed", async () => {
    held.chargebee = chargebee({
      balance: async () => {
        throw new Error("Chargebee unreachable");
      },
    });
    expect((await deliver(created("ev_5"))).status).toBe(500);

    held.chargebee = chargebee();
    const ok = await deliver(created("ev_5"));

    expect(ok.status).toBe(200);
    expect(linked()).toBe("sub_1");
  });

  it("refuses an event whose customer maps to no account, instead of swallowing it", async () => {
    const res = await deliver(created("ev_6", "cust_created_by_hand"));

    expect(res.status).toBe(500);
    expect(linked()).toBeNull();
  });
});
