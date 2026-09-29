/**
 * Several usage-sync passes inside one minute's run (BILLING_SWEEP_INTERVAL_MS
 * under 60 s), and how they are reported.
 */

import { describe, expect, it } from "vitest";

import { mergePasses, renderSweep } from "@/views/sweep.view";

import { runPasses } from "../worker/passes";

/** A clock that only moves when the code sleeps, or a pass says it took time. */
function fakeTime(startedAt = 1_000_000) {
  let t = startedAt;
  const starts: number[] = [];
  return {
    startedAt,
    starts,
    now: () => t,
    sleep: async (ms: number) => void (t += ms),
    pass: (tookMs = 0) => async () => {
      starts.push(t - startedAt);
      t += tookMs;
      return { at: t - startedAt };
    },
  };
}

describe("usage-sync passes in one run", () => {
  it("makes one pass a minute when the interval is a minute or more — as before", async () => {
    const clock = fakeTime();
    const passes = await runPasses({ runOnce: clock.pass(), intervalMs: 60_000, lastStartMs: 45_000, startedAt: clock.startedAt, now: clock.now, sleep: clock.sleep });
    expect(passes).toHaveLength(1);
    expect(clock.starts).toEqual([0]);
  });

  it("every 10 s, starting no pass after 45 s, so the run ends before the next minute's tick", async () => {
    const clock = fakeTime();
    await runPasses({ runOnce: clock.pass(300), intervalMs: 10_000, lastStartMs: 45_000, startedAt: clock.startedAt, now: clock.now, sleep: clock.sleep });
    expect(clock.starts).toEqual([0, 10_000, 20_000, 30_000, 40_000]);
  });

  it("keeps to its slots: a slow pass is followed at once, and never pushes the rest back", async () => {
    const clock = fakeTime();
    let n = 0;
    const slowSecond = async () => {
      n += 1;
      return clock.pass(n === 2 ? 14_000 : 200)();
    };
    await runPasses({ runOnce: slowSecond, intervalMs: 10_000, lastStartMs: 45_000, startedAt: clock.startedAt, now: clock.now, sleep: clock.sleep });
    // The second pass (at 10 s) ran for 14 s: the 20 s slot starts at once, at 24 s; 30 s and 40 s keep their times.
    expect(clock.starts).toEqual([0, 10_000, 24_000, 30_000, 40_000]);
  });

  it("stops rather than start a pass past the cutoff, however late the previous one ran", async () => {
    const clock = fakeTime();
    await runPasses({ runOnce: clock.pass(40_000), intervalMs: 10_000, lastStartMs: 45_000, startedAt: clock.startedAt, now: clock.now, sleep: clock.sleep });
    // The first pass ran 40 s; the second starts at 40 s and ends at 80 s; nothing after.
    expect(clock.starts).toEqual([0, 40_000]);
  });
});

describe("the run's summary", () => {
  const pass = (over: Record<string, unknown> = {}) =>
    ({
      tenantsScanned: 3,
      synced: 1,
      replayed: 0,
      idle: 2,
      unknown: 0,
      rateLimited: 0,
      outOfCredits: 0,
      invalid: 0,
      holding: 0,
      exhausted: 0,
      locked: 0,
      writtenOff: 0,
      errors: [],
      results: [],
      ...over,
    }) as never;

  it("adds the passes up, keeps every error, and says how many passes there were", () => {
    const merged = mergePasses([
      pass({ synced: 1, errors: [{ tenantSlug: "a", error: "x" }] }),
      pass({ synced: 2, tenantsScanned: 4, outOfCredits: 1 }),
      pass({ synced: 0, errors: [{ tenantSlug: "b", error: "y" }] }),
    ]);
    expect(merged).toMatchObject({ tenantsScanned: 4, synced: 3, idle: 6, outOfCredits: 1 });
    expect(merged.errors).toHaveLength(2);

    expect(renderSweep({ pending: 0, activated: 0 }, merged, { checked: 2, reopened: 0 }, 3)).toMatchObject({
      passes: 3,
      synced: 3,
      tenantsScanned: 4,
      erroredTenants: 2,
    });
  });
});
