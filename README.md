# log-ingestion-service

Log ingestion API on Postgres. Accepts batched writes, supports filtered/paginated
reads, and time-bucketed aggregation. Runs under a fixed resource budget: 0.5 CPU /
256MB for the app, 1 CPU / 1GB for the database.

## 1. Setup and usage

Requires Docker + Docker Compose only.

```bash
docker compose up -d --build
```

Starts two containers: `app` (Fastify API, `localhost:8080`) and `db` (Postgres 16,
`localhost:5433`). On boot the app waits for the DB, runs migrations, pre-creates
upcoming partitions, and starts the retention job — `/health` returns `503` until
all of that finishes, then `200`.

```bash
curl http://localhost:8080/health
docker compose down       # -v to also wipe data
```

**Env vars** (defaults already set in `docker-compose.yml`):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://loguser:logpass@db:5432/logs` | DB connection |
| `PGPOOL_MAX` | `10` | max app DB connections |
| `RETENTION_DAYS` | `30` | how long logs are kept |
| `RETENTION_CHECK_INTERVAL_MS` | `3600000` | retention check frequency |

## 2. API

- **`GET /health`** — `503` while starting, `200` once ready.
- **`POST /logs`** — batch insert. Each entry validated independently (bad entries
  are rejected without failing the batch). Rules: `timestamp` ISO 8601, ≤5 min in
  future; `level` one of debug/info/warn/error; `service`/`message` non-empty;
  `attributes` flat object, values string/number/boolean only.
  Returns `{ "accepted": N, "rejected": [{index, reason}] }`, `400` if nothing valid.
- **`GET /logs`** — filters: `service`, `level`, `since`/`until`, `attr.<key>`
  (text match), `q` (substring on message), `limit` (1–1000), `cursor` (keyset
  pagination via `(timestamp, id)`, stable under concurrent inserts).
  Returns `{ logs: [...], next_cursor }`, `null` when done.
- **`GET /logs/aggregate`** — same filters + required `since`/`until`/`bucket`
  (1m/5m/1h/1d) and optional `group_by` (service/level). Returns
  `{ buckets: [{start, group, count}] }`, `group: null` if ungrouped.

## 3. Schema design

`logs` is range-partitioned by month on `timestamp`. This turns retention from a
row-by-row `DELETE` (slow, generates WAL/bloat, locks scale with row count) into a
`DROP TABLE` on a whole partition (metadata-only, near-instant). It also lets
Postgres prune irrelevant partitions from any time-filtered query. Monthly
granularity fits the ~30-day retention target without managing hundreds of daily
partitions. `ensure_logs_partition()` runs on every startup to pre-create the next
few months; `logs_default` catches anything outside that window so inserts never
fail.

**Indexes** (on the parent, inherited by every partition):
- `BRIN(timestamp)` — cheap, effective since inserts are roughly time-ordered
- `btree(service, timestamp DESC)` / `btree(level, timestamp DESC)` — serve the
  equality filters
- `GIN(attributes jsonb_path_ops)` — serves containment (`@>`), which is what
  `attr.<key>` filtering uses (see §8)

## 4. Attribute storage strategy

`attributes` is a single `JSONB` column, not a normalized EAV table
(`log_attributes(log_id, key, value)`). Reasoning: the bulk insert writes one row
per log regardless of attribute count — an EAV table would multiply that to N
rows per log, directly fighting the throughput target. No fixed schema is needed
either, since callers send arbitrary per-service keys.

Trade-off: no type enforcement across services for the same key — the same
attribute name can be a string in one service's logs and a number in
another's. Filtering handles this by OR-ing typed containment variants (see
§8) rather than requiring callers to agree on a type, which is the more
practical fix given attributes are caller-defined and unvalidated across
services.

## 5. Retention strategy

`list_expired_logs_partitions(cutoff)` finds partitions whose entire range is
older than `RETENTION_DAYS` (skipping `logs_default`, which mixes old/new data).
The job then `DETACH`es and `DROP`s each one, logging every drop. Runs once on
startup, then every `RETENTION_CHECK_INTERVAL_MS` (default 1h) — no external cron.

`DROP TABLE` is used instead of `DELETE` because it's a metadata operation
(instant regardless of row count) vs. a row-by-row scan with proportional locking
and bloat. Plain `DETACH` (not `CONCURRENTLY`, which Postgres refuses on tables
with a default partition) takes a brief lock, but it's metadata-only —
verified directly by firing 200 concurrent `POST /logs` requests during a live
partition drop; all returned `200` with no delay.

## 6. Load-test methodology

Used `autocannon` (scripts in `loadtest/`) for local dev-loop iteration —
useful for spot-checking a specific change (e.g. confirming a query now hits
an index, or that a schema change didn't break inserts) but **not a source
for capacity numbers**. Local runs on a dev machine are confounded by host
load in a way that's easy to miss: the same code, same container CPU/memory
limits, and an empty table produced results ranging from ~9,900/s to
~40,000/s across different local passes, entirely as a function of what else
was competing for the host's physical CPU at the time (Docker Desktop's
WSL2 VM contends with everything else running on the machine — including, at
points during this project, the Claude Code session used to drive the tests
itself). Container limits bound what the *containers* can use; they don't
insulate the measurement from *host* contention.

**The authoritative throughput/latency numbers come from the load-gen portal
(`loadgen.foothilltech.net`)**, which runs against isolated infrastructure
matching the stated container limits (0.5 CPU/256MB app, 1 CPU/1GB db)
without host-contention noise. That is the result to cite for this service's
actual capacity — local `autocannon` runs are a debugging tool, not a
benchmark.

## 7. Measured performance results

See the `loadgen.foothilltech.net` benchmark run for this service for the
authoritative throughput and latency numbers against the target (≥15,000/sec
sustained ingestion, aggregate p95 <1s). Local `loadtest/` numbers are
intentionally not reproduced here as performance claims, per §6.

## 8. Known limitations

- **`attr.<key>` filters are index-backed** — the filter compiles to
  `attributes @> {...}` (containment), which the existing
  `GIN(attributes jsonb_path_ops)` index accelerates directly. Confirmed via
  `EXPLAIN ANALYZE`: `Bitmap Index Scan` on the full-range `/logs/aggregate`
  shape; the cursor-paginated `/logs` shape instead gets a backward PK scan,
  which the planner correctly prefers over the GIN index for "latest N
  matching rows" under `ORDER BY ... LIMIT`. One wrinkle: query-string values
  arrive as plain strings, but a stored attribute can be JSON
  string/number/boolean, and `@>` only matches same-type values — so the
  filter ORs containment checks across the plausible typed variants (string,
  plus number/boolean when the value parses as one) to preserve the old
  `->>` comparison's type-agnostic matching.
- **Single DB core is a hard ceiling under combined max load** — ingestion at
  client-max starves concurrent reads of CPU. Resource limit, not a bug;
  avoided here by provisioning ingestion with headroom.
- **No auth, no rate limiting** — every endpoint is open; assumes deployment
  behind a trust boundary that handles access control.
- **`logs_default` is never retention-cleaned** (unsafe to bulk-drop mixed data).
- **No caching on aggregate** — repeated identical queries re-scan every time.
- **A failed partition drop retries only on the next scheduled run** (up to 1h).

## 9. Optional features

None implemented — no auth, multi-tenancy, or rate limiting. `docker compose up`
with no configuration runs the full core service as specified above.