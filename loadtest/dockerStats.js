const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

const CONTAINERS = ["log-ingestion-service-app-1", "log-ingestion-service-db-1"];

function parsePercent(s) {
  return parseFloat(String(s).replace("%", ""));
}

function parseMemUsageMiB(s) {
  const used = String(s).split("/")[0].trim();
  const m = /^([\d.]+)\s*(GiB|MiB|KiB|B)$/i.exec(used);
  if (!m) return NaN;
  const val = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "gib") return val * 1024;
  if (unit === "mib") return val;
  if (unit === "kib") return val / 1024;
  return val / (1024 * 1024);
}

async function sampleOnce() {
  const { stdout } = await execFileAsync("docker", [
    "stats",
    "--no-stream",
    "--format",
    "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}",
    ...CONTAINERS,
  ]);
  const out = {};
  for (const line of stdout.trim().split("\n")) {
    const [name, cpu, mem] = line.split("\t");
    if (!name) continue;
    out[name] = { cpuPercent: parsePercent(cpu), memMiB: parseMemUsageMiB(mem) };
  }
  return out;
}

// Polls `docker stats` on an interval until stop() is called. Returns per-container
// min/max/avg for cpu% and mem so we can see peak resource usage during the run,
// not just a single point-in-time snapshot.
function startSampler(intervalMs = 1000) {
  const samples = { };
  for (const c of CONTAINERS) samples[c] = { cpu: [], mem: [] };

  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        const snap = await sampleOnce();
        for (const c of CONTAINERS) {
          if (snap[c]) {
            samples[c].cpu.push(snap[c].cpuPercent);
            samples[c].mem.push(snap[c].memMiB);
          }
        }
      } catch (err) {
        console.error("[docker-stats] sample failed", err.message);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  const runner = loop();

  return {
    stop: async () => {
      stopped = true;
      await runner;
      const summary = {};
      for (const c of CONTAINERS) {
        const cpu = samples[c].cpu;
        const mem = samples[c].mem;
        summary[c] = {
          samples: cpu.length,
          cpuPercent: {
            min: cpu.length ? Math.min(...cpu) : null,
            max: cpu.length ? Math.max(...cpu) : null,
            avg: cpu.length ? cpu.reduce((a, b) => a + b, 0) / cpu.length : null,
          },
          memMiB: {
            min: mem.length ? Math.min(...mem) : null,
            max: mem.length ? Math.max(...mem) : null,
            avg: mem.length ? mem.reduce((a, b) => a + b, 0) / mem.length : null,
          },
        };
      }
      return summary;
    },
  };
}

module.exports = { startSampler };
