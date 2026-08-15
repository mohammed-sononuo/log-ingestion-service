import type { Pool } from "pg";

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 30);
const RETENTION_CHECK_INTERVAL_MS = Number(process.env.RETENTION_CHECK_INTERVAL_MS ?? 60 * 60 * 1000);

interface ExpiredPartition {
  partition_name: string;
  partition_upper_bound: Date;
}

function cutoffDate(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - RETENTION_DAYS);
  return d;
}

function assertSafePartitionName(name: string): void {
  if (!/^logs_[a-z0-9_]+$/.test(name)) {
    throw new Error(`refusing to drop table with unexpected name: ${name}`);
  }
}

async function findExpiredPartitions(pool: Pool): Promise<ExpiredPartition[]> {
  const { rows } = await pool.query<ExpiredPartition>(
    "SELECT partition_name, partition_upper_bound FROM list_expired_logs_partitions($1::timestamptz)",
    [cutoffDate()]
  );
  return rows;
}

// DETACH PARTITION CONCURRENTLY would be the ideal way to avoid locking the
// parent, but Postgres refuses it whenever a DEFAULT partition exists on the
// table ("cannot detach partitions concurrently when a default partition
// exists") - and logs_default is required so out-of-window inserts never
// fail. So this uses a plain DETACH, which does take an ACCESS EXCLUSIVE
// lock on the parent, but only for the metadata update itself - no row
// scanning happens (the partition is a separate physical file), so the lock
// is held for milliseconds regardless of partition size. DROP TABLE on the
// now-detached table is fully independent of the parent and takes no lock
// on it at all.
async function dropPartition(pool: Pool, name: string): Promise<void> {
  assertSafePartitionName(name);
  await pool.query(`ALTER TABLE logs DETACH PARTITION "${name}"`);
  await pool.query(`DROP TABLE "${name}"`);
}

export async function runRetentionJob(pool: Pool): Promise<void> {
  const cutoff = cutoffDate();
  const expired = await findExpiredPartitions(pool);

  if (expired.length === 0) {
    console.log(
      `[retention] no expired partitions (retention_days=${RETENTION_DAYS}, cutoff=${cutoff.toISOString()})`
    );
    return;
  }

  for (const p of expired) {
    try {
      await dropPartition(pool, p.partition_name);
      console.log(
        `[retention] dropped partition ${p.partition_name} ` +
          `(upper_bound=${p.partition_upper_bound.toISOString()}, retention_days=${RETENTION_DAYS})`
      );
    } catch (err) {
      console.error(`[retention] failed to drop partition ${p.partition_name}`, err);
    }
  }
}

export function startRetentionScheduler(pool: Pool): NodeJS.Timeout {
  runRetentionJob(pool).catch((err) => console.error("[retention] job failed", err));
  return setInterval(() => {
    runRetentionJob(pool).catch((err) => console.error("[retention] job failed", err));
  }, RETENTION_CHECK_INTERVAL_MS);
}
