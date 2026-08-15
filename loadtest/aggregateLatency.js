function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return null;
  const idx = Math.ceil((p / 100) * sortedMs.length) - 1;
  return sortedMs[Math.min(Math.max(idx, 0), sortedMs.length - 1)];
}

// Fires GET /logs/aggregate once per second for the duration of the run,
// recording wall-clock latency for each call. Runs concurrently with the
// POST /logs load so the numbers reflect querying while ingestion is hot.
function startAggregateProbe(baseUrl, { intervalMs = 1000 } = {}) {
  const latenciesMs = [];
  const errors = [];
  const testStart = Date.now();
  let stopped = false;

  const tick = async () => {
    const since = new Date(testStart - 5 * 60 * 1000).toISOString();
    const until = new Date().toISOString();
    const url = `${baseUrl}/logs/aggregate?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&bucket=1m&group_by=service`;
    const start = performance.now();
    try {
      const res = await fetch(url);
      const elapsed = performance.now() - start;
      if (!res.ok) {
        errors.push({ status: res.status, elapsedMs: elapsed });
      } else {
        await res.json();
        latenciesMs.push(elapsed);
      }
    } catch (err) {
      errors.push({ error: String(err), elapsedMs: performance.now() - start });
    }
  };

  const loop = async () => {
    while (!stopped) {
      const iterStart = Date.now();
      await tick();
      const elapsed = Date.now() - iterStart;
      const wait = Math.max(0, intervalMs - elapsed);
      await new Promise((r) => setTimeout(r, wait));
    }
  };
  const runner = loop();

  return {
    stop: async () => {
      stopped = true;
      await runner;
      const sorted = [...latenciesMs].sort((a, b) => a - b);
      return {
        count: sorted.length,
        errors: errors.length,
        errorSamples: errors.slice(0, 5),
        latencyMs: {
          min: sorted.length ? sorted[0] : null,
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          p99: percentile(sorted, 99),
          max: sorted.length ? sorted[sorted.length - 1] : null,
        },
      };
    },
  };
}

module.exports = { startAggregateProbe };
