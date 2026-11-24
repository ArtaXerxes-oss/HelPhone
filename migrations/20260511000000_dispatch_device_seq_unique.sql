-- Dispatch Device Seq Deduplication Migration (ISP-067)
-- Adds unique index concurrently on (device_id, seq) for idempotency without locking tables during disaster peak.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_dispatch_log_device_seq
    ON dispatch_log (device_id, seq)
    WHERE device_id IS NOT NULL AND seq IS NOT NULL;
