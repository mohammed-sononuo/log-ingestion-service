# log-ingestion-service

A high-throughput log ingestion API backed by monthly-partitioned Postgres. Accepts
batched log writes, serves filtered/paginated reads, and provides time-bucketed
aggregation — all under a fixed resource budget (0.5 CPU / 256MB for the app,
1 CPU / 1GB for the database).

## 1. Setup and usage

Requirements: Docker + Docker Compose. Nothing else needs to be installed locally
to run the service.

```bash
docker compose up -d --build
```

This starts two containers:

- **`app`** — Fastify HTTP API on `http://localhost:8080`
- **`db`** — Postgres 16 on `localhost:5433` (mapped from the container's 5432, so
  it doesn't collide with a local Postgres install)

On startup the app:
1. waits for the database to accept connections,
2. applies any pending SQL files in `migrations/` (tracked in a `schema_migrations`
   table, so this is safe to run every boot),
3. pre-creates the next few months of partitions,
4. runs the retention job once, then on a recurring interval (see [§5](#5-retention-strategy)),
5. only then flips `/health` to `200`.

Check it's up:

```bash
curl http://localhost:8080/health
```

Tear down:

```bash
docker compose down        # keeps the pgdata volume
docker compose down -v     # also wipes stored data
```

### Configuration (environment variables)

All variables are read by the `app` service and already have defaults set in
`docker-compose.yml`:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `DATABASE_URL` | `postgres://loguser:logpass@db:5432/logs` | Postgres connection string |
| `PGPOOL_MAX` | `10` | Max connections in the app's `pg.Pool` |
| `RETENTION_DAYS` | `30` | How many days of logs to keep (see [§5](#5-retention-strategy)) |
| `RETENTION_CHECK_INTERVAL_MS` | `3600000` (1h) | How often the retention job re-checks for expired partitions |

Postgres itself is tuned in `docker-compose.yml` via `command:` flags
(`shared_buffers=256MB`, `effective_cache_size=768MB`,
`max_parallel_workers_per_gather=0`) — see [§6](#6-load-test-methodology) for why.

### Local development (without Docker for the app)

```bash
npm install
npm run dev        # tsx watch, needs DATABASE_URL pointing at a running Postgres
```

### Running the retention job manually

```bash
docker compose exec app node dist/scripts/runRetentionOnce.js
# or, from the host with deps installed:
npm run retention:run
```

---

## 2. API documentation

### `GET /health`

Returns `503 { "status": "starting" }` until migrations have finished, then
`200 { "status": "ok" }`. Used as the Docker healthcheck target.

### `POST /logs`

Accepts a batch of log entries. Each entry is validated independently — a bad
entry is rejected without failing the rest of the batch.

**Request body:**

```json
{
  "logs": [
    {
      "timestamp": "2026-08-15T09:00:00.000Z",
      "level": "info",
      "service": "checkout-api",
      "message": "order placed",
      "attributes": { "order_id": "abc-123", "amount": 42.5, "retried": false }
    }
  ]
}
```

| Field | Type | Rules |
|---|---|---|
| `timestamp` | string | ISO 8601, must parse, must not be more than 5 minutes in the future |
| `level` | string | one of `debug`, `info`, `warn`, `error` |
| `service` | string | non-empty |
| `message` | string | non-empty |
| `attributes` | object \| omitted | flat object; values must be `string`, `number`, or `boolean` (no nesting/arrays) |

**Response `200`:**

```json
{ "accepted": 1, "rejected": [] }
```

`rejected` entries include the batch index and a reason string, e.g.
`{ "index": 3, "reason": "invalid level: \"critical\"" }`. If the whole request
body is malformed (`logs` missing/empty/not an array), the response is `400`.

There is no hard cap on batch size in validation, but Fastify's default body
limit (1MB) caps how many entries fit in one request in practice — a batch of
~2000 typically-sized entries is ~400KB.

### `GET /logs`

Filtered, cursor-paginated reads, newest first.

**Query params** (all optional except none are required):

| Param | Notes |
|---|---|
| `service` | exact match |
| `level` | exact match, one of the 4 valid levels |
| `since` / `until` | ISO 8601 timestamp bounds (`since` inclusive, `until` exclusive) |
| `attr.<key>` | exact match against `attributes[key]`, compared as text (see [§8](#8-known-limitations)) |
| `q` | substring match against `message` (case-insensitive) |
| `limit` | 1–1000, default 100 |
| `cursor` | opaque string from a previous response's `next_cursor`, for keyset pagination |

**Response `200`:**

```json
{
  "logs": [
    {
      "id": "50510",
      "timestamp": "2026-08-15T09:00:00.000Z",
      "level": "info",
      "service": "checkout-api",
      "message": "order placed",
      "attributes": { "order_id": "abc-123" }
    }
  ],
  "next_cursor": "eyJ0aW1lc3RhbXAiOi..."
}
```

`next_cursor` is `null` once there are no more matching rows. Pass it back as
`?cursor=...` to get the next page — it encodes `(timestamp, id)` so pagination
stays stable even as new logs are inserted concurrently.

### `GET /logs/aggregate`

Time-bucketed counts, optionally grouped by `service` or `level`.

**Query params:**

| Param | Required | Notes |
|---|---|---|
| `since`, `until` | yes | ISO 8601 bounds |
| `bucket` | yes | one of `1m`, `5m`, `1h`, `1d` |
| `group_by` | no | `service` or `level` |
| `service`, `level`, `attr.<key>`, `q` | no | same filters as `GET /logs` |

**Response `200`:**

```json
{
  "buckets": [
    { "start": "2026-08-15T09:00:00.000Z", "group": "checkout-api", "count": 412 },
    { "start": "2026-08-15T09:00:00.000Z", "group": "auth-svc", "count": 88 }
  ]
}
```

`group` is `null` when `group_by` is omitted. Bucket boundaries are anchored to
a fixed origin (`2000-01-01T00:00:00Z` via Postgres `date_bin`), not to `since`,
so a given bucket always starts at the same instant regardless of the query range.

---

## 3. Schema design

`migrations/001_create_logs_table.sql` defines:

```sql
CREATE TABLE logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY,
    "timestamp" TIMESTAMPTZ NOT NULL,
    level TEXT NOT NULL,
    service TEXT NOT NULL,
    message TEXT NOT NULL,
    attributes JSONB,
    PRIMARY KEY ("timestamp", id),
    ...
) PARTITION BY RANGE ("timestamp");
```

**Why partition by month:** log tables are append-heavy and time-ordered, and
retention deletes are always "everything older than N days." Range-partitioning
on `timestamp` turns retention from an expensive `DELETE` (row-by-row, generates
WAL, needs vacuum, holds locks proportional to row count) into a `DROP TABLE`
on a whole partition (metadata-only, near-instant, reclaims disk immediately —
see [§5](#5-retention-strategy)). It also keeps each partition and its indexes
small enough to fit usefully in memory, and lets Postgres prune partitions
entirely out of a query's scan when the `WHERE` clause implies a time range
(most queries here always filter on `timestamp`).

Month was chosen over day/week as the partition granularity because the
project's retention target is ~30 days: monthly partitions mean retention drops
roughly one partition at a time with limited churn, without creating hundreds
of tiny daily partitions to manage for a one-month-of-data workload.

**Partition management:** `ensure_logs_partition(date)` (a SQL function, also in
the same migration) idempotently creates the partition covering a given month.
`src/migrate.ts` calls it for `[-1, 0, +1, +2]` months relative to "now" on every
app startup — so partitions for the near future always exist before they're
needed, without a cron job or manual DDL. A `logs_default` partition catches
anything outside that pre-created window (e.g. a backfilled log with an old
timestamp) so inserts never fail due to a missing partition.

**Indexes** (created on the parent, auto-applied to every partition):

- `BRIN("timestamp")` — cheap to maintain and cheap to store; effective when
  rows are inserted in roughly timestamp order (true here), since it only needs
  to know each block's min/max timestamp to prune.
- `btree(service, timestamp DESC)`, `btree(level, timestamp DESC)` — serve the
  `service=`/`level=` equality filters on `GET /logs` and `/logs/aggregate`
  while keeping results in the same order the query returns them in.
- `GIN(attributes jsonb_path_ops)` — supports containment queries
  (`attributes @> '{"k":"v"}'`) efficiently. Note this is *not* what
  `attr.<key>=<value>` filtering currently uses — see [§8](#8-known-limitations).

New partitions get `autovacuum_vacuum_scale_factor = 0.02` /
`autovacuum_analyze_scale_factor = 0.01` (vs. Postgres defaults of 0.2/0.1),
since this table has high insert/delete churn (delete via partition drop) and
the default thresholds would let a whole month accumulate before autovacuum
bothers running.

---

## 4. Attribute storage strategy

`attributes` is a single `JSONB` column holding an arbitrary flat map of
`string | number | boolean` values, rather than a normalized entity-attribute-value
(EAV) table (`log_attributes(log_id, key, value)`).

**Why JSONB over EAV:**

- **Insert path stays a single-row, single-statement write.** The bulk insert
  (`INSERT ... SELECT * FROM unnest(...)`) writes one row per log regardless of
  how many attributes it carries. An EAV design would multiply that into N
  extra rows per log (one per attribute), which directly fights the 15k+
  logs/sec ingestion target — more rows, more index maintenance, more WAL, per
  logical log line.
- **No fixed attribute schema.** Callers can send whatever keys make sense for
  their service without a migration or a pre-registered key list, which matches
  how log attributes are actually used in practice (arbitrary, evolving,
  per-service).
- **Reads stay a single-row lookup.** Getting all attributes for a log is
  reading one JSONB value, not aggregating N EAV rows back into a map.

**Trade-offs accepted:**

- **Weaker indexing for per-attribute equality lookups.** A GIN index on JSONB
  can accelerate *containment* (`@>`) well, but the service's current filter
  contract (`attr.<key>=<value>` as an exact, single-key match rendered as
  `attributes ->> key = value`) doesn't use `@>` — see [§8](#8-known-limitations)
  for the specific consequence and what fixing it would look like. An EAV table
  would let you put a plain btree on `(key, value)` and get an efficient index
  seek per attribute, at the cost of the write amplification above.
- **No per-attribute type enforcement.** Validation only checks that each value
  is a string/number/boolean at insert time — nothing stops one service from
  sending `"amount": "42.5"` (string) while another sends `"amount": 42.5`
  (number) for what's conceptually the same field. An EAV table with typed
  columns (or a registered attribute schema) would catch this; JSONB does not.
- **Storage overhead per row** for JSONB's binary format is small but non-zero
  compared to EAV's normalized ints/strings, though this is usually dominated
  by the win of not paying per-attribute row overhead.

Given the throughput target is on the write side and attribute filtering is a
secondary read path, JSONB was the right default for this stage. If attribute
filtering becomes a primary access pattern, the fix is targeted expression
indexes on specific hot keys (`CREATE INDEX ON logs ((attributes ->> 'order_id'))`)
rather than migrating to EAV.

---

## 5. Retention strategy

Implemented in `src/retention.ts` + `migrations/002_retention_function.sql`.

**How it works:**

1. A SQL function, `list_expired_logs_partitions(cutoff)`, inspects
   `pg_inherits`/`pg_class` for every partition of `logs`, parses each
   partition's upper timestamp bound out of its `pg_get_expr(relpartbound, ...)`
   definition, and returns only the partitions whose **entire range** is older
   than the cutoff. `logs_default` is always excluded (it's a catch-all and may
   mix old and new rows, so it's never safe to bulk-drop). A partition that's
   only *partially* past the retention window is left alone — it keeps
   accumulating until the whole month it covers has aged out.
2. `runRetentionJob()` calls that function with `cutoff = now() - RETENTION_DAYS`,
   and for each expired partition: `ALTER TABLE logs DETACH PARTITION "<name>"`
   then `DROP TABLE "<name>"`, logging every drop to the console
   (`[retention] dropped partition logs_2024_01 (upper_bound=..., retention_days=...)`).
3. `startRetentionScheduler()` runs the job once immediately on app startup, then
   on a `setInterval` every `RETENTION_CHECK_INTERVAL_MS` (default 1 hour) — no
   external cron, no manual trigger needed; it comes up automatically with
   `docker compose up`.

**Why `DROP TABLE`, not `DELETE`:** `DELETE FROM logs WHERE timestamp < X` on a
month-old partition would have to visit and mark every matching row individually,
write a WAL record per row, leave the space as bloat until the next `VACUUM`
reclaims it, and hold row-level locks for as long as the scan takes — all
proportional to row count, which at ingestion volumes here could mean tens of
millions of rows. `DROP TABLE` on an already-detached partition is a metadata
operation: it doesn't scan or touch any row, completes in milliseconds
regardless of partition size, and returns the disk space immediately.

**Why `DETACH` before `DROP` (and not `DETACH ... CONCURRENTLY`):** Postgres
refuses `DETACH PARTITION CONCURRENTLY` on any table that has a `DEFAULT`
partition — and `logs_default` is required so out-of-window inserts never fail
outright. A plain (non-concurrent) `DETACH` does take a brief `ACCESS EXCLUSIVE`
lock on the parent `logs` table, but only to update catalog metadata — it
doesn't scan the partition's rows, so the lock is held for milliseconds
regardless of how much data is in the partition being dropped. This was verified
directly: 200 concurrent `POST /logs` requests fired while a retention drop ran
concurrently all completed with `200`, with zero errors or timeouts.

**Configuration:** `RETENTION_DAYS` (default `30`, covers roughly a month of
data) and `RETENTION_CHECK_INTERVAL_MS` (default `3600000`, one hour) are both
plain environment variables — no config file, no redeploy needed to change the
policy beyond restarting the container with a new value.

**Manual run:** `npm run retention:run` (or
`docker compose exec app node dist/scripts/runRetentionOnce.js`) runs the job
once outside the schedule, useful for testing or forcing an immediate cleanup.

---

## 6. Load-test methodology

**Tooling:** [`autocannon`](https://github.com/mcollina/autocannon), run as a
plain devDependency (`npm install --save-dev autocannon`) rather than k6 —
it's a pure-JS HTTP load generator with no separate binary to install, and its
programmatic API made it straightforward to drive from a single orchestrator
script alongside the other measurements (see below).

**Scripts (`loadtest/`):**

- `genBatch.js` — builds one fixed JSON batch of synthetic log entries (varied
  level/service/message/attributes) once per run; the same batch body is reused
  across requests rather than regenerated per-request, since validation has no
  minimum-age check on `timestamp` and regenerating a large batch per request
  would just add client-side overhead unrelated to what's being measured.
- `aggregateLatency.js` — fires `GET /logs/aggregate` once per second for the
  duration of the run (concurrently with the `POST /logs` load), recording
  wall-clock latency per call and computing p50/p95/p99 at the end.
- `dockerStats.js` — polls `docker stats --no-stream` once per second for both
  containers for the duration of the run, tracking min/max/avg CPU% and memory.
- `run.js` — the orchestrator: starts the docker-stats sampler and the
  aggregate probe, runs the `autocannon` POST /logs load, then stops the other
  two and prints/saves a combined JSON report to `loadtest/results/`.

```bash
LOADTEST_DURATION_S=30 LOADTEST_CONNECTIONS=10 LOADTEST_BATCH_SIZE=2000 \
LOADTEST_OVERALL_RATE=9 node loadtest/run.js
```

**Why a steady ~18,000 logs/sec, not client-max throughput:** the first pass
ran `autocannon` uncapped (as many requests as 20 connections could sustain)
and reached **~35,000–40,000 logs/sec** — well over the 15,000/sec target, with
zero failed requests. But `GET /logs/aggregate`, measured concurrently, had a
p95 of **~1.8 seconds**. `EXPLAIN ANALYZE` on the same aggregate query in
isolation (no concurrent load) showed it completes in **~370–490ms** — so the
query plan itself wasn't the problem. The actual cause: the `db` container is
capped at **1 CPU**, and driving ingestion at the client's maximum achievable
rate keeps that single core saturated (measured 83–103% CPU) with insert-side
work (parsing, 4 index updates per row, WAL) — leaving the aggregate scan
competing for time slices on the same one core instead of running uncontended.
Raising `shared_buffers`/disabling parallel workers was tried and measured to
have no material effect on this, because the bottleneck is CPU scheduling
contention between concurrent backends, not buffer misses or query planning.

Since the actual requirement is "≥15,000 logs/sec," not "as fast as the client
can push," the fix was to provision ingestion at a **steady rate with real
margin above the target** (`autocannon`'s `overallRate` option, 9 requests/sec
× 2000-entry batches ≈ 18,000 logs/sec) instead of letting it run at whatever
maximum the client and server could sustain together. This is also the more
realistic scenario for a production deployment sized to a known SLA — you
provision for the target rate plus headroom, not for saturation. At that rate,
the single DB core has enough spare capacity (measured avg 49%, max 78% CPU)
to serve the concurrent aggregate query well under the 1-second target.

The `db` service's `shared_buffers=256MB` / `effective_cache_size=768MB` /
`max_parallel_workers_per_gather=0` tuning (in `docker-compose.yml`) was kept
regardless, as sound practice for a container capped at 1 GB / 1 CPU (Postgres'
own defaults assume the *host's* full memory, not the cgroup limit; parallel
workers just add process-switching overhead when there's no second core to
actually run them on) — but it was **not** the decisive fix; re-measured with
stock Postgres defaults, the throttled ingestion rate alone already met both
targets.

---

## 7. Measured performance results

All runs against the real container limits, verified via
`docker inspect` (`NanoCpus=500000000` / `Memory=268435456` for `app`;
`NanoCpus=1000000000` / `Memory=1073741824` for `db`), starting from an empty
`logs` table each time.

| Metric | Uncapped ingestion (before) | Throttled ~18k/s (after fix) |
|---|---|---|
| `POST /logs` throughput | ~35,500–40,000 logs/sec | **17,804–17,810 logs/sec** |
| Failed requests / timeouts / crashes | 0 | 0 |
| `GET /logs/aggregate` p50 | ~1,078 ms | **442 ms** |
| `GET /logs/aggregate` p95 | ~1,793 ms ❌ (target: <1000ms) | **701 ms** ✅ |
| `GET /logs/aggregate` p99 | ~1,972 ms | **801 ms** |
| `db` container CPU (avg / max) | 83% / 103% | **49% / 78%** |
| `app` container CPU (avg / max) | ~42% / 51% | 18% / 27% |

Both targets — ≥15,000 logs/sec ingestion, <1s aggregate p95, zero failures —
hold simultaneously in the "after" column, with ~19% throughput margin above
the required minimum and real (not saturated) CPU headroom on both containers.

---

## 8. Known limitations

- **`attr.<key>=<value>` filtering does not use the GIN index.** The GIN index
  on `attributes` is built with `jsonb_path_ops`, which only accelerates
  containment queries (`attributes @> '{"key":"value"}'`). The actual query
  built for `attr.<key>=<value>` (in both `GET /logs` and
  `GET /logs/aggregate`) uses `attributes ->> $key = $value` — a text
  extraction + equality comparison, which `jsonb_path_ops` (or `jsonb_ops`)
  cannot serve as an index condition. In practice this means attribute filters
  fall back to scanning whatever rows survive the timestamp/partition/service/level
  filters and checking the attribute in-line, rather than seeking via an index.
  At current data volumes this is masked by partition pruning + the time-range
  filter narrowing the scan first, but it will not scale as a *primary* filter
  on its own. Fixing this for a specific hot key would mean adding a targeted
  expression index, e.g. `CREATE INDEX ON logs ((attributes ->> 'order_id'))`;
  fixing it generically would mean changing the filter contract to containment
  (`@>`) semantics, which the current GIN index already supports.
- **Single DB CPU core is a hard ceiling under combined load.** As documented
  in [§6](#6-load-test-methodology), pushing ingestion to the client's maximum
  achievable rate (~35-40k logs/sec) starves concurrent read queries of CPU
  time on the 1-CPU `db` container. The service handles this correctly (no
  errors, no crashes) but read latency degrades under that specific combination
  of load. This is a resource-provisioning limit, not a code bug — provisioning
  ingestion with headroom above the actual target (as done here) avoids it.
- **No authentication or authorization.** There is no `AUTH_ENABLED` flag or
  any auth middleware in this codebase — every endpoint is open to any client
  that can reach the port. This service assumes it sits behind a trust boundary
  (internal network, gateway, or reverse proxy) that handles authn/z; adding
  it here was out of scope for this stage. See [§9](#9-optional-features).
- **No rate limiting or backpressure on `POST /logs`** beyond what Fastify/Node
  handle by default. A client sending well beyond the tested/tuned throughput
  could still exhaust CPU or memory on the `app`/`db` containers.
- **`logs_default` (the catch-all partition) is never retention-cleaned.** The
  retention job explicitly skips it (its contents may mix old and new rows, so
  bulk-dropping it isn't safe). A client that sends timestamps far outside the
  pre-created partition window (more than 2 months in the future, or older than
  1 month in the past relative to when the partition-creation window last ran)
  will land there, and those rows will accumulate indefinitely unless cleaned
  up separately.
- **No caching on `GET /logs/aggregate`.** Identical repeated aggregate queries
  re-scan the matching partition(s) every time; there's no query-result cache
  or materialized rollup.
- **A failed partition drop is only retried on the next scheduled run**, up to
  `RETENTION_CHECK_INTERVAL_MS` (default 1 hour) later — the error is logged
  and the job moves on to the next partition rather than retrying immediately.

---

## 9. Optional features

None. This stage does not implement authentication, multi-tenancy, alerting,
or any other optional/pluggable feature — the service is intentionally scoped
to ingestion, filtered/paginated reads, aggregation, and retention. There is no
`AUTH_ENABLED` (or similar) flag in the code; every deployment of this service
as-is runs with no access control, and any consumer needs to put it behind a
trust boundary that handles auth before exposing it beyond a private network.
