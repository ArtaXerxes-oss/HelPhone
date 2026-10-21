-- Retention lifecycle primitives (ISP-128).
-- Adds the legal-hold, erasure-request and retention-manifest tables that the
-- hold-aware maintenance jobs and erasure workflow will read and write.
-- Creation only: no existing table is altered and no rows are touched, so this
-- does not lock hot writes.

CREATE TABLE IF NOT EXISTS legal_holds (
    id           BIGSERIAL PRIMARY KEY,
    scope        TEXT        NOT NULL,
    reason       TEXT        NOT NULL,
    placed_by    TEXT        NOT NULL,
    placed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at  TIMESTAMPTZ
);

-- A hold is active while released_at IS NULL. Partial index keeps the
-- "is this partition held?" check cheap on the maintenance path.
CREATE INDEX IF NOT EXISTS idx_legal_holds_active
    ON legal_holds (scope)
    WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS erasure_requests (
    id            BIGSERIAL PRIMARY KEY,
    person_hmac   TEXT        NOT NULL,
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    status        TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'in_progress', 'complete', 'blocked_by_hold')),
    proof         JSONB
);

CREATE INDEX IF NOT EXISTS idx_erasure_requests_person
    ON erasure_requests (person_hmac);

CREATE TABLE IF NOT EXISTS retention_manifest (
    id            BIGSERIAL PRIMARY KEY,
    partition     TEXT        NOT NULL,
    policy        TEXT        NOT NULL,
    hold_ids      BIGINT[]    NOT NULL DEFAULT '{}',
    anonymized_at TIMESTAMPTZ,
    dropped_at    TIMESTAMPTZ,
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (partition)
);
