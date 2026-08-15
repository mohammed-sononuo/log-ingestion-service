export const VALID_LEVELS = new Set(["debug", "info", "warn", "error"]);
const MAX_FUTURE_MS = 5 * 60 * 1000;
export const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue>;

export interface RejectedLog {
  index: number;
  reason: string;
}

export interface ValidatedBatch {
  timestamps: string[];
  levels: string[];
  services: string[];
  messages: string[];
  attributes: (Attributes | null)[];
  rejected: RejectedLog[];
}

function validateAttributes(attrs: unknown): string | null {
  if (typeof attrs !== "object" || attrs === null || Array.isArray(attrs)) {
    return "attributes must be a flat object";
  }
  for (const key in attrs as Record<string, unknown>) {
    const value = (attrs as Record<string, unknown>)[key];
    const type = typeof value;
    if (type !== "string" && type !== "number" && type !== "boolean") {
      return `attributes.${key} must be a string, number, or boolean`;
    }
  }
  return null;
}

function validateRecord(record: unknown, nowMs: number): string | null {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return "log entry must be an object";
  }
  const r = record as Record<string, unknown>;

  if (typeof r.timestamp !== "string" || !ISO_8601_RE.test(r.timestamp)) {
    return `invalid timestamp: ${JSON.stringify(r.timestamp)}`;
  }
  const parsed = Date.parse(r.timestamp);
  if (Number.isNaN(parsed)) {
    return `invalid timestamp: ${JSON.stringify(r.timestamp)}`;
  }
  if (parsed - nowMs > MAX_FUTURE_MS) {
    return "timestamp is more than 5 minutes in the future";
  }

  if (typeof r.level !== "string" || !VALID_LEVELS.has(r.level)) {
    return `invalid level: ${JSON.stringify(r.level)}`;
  }

  if (typeof r.service !== "string" || r.service.length === 0) {
    return "service must be a non-empty string";
  }

  if (typeof r.message !== "string" || r.message.length === 0) {
    return "message must be a non-empty string";
  }

  if (r.attributes !== undefined) {
    const attrReason = validateAttributes(r.attributes);
    if (attrReason) return attrReason;
  }

  return null;
}

// Single pass over the batch: each record is validated independently and
// either appended to the accepted columnar arrays or recorded as rejected.
export function validateBatch(records: unknown[]): ValidatedBatch {
  const result: ValidatedBatch = {
    timestamps: [],
    levels: [],
    services: [],
    messages: [],
    attributes: [],
    rejected: [],
  };
  const nowMs = Date.now();

  for (let i = 0; i < records.length; i++) {
    const reason = validateRecord(records[i], nowMs);
    if (reason) {
      result.rejected.push({ index: i, reason });
      continue;
    }
    const r = records[i] as {
      timestamp: string;
      level: string;
      service: string;
      message: string;
      attributes?: Attributes;
    };
    result.timestamps.push(r.timestamp);
    result.levels.push(r.level);
    result.services.push(r.service);
    result.messages.push(r.message);
    result.attributes.push(r.attributes ?? null);
  }

  return result;
}

// --- GET /logs query parsing ---

export interface Cursor {
  timestamp: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { timestamp, id } = parsed as Record<string, unknown>;
  if (typeof timestamp !== "string" || !ISO_8601_RE.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    return null;
  }
  if (typeof id !== "string" || !/^\d+$/.test(id)) return null;
  return { timestamp, id };
}

export interface LogsQueryFilters {
  service?: string;
  level?: string;
  since?: string;
  until?: string;
  attrs: Record<string, string>;
  q?: string;
  limit: number;
  cursor?: Cursor;
}

export type LogsQueryResult = { filters: LogsQueryFilters } | { error: string };

// Query strings can repeat a key ("?level=a&level=b"); Fastify then hands us
// an array. There's no defined semantics for that here, so we just take the
// last occurrence rather than erroring.
function scalar(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.length > 0 ? String(value[value.length - 1]) : undefined;
  if (value === undefined) return undefined;
  return String(value);
}

export function validateLogsQuery(query: Record<string, unknown>): LogsQueryResult {
  const filters: LogsQueryFilters = { attrs: {}, limit: DEFAULT_LIMIT };

  const service = scalar(query.service);
  if (service !== undefined) {
    if (service.length === 0) return { error: "service must not be empty" };
    filters.service = service;
  }

  const level = scalar(query.level);
  if (level !== undefined) {
    if (!VALID_LEVELS.has(level)) return { error: `unsupported level: ${JSON.stringify(level)}` };
    filters.level = level;
  }

  const since = scalar(query.since);
  if (since !== undefined) {
    if (!ISO_8601_RE.test(since) || Number.isNaN(Date.parse(since))) {
      return { error: `invalid timestamp for 'since': ${JSON.stringify(since)}` };
    }
    filters.since = since;
  }

  const until = scalar(query.until);
  if (until !== undefined) {
    if (!ISO_8601_RE.test(until) || Number.isNaN(Date.parse(until))) {
      return { error: `invalid timestamp for 'until': ${JSON.stringify(until)}` };
    }
    filters.until = until;
  }

  if (filters.since !== undefined && filters.until !== undefined) {
    if (Date.parse(filters.until) < Date.parse(filters.since)) {
      return { error: "'until' must not be before 'since'" };
    }
  }

  for (const key of Object.keys(query)) {
    if (!key.startsWith("attr.")) continue;
    const attrKey = key.slice("attr.".length);
    if (attrKey.length === 0) continue;
    const value = scalar(query[key]);
    if (value !== undefined) filters.attrs[attrKey] = value;
  }

  const q = scalar(query.q);
  if (q !== undefined && q.length > 0) filters.q = q;

  const limitRaw = scalar(query.limit);
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(limitRaw)) {
      return { error: "limit must be a positive integer" };
    }
    const limit = Number(limitRaw);
    if (limit < 1 || limit > MAX_LIMIT) {
      return { error: `limit must be between 1 and ${MAX_LIMIT}` };
    }
    filters.limit = limit;
  }

  const cursorRaw = scalar(query.cursor);
  if (cursorRaw !== undefined) {
    const cursor = decodeCursor(cursorRaw);
    if (!cursor) return { error: "invalid cursor" };
    filters.cursor = cursor;
  }

  return { filters };
}
