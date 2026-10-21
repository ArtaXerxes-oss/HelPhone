-- Checkpoint, Keyset Cursor, and Gap Log Migration (ISP-065)
-- Creates tables and indexes supporting lag-tolerant history reading and exactly-once projection.

CREATE TABLE IF NOT EXISTS dispatch_log (
    id BIGSERIAL PRIMARY KEY,
    op_id VARCHAR(100) NOT NULL,
    doc_id VARCHAR(100) NOT NULL,
    client_id VARCHAR(100) NOT NULL,
    clock BIGINT NOT NULL,
    server_seq BIGINT NOT NULL DEFAULT 0,
    device_id VARCHAR(100),
    seq BIGINT,
    status VARCHAR(50) NOT NULL DEFAULT 'en-route',
    team VARCHAR(100),
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    server_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_log_doc_client_clock
    ON dispatch_log (doc_id, client_id, clock);

CREATE INDEX IF NOT EXISTS idx_dispatch_log_server_seq_id
    ON dispatch_log (server_seq, id);

CREATE INDEX IF NOT EXISTS idx_dispatch_log_created_at
    ON dispatch_log (created_at DESC);

CREATE TABLE IF NOT EXISTS indexer_checkpoint (
    id INT PRIMARY KEY DEFAULT 1,
    last_lsn TEXT NOT NULL DEFAULT '0/0',
    last_seq BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO indexer_checkpoint (id, last_lsn, last_seq) VALUES (1, '0/0', 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS indexer_gap_log (
    id BIGSERIAL PRIMARY KEY,
    doc_id VARCHAR(100) NOT NULL,
    client_id VARCHAR(100) NOT NULL,
    expected_clock BIGINT NOT NULL,
    received_clock BIGINT NOT NULL,
    gap_size INT NOT NULL,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_indexer_gap_doc_client
    ON indexer_gap_log (doc_id, client_id, resolved);
