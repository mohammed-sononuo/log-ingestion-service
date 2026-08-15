import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const PARTITION_WINDOW_MONTHS = [-1, 0, 1, 2]; // previous month + current + 2 ahead

async function waitForDb(pool: Pool, retries = 20, delayMs = 1000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations(pool: Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ name: string }>("SELECT name FROM schema_migrations");
  return new Set(rows.map((r) => r.name));
}

async function applyPendingMigrations(pool: Pool): Promise<void> {
  const applied = await appliedMigrations(pool);
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`applied migration ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

// Runs every startup (not a versioned migration) so future months keep getting
// partitions pre-created without needing a new migration file each month.
async function ensurePartitionWindow(pool: Pool): Promise<void> {
  for (const offset of PARTITION_WINDOW_MONTHS) {
    await pool.query(
      "SELECT ensure_logs_partition((date_trunc('month', now()) + ($1 || ' month')::interval)::date)",
      [offset]
    );
  }
}

export async function runMigrations(pool: Pool): Promise<void> {
  await waitForDb(pool);
  await ensureMigrationsTable(pool);
  await applyPendingMigrations(pool);
  await ensurePartitionWindow(pool);
}
