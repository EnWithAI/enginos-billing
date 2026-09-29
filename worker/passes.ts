/**
 * The usage-sync passes of one minute's run.
 *
 * Hatchet's cron fires once a minute at most. With BILLING_SWEEP_INTERVAL_MS
 * under a minute, the run makes a pass every interval: at 0 s, 10 s, 20 s …
 * after the run started. Each pass starts on its own slot, not after the
 * previous one ends, so one slow pass is followed at once instead of pushing
 * every later one back.
 *
 * No pass starts after `lastStartMs`: the run has to end before the next
 * minute's tick, because the workflow runs one at a time and cancels the tick
 * that finds one still running (CANCEL_NEWEST) — which would lose a whole
 * minute of passes.
 */
export async function runPasses<T>({
  runOnce,
  intervalMs,
  lastStartMs,
  startedAt,
  now = () => Date.now(),
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
  runOnce: () => Promise<T>;
  intervalMs: number;
  lastStartMs: number;
  startedAt: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T[]> {
  const passes = [await runOnce()];
  if (intervalMs >= 60_000) return passes;

  for (let slot = startedAt + intervalMs; slot - startedAt <= lastStartMs; slot += intervalMs) {
    const wait = slot - now();
    if (wait > 0) await sleep(wait);
    if (now() - startedAt > lastStartMs) break;
    passes.push(await runOnce());
  }
  return passes;
}
