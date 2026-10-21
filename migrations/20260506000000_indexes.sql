-- Composite indexes for the most frequent search/filter queries.
-- Added per issue #561 (index optimization & duplicate cleanup).

-- Active help requests filtered by status, sorted by recency.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_requests_status_created_at
  ON requests (status, created_at DESC);

-- Responder lookups scoped to a single request.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_responders_request_id_arrived
  ON responders (request_id, arrived);

-- Expert verification history lookups by wallet, most recent first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_verifications_wallet_recorded_at
  ON expert_verifications (wallet, recorded_at DESC);
