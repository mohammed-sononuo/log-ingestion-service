import type { FastifyInstance } from "fastify";
import { pool } from "../db";
import { validateBatch, validateLogsQuery, validateAggregateQuery, encodeCursor } from "../validation/logs";
import { insertLogsBulk, queryLogs, cursorFromRow, aggregateLogs } from "../queries/logs";

export async function logsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/logs", async (req, reply) => {
    const body = req.body as { logs?: unknown } | null;

    if (!body || typeof body !== "object" || !Array.isArray(body.logs) || body.logs.length === 0) {
      reply.code(400);
      return { error: "request body must be an object with a non-empty 'logs' array" };
    }

    const result = validateBatch(body.logs);
    const accepted = result.timestamps.length;

    if (accepted > 0) {
      await insertLogsBulk(pool, {
        timestamps: result.timestamps,
        levels: result.levels,
        services: result.services,
        messages: result.messages,
        attributes: result.attributes,
      });
    } else {
      reply.code(400);
    }

    return { accepted, rejected: result.rejected };
  });

  app.get("/logs", async (req, reply) => {
    const validation = validateLogsQuery(req.query as Record<string, unknown>);
    if ("error" in validation) {
      reply.code(400);
      return { error: validation.error };
    }

    const { rows, hasMore } = await queryLogs(pool, validation.filters);

    const logs = rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp.toISOString(),
      level: row.level,
      service: row.service,
      message: row.message,
      attributes: row.attributes ?? {},
    }));

    const next_cursor = hasMore && rows.length > 0 ? encodeCursor(cursorFromRow(rows[rows.length - 1])) : null;

    return { logs, next_cursor };
  });

  app.get("/logs/aggregate", async (req, reply) => {
    const validation = validateAggregateQuery(req.query as Record<string, unknown>);
    if ("error" in validation) {
      reply.code(400);
      return { error: validation.error };
    }

    const rows = await aggregateLogs(pool, validation.filters);

    const buckets = rows.map((row) => ({
      start: row.bucket_start.toISOString(),
      group: row.grp,
      count: Number(row.count),
    }));

    return { buckets };
  });
}
