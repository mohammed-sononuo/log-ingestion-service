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
- `GIN(attributes jsonb_path_ops)` — serves containment (`@>`), not currently what
  `attr.<key>` filtering uses (see §8)

## 4. Attribute storage strategy

`attributes` is a single `JSONB` column, not a normalized EAV table
(`log_attributes(log_id, key, value)`). Reasoning: the bulk insert writes one row
per log regardless of attribute count — an EAV table would multiply that to N
rows per log, directly fighting the throughput target. No fixed schema is needed
either, since callers send arbitrary per-service keys.

Trade-off: per-attribute filtering isn't index-backed (GIN here only accelerates
`@>`, not the `->> = ` comparison the filter contract requires), and there's no
type enforcement across services for the same key. Both are acceptable since
write throughput is the primary target and attribute filtering is secondary; the
fix if that changes is a targeted expression index on the hot key, not a
migration to EAV.

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

Used `autocannon` (scripts in `loadtest/`). First pass ran ingestion uncapped and
hit ~35–40k logs/sec — well past the 15k target — but `GET /logs/aggregate` p95
degraded to ~1.8s under that load (vs. ~400ms measured in isolation). Root cause:
the single DB CPU core gets saturated by insert-side work (indexing, WAL) at max
ingestion rate, starving the concurrent aggregate query of CPU time — not a query
or indexing problem. Tuning `shared_buffers`/parallel workers didn't change this
materially.

Since the requirement is "≥15,000/sec sustained," not "client-max," the fix was
throttling ingestion to a steady ~18,000/sec (real margin above target) instead
of saturating the core. This is also the realistic way to provision for a known
SLA. Postgres tuning flags were kept as sound practice for the container size,
but retesting with stock settings confirmed the throttled rate alone was
sufficient — CPU contention was the actual fix, not buffer tuning.

## 7. Measured performance results

| Metric | Uncapped | Throttled ~18k/s |
|---|---|---|
| `POST /logs` throughput | ~35–40k/s | **~17,800/s** |
| Failed requests | 0 | 0 |
| Aggregate p95 | ~1,793ms ❌ | **701ms** ✅ |
| Aggregate p99 | ~1,972ms | **801ms** |
| DB CPU avg/max | 83% / 103% | **49% / 78%** |

Measured against real container limits (verified via `docker inspect`), starting
from an empty table each run. Both targets (≥15,000/sec, aggregate p95 <1s) hold
simultaneously in the throttled configuration, with ~19% throughput margin.

## 8. Known limitations

- **`attr.<key>` filters aren't index-backed** — GIN here only accelerates `@>`
  containment, but the filter is implemented as `attributes ->> key = value`.
  Currently masked by time/partition filtering narrowing the scan first; won't
  scale as a primary filter. Fix: expression index on specific hot keys, or
  switch filter semantics to containment.
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