-- Lists logs_* partitions whose entire range is older than p_cutoff, so the
-- retention job never touches a partition that still has some data inside
-- the retention window. logs_default is always excluded since it's a
-- catch-all and may mix old and new rows.
CREATE OR REPLACE FUNCTION list_expired_logs_partitions(p_cutoff timestamptz)
RETURNS TABLE(partition_name text, partition_upper_bound timestamptz) AS $$
BEGIN
    RETURN QUERY
    SELECT t.partition_name, t.partition_upper_bound
    FROM (
        SELECT
            child.relname::text AS partition_name,
            (substring(
                pg_get_expr(child.relpartbound, child.oid) FROM 'TO \(''([^'']+)''\)'
            ))::timestamptz AS partition_upper_bound
        FROM pg_inherits
        JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
        JOIN pg_class child ON pg_inherits.inhrelid = child.oid
        JOIN pg_namespace ns ON ns.oid = parent.relnamespace
        WHERE parent.relname = 'logs'
          AND ns.nspname = 'public'
          AND child.relispartition
          AND child.relname <> 'logs_default'
    ) t
    WHERE t.partition_upper_bound <= p_cutoff
    ORDER BY t.partition_upper_bound;
END;
$$ LANGUAGE plpgsql STABLE;
