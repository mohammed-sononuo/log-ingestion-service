const autocannon = require("autocannon");
const fs = require("node:fs");
const path = require("node:path");
const { makeBatch } = require("./genBatch");
const { startAggregateProbe } = require("./aggregateLatency");
const { startSampler } = require("./dockerStats");

const BASE_URL = process.env.LOADTEST_URL ?? "http://localhost:8080";
const DURATION_S = Number(process.env.LOADTEST_DURATION_S ?? 30);
const CONNECTIONS = Number(process.env.LOADTEST_CONNECTIONS ?? 20);
const BATCH_SIZE = Number(process.env.LOADTEST_BATCH_SIZE ?? 2000);
const PIPELINING = Number(process.env.LOADTEST_PIPELINING ?? 1);
const OVERALL_RATE = process.env.LOADTEST_OVERALL_RATE ? Number(process.env.LOADTEST_OVERALL_RATE) : undefined;

async function main() {
  const body = JSON.stringify(makeBatch(BATCH_SIZE));
  const bodyKB = (Buffer.byteLength(body) / 1024).toFixed(1);

  console.log(
    `[run] target=${BASE_URL} duration=${DURATION_S}s connections=${CONNECTIONS} ` +
      `pipelining=${PIPELINING} batchSize=${BATCH_SIZE} (${bodyKB} KB/req)`
  );

  const statsSampler = startSampler(1000);
  const aggregateProbe = startAggregateProbe(BASE_URL, { intervalMs: 1000 });

  const result = await autocannon({
    url: `${BASE_URL}/logs`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    connections: CONNECTIONS,
    pipelining: PIPELINING,
    duration: DURATION_S,
    ...(OVERALL_RATE !== undefined ? { overallRate: OVERALL_RATE } : {}),
  });

  const aggregateStats = await aggregateProbe.stop();
  const dockerStatsSummary = await statsSampler.stop();

  const totalRequests = result.requests.total; // completed (2xx) requests, not merely sent
  const totalLogsIngested = totalRequests * BATCH_SIZE;
  const wallSeconds = result.duration;
  const logsPerSecond = totalLogsIngested / wallSeconds;

  const report = {
    config: { BASE_URL, DURATION_S, CONNECTIONS, BATCH_SIZE, PIPELINING },
    postLogs: {
      durationS: wallSeconds,
      requestsSent: totalRequests,
      requestsPerSecond: result.requests.average,
      non2xx: result.non2xx,
      errors: result.errors,
      timeouts: result.timeouts,
      totalLogsIngested,
      logsPerSecond,
      latencyMs: {
        p50: result.latency.p50,
        p97_5: result.latency.p97_5,
        p99: result.latency.p99,
        max: result.latency.max,
      },
      throughputMBps: (result.throughput.average / (1024 * 1024)).toFixed(2),
    },
    aggregateQuery: aggregateStats,
    dockerStats: dockerStatsSummary,
  };

  console.log("\n================= LOAD TEST REPORT =================");
  console.log(JSON.stringify(report, null, 2));

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `run-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n[run] full report written to ${outFile}`);

  console.log("\n--- summary ---");
  console.log(`POST /logs: ${logsPerSecond.toFixed(0)} logs/sec (target: 15000/sec) ` +
    `| requests/sec=${result.requests.average.toFixed(1)} | non2xx=${result.non2xx} errors=${result.errors} timeouts=${result.timeouts}`);
  console.log(`GET /logs/aggregate: p50=${aggregateStats.latencyMs.p50?.toFixed(1)}ms ` +
    `p95=${aggregateStats.latencyMs.p95?.toFixed(1)}ms p99=${aggregateStats.latencyMs.p99?.toFixed(1)}ms ` +
    `(n=${aggregateStats.count}, errors=${aggregateStats.errors})`);
  for (const [name, s] of Object.entries(dockerStatsSummary)) {
    console.log(
      `${name}: cpu avg=${s.cpuPercent.avg?.toFixed(1)}% max=${s.cpuPercent.max?.toFixed(1)}% | ` +
        `mem avg=${s.memMiB.avg?.toFixed(1)}MiB max=${s.memMiB.max?.toFixed(1)}MiB`
    );
  }

  if (logsPerSecond < 15000) {
    console.log("\n[run] BELOW TARGET (15000 logs/sec) — diagnose bottleneck");
  }
  if ((aggregateStats.latencyMs.p95 ?? 0) > 1000) {
    console.log("[run] AGGREGATE p95 EXCEEDS 1000ms — diagnose bottleneck");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
