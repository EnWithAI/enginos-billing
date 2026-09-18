/**
 * The Chargebee webhook's event log (`processed_billing_event`).
 *
 * Two things it must get right: every event says which organisation it was
 * for, and a delivery whose handling FAILED is not mistaken for a duplicate
 * the next time Chargebee sends it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { TENANT, makeFakePrisma } from "./harness";

const held = vi.hoisted(() => ({
  prisma: null as unknown as ReturnType<typeof import("./harness").makeFakePrisma>,
  chargebee: null as unknown as Record<string, unknown>,
}));

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  get prisma() {
    return held.prisma;
  },
}));
vi.mock("@/lib/chargebee", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chargebee")>()),
  createChargebee: () => held.chargebee,
}));
// No gateway in these tests: they are about the event log, not the cap.
vi.mock("@/lib/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway")>()),
  gatewayBudgetHooks: () => ({}),
}));

const { POST } = await import("@/app/api/webhooks/chargebee/route");

const AUTH = `Basic ${Buffer.from("chargebee:hook-secret").toString("base64")}`;

function chargebee(over: Record<string, unknown> = {}) {
  return {
    balance: async () => ({ unitId: "token-test", unitName: "token-test", usable: "1000", onHold: "0" }),
    grantedCredits: async () => ({ credits: "1000", blocks: 1 }),
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
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: JSON.stringify(event),
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

const grants = () => held.prisma._entries.filter((e: { entryType: string }) => e.entryType === "grant");

beforeEach(async () => {
  process.env.CHARGEBEE_SITE = "test-site";
  process.env.CHARGEBEE_API_KEY = "test_key";
  process.env.CLICKHOUSE_PASSWORD = "pw";
  process.env.CHARGEBEE_WEBHOOK_USER = "chargebee";
  process.env.CHARGEBEE_WEBHOOK_PASSWORD = "hook-secret";
  (await import("@/lib/config")).resetConfig();

  held.prisma = makeFakePrisma();
  held.prisma._accounts.get(TENANT)!.chargebeeCustomerId = TENANT;
  held.chargebee = chargebee();
});

describe("processed_billing_event", () => {
  it("records which organisation the event was for", async () => {
    const res = await deliver(created("ev_1"));

    expect(res).toEqual({ received: true });
    expect(held.prisma._events.get("ev_1")).toMatchObject({ tenantId: TENANT, error: null });
    expect(held.prisma._events.get("ev_1")!.processedAt).toBeInstanceOf(Date);
  });

  it("records an unmappable customer as 'unmapped customer' instead of marking it processed", async () => {
    // It used to be marked processed and vanish, indistinguishable from success.
    const res = await deliver(created("ev_2", "cust_created_by_hand"));

    expect(res).toEqual({ received: true, handled: false });
    expect(held.prisma._events.get("ev_2")).toMatchObject({ tenantId: null, processedAt: null, error: "unmapped customer" });
    expect(grants()).toHaveLength(0);
  });

  it("runs a redelivered event again when its first attempt failed", async () => {
    // It used to be skipped as a duplicate: the grant silently never happened.
    held.chargebee = chargebee({ balance: async () => { throw new Error("Chargebee unreachable"); } });
    expect(await deliver(created("ev_3"))).toEqual({ received: true, handled: false });
    expect(held.prisma._events.get("ev_3")).toMatchObject({ processedAt: null, error: "Chargebee unreachable", tenantId: TENANT });

    held.chargebee = chargebee();
    expect(await deliver(created("ev_3"))).toEqual({ received: true, retried: true });

    expect(held.prisma._events.get("ev_3")!.processedAt).toBeInstanceOf(Date);
    expect(held.prisma._events.get("ev_3")!.error).toBeNull();
    expect(grants()).toHaveLength(1);
  });

  it("re-running a failed event cannot grant twice", async () => {
    // The first attempt got as far as the grant before failing afterwards.
    await deliver(created("ev_4"));
    held.prisma._events.get("ev_4")!.processedAt = null;
    held.prisma._events.get("ev_4")!.error = "crashed after the grant";

    expect(await deliver(created("ev_4"))).toEqual({ received: true, retried: true });
    expect(grants()).toHaveLength(1); // keyed on the term, not the attempt
  });

  it("treats a processed event as a duplicate", async () => {
    await deliver(created("ev_5"));

    expect(await deliver(created("ev_5"))).toEqual({ received: true, duplicate: true });
    expect(grants()).toHaveLength(1);
  });

  it("does not re-run an event that is still in flight (claimed, no error yet)", async () => {
    await held.prisma.processedBillingEvent.create({ data: { eventId: "ev_6", eventType: "subscription_created" } });

    expect(await deliver(created("ev_6"))).toEqual({ received: true, duplicate: true });
    expect(grants()).toHaveLength(0);
  });

  it("does not acknowledge an event it could not even claim", async () => {
    // A database outage used to be swallowed as "duplicate" and answered 200,
    // so Chargebee never retried and the event was lost.
    held.prisma.processedBillingEvent.create = async () => {
      throw new Error("connection refused");
    };

    await expect(deliver(created("ev_7"))).rejects.toThrow("connection refused");
  });
});
