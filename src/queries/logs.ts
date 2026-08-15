import type { Pool } from "pg";
import type { Attributes, Cursor, LogsQueryFilters } from "../validation/logs";

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
    params.push(key);
    const keyParam = params.length;
    params.push(value);
    const valueParam = params.length;
    conditions.push(`attributes ->> $${keyParam}::text = $${valueParam}::text`);
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
