import { pool } from "../db";
import { runRetentionJob } from "../retention";

runRetentionJob(pool)
  .then(() => pool.end())
  .catch((err) => {
    console.error("[retention] manual run failed", err);
    return pool.end().finally(() => process.exit(1));
  });
