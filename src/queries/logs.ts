import type { Pool } from "pg";
import type { AggregateQueryFilters, Attributes, Cursor, LogsQueryFilters } from "../validation/logs";

// Query-string attr values arrive as plain strings, but the stored attribute
// may be a JSON string, number, or boolean - `@>` containment only matches
// same-type values, unlike the old `->>` text comparison which coerced both
// sides to text. Building one containment object per plausible type (as an
// OR) keeps matching behavior identical while still hitting the GIN index on
// every branch.
function attrContainmentVariants(key: string, value: string): string[] {
  const variants: unknown[] = [value];
  if (value === "true" || value === "false") {
    variants.push(value === "true");
  } else if (/^-?\d+(\.\d+)?$/.test(value)) {
    variants.push(Number(value));
  }
  return variants.map((v) => JSON.stringify({ [key]: v }));
}

export interface InsertLogsInput {
  timestamps: string[];
  levels: string[];
  services: string[];
  messages: string[];
  attributes: (Attributes | null)[];
}

const INSERT_LOGS_SQL = `
  INSERT INTO logs (timestamp, level, service, message, attributes)
  SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::jsonb[])
`;

export async function insertLogsBulk(pool: Pool, input: InsertLogsInput): Promise<void> {
  const attributesJson = input.attributes.map((a) => (a === null ? null : JSON.stringify(a)));
  await pool.query(INSERT_LOGS_SQL, [
    input.timestamps,
    input.levels,
    input.services,
    input.messages,
    attributesJson,
  ]);
}

export interface LogRow {
  id: string;
  timestamp: Date;
  level: string;
  service: string;
  message: string;
  attributes: Attributes | null;
}

// Builds the WHERE clause incrementally so each filter only shows up (and
// only costs a param slot) when the caller actually asked for it.
export function buildLogsQuery(filter: LogsQueryFilters): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.service !== undefined) {
    params.push(filter.service);
    conditions.push(`service = $${params.length}`);
  }

  if (filter.level !== undefined) {
    params.push(filter.level);
    conditions.push(`level = $${params.length}`);
  }

  if (filter.since !== undefined) {
    params.push(filter.since);
    conditions.push(`"timestamp" >= $${params.length}::timestamptz`);
  }

  if (filter.until !== undefined) {
    params.push(filter.until);
    conditions.push(`"timestamp" < $${params.length}::timestamptz`);
  }

  for (const [key, value] of Object.entries(filter.attrs)) {
    const variantConditions = attrContainmentVariants(key, value).map((json) => {
      params.push(json);
      return `attributes @> $${params.length}::jsonb`;
    });
    conditions.push(`(${variantConditions.join(" OR ")})`);
  }

  if (filter.q !== undefined) {
    params.push(filter.q.toLowerCase());
    conditions.push(`strpos(lower(message), $${params.length}::text) > 0`);
  }

  if (filter.cursor !== undefined) {
    params.push(filter.cursor.timestamp);
    const tsParam = params.length;
    params.push(filter.cursor.id);
    const idParam = params.length;
    conditions.push(`("timestamp", id) < ($${tsParam}::timestamptz, $${idParam}::bigint)`);
  }

  params.push(filter.limit + 1);
  const limitParam = params.length;

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT id, "timestamp", level, service, message, attributes
    FROM logs
    ${whereClause}
    ORDER BY "timestamp" DESC, id DESC
    LIMIT $${limitParam}
  `;

  return { sql, params };
}

export interface LogsQueryResult {
  rows: LogRow[];
  hasMore: boolean;
}

export async function queryLogs(pool: Pool, filter: LogsQueryFilters): Promise<LogsQueryResult> {
  const { sql, params } = buildLogsQuery(filter);
  const { rows } = await pool.query<LogRow>(sql, params);
  const hasMore = rows.length > filter.limit;
  return { rows: hasMore ? rows.slice(0, filter.limit) : rows, hasMore };
}

export function cursorFromRow(row: LogRow): Cursor {
  return { timestamp: row.timestamp.toISOString(), id: row.id };
}

export interface BucketRow {
  bucket_start: Date;
  grp: string | null;
  count: string;
}

// date_bin's origin is a fixed reference point, not the query's `since` — this
// keeps bucket boundaries stable (e.g. 1h buckets always land on the hour)
// regardless of what range the caller happens to query.
const BUCKET_ORIGIN = "2000-01-01T00:00:00Z";

export function buildAggregateQuery(filter: AggregateQueryFilters): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  params.push(filter.since);
  conditions.push(`"timestamp" >= $${params.length}::timestamptz`);

  params.push(filter.until);
  conditions.push(`"timestamp" < $${params.length}::timestamptz`);

  if (filter.service !== undefined) {
    params.push(filter.service);
    conditions.push(`service = $${params.length}`);
  }

  if (filter.level !== undefined) {
    params.push(filter.level);
    conditions.push(`level = $${params.length}`);
  }

  for (const [key, value] of Object.entries(filter.attrs)) {
    const variantConditions = attrContainmentVariants(key, value).map((json) => {
      params.push(json);
      return `attributes @> $${params.length}::jsonb`;
    });
    conditions.push(`(${variantConditions.join(" OR ")})`);
  }

  if (filter.q !== undefined) {
    params.push(filter.q.toLowerCase());
    conditions.push(`strpos(lower(message), $${params.length}::text) > 0`);
  }

  params.push(filter.bucketInterval);
  const bucketParam = params.length;
  params.push(BUCKET_ORIGIN);
  const originParam = params.length;

  // groupBy is constrained to the "service" | "level" union by validateAggregateQuery,
  // so this interpolation is over a fixed enum, never raw request input.
  const groupExpr = filter.groupBy === undefined ? "NULL::text" : filter.groupBy;

  const sql = `
    SELECT
      date_bin($${bucketParam}::interval, "timestamp", $${originParam}::timestamptz) AS bucket_start,
      ${groupExpr} AS grp,
      count(*)::bigint AS count
    FROM logs
    WHERE ${conditions.join(" AND ")}
    GROUP BY bucket_start, grp
    ORDER BY bucket_start ASC, grp ASC
  `;

  return { sql, params };
}

export async function aggregateLogs(pool: Pool, filter: AggregateQueryFilters): Promise<BucketRow[]> {
  const { sql, params } = buildAggregateQuery(filter);
  const { rows } = await pool.query<BucketRow>(sql, params);
  return rows;
}
