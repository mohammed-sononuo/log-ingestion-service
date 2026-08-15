CREATE TABLE IF NOT EXISTS logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY,
    "timestamp" TIMESTAMPTZ NOT NULL,
    level TEXT NOT NULL,
    service TEXT NOT NULL,
    message TEXT NOT NULL,
    attributes JSONB,
    PRIMARY KEY ("timestamp", id),
    CONSTRAINT logs_level_check CHECK (level IN ('debug', 'info', 'warn', 'error')),
    CONSTRAINT logs_service_not_empty CHECK (service <> ''),
    CONSTRAINT logs_message_not_empty CHECK (message <> ''),
    CONSTRAINT logs_attributes_is_object CHECK (attributes IS NULL OR jsonb_typeof(attributes) = 'object')
) PARTITION BY RANGE ("timestamp");

-- catch-all so inserts never fail if a partition wasn't pre-created for a given timestamp
CREATE TABLE IF NOT EXISTS logs_default PARTITION OF logs DEFAULT;

-- indexes live on the parent; Postgres auto-creates a matching local index on every partition
CREATE INDEX IF NOT EXISTS idx_logs_timestamp_brin ON logs USING BRIN ("timestamp");
CREATE INDEX IF NOT EXISTS idx_logs_service_ts ON logs (service, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level_ts ON logs (level, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_logs_attributes_gin ON logs USING GIN (attributes jsonb_path_ops);

-- idempotently creates the monthly partition covering p_month, tuned for high insert/delete churn
CREATE OR REPLACE FUNCTION ensure_logs_partition(p_month date) RETURNS void AS $$
DECLARE
    start_date date := date_trunc('month', p_month)::date;
    end_date date := (date_trunc('month', p_month) + interval '1 month')::date;
    partition_name text := 'logs_' || to_char(start_date, 'YYYY_MM');
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF logs FOR VALUES FROM (%L) TO (%L) ' ||
            'WITH (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01)',
            partition_name, start_date, end_date
        );
    END IF;
END;
$$ LANGUAGE plpgsql;
