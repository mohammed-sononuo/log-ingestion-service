const LEVELS = ["debug", "info", "warn", "error"];
const SERVICES = ["checkout-api", "auth-svc", "search-svc", "billing-worker", "notif-svc"];

function makeBatch(size) {
  const logs = [];
  const now = new Date();
  for (let i = 0; i < size; i++) {
    logs.push({
      timestamp: now.toISOString(),
      level: LEVELS[i % LEVELS.length],
      service: SERVICES[i % SERVICES.length],
      message: `load-test message ${i} handling request for user session`,
      attributes: { request_id: `r-${i}`, duration_ms: (i % 500) + 1, retry: i % 7 === 0 },
    });
  }
  return { logs };
}

module.exports = { makeBatch };
