-- #999: detach expired partitions instead of deleting rows, preserving a
-- documented reversal window and making legal holds enforceable.
ALTER TABLE retention_manifest
  ADD COLUMN IF NOT EXISTS parent_table TEXT,
  ADD COLUMN IF NOT EXISTS partition_bounds TEXT,
  ADD COLUMN IF NOT EXISTS reversible_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_retention_manifest_reversible
  ON retention_manifest (reversible_until) WHERE dropped_at IS NOT NULL;
