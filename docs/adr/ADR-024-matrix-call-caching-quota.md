# ADR-024 — Matrix Call Caching and Quota Policy

**Status:** Proposed  
**Decision owner:** `@helphone-maintainers`

## Decision

Matrix routing calls use versioned snapshots and bounded caches. A cache entry is
valid only when its routing snapshot, contract/network revision, and policy
version all match the request. The cache is keyed by those values plus the
normalised request, and entries are evicted by TTL and an explicit byte/count
budget. A cache hit must expose the snapshot version and age to callers.

Each tenant and endpoint has a token bucket. A request consumes quota before a
remote call; cached hits consume the smaller read cost. When a bucket is empty,
the service returns a retry-after value and does not make a remote call. Quota
state is shared through the existing Redis path when available, with a bounded
local fallback for development only.

## Required invariants

- A stale snapshot is never silently served as current data.
- Cache and quota keys contain tenant and policy-version components.
- Eviction is observable through the existing telemetry counters.
- A closure/maintenance overlay invalidates matching entries immediately.
- A local fallback is never used for production deployments.

## Rollout

Ship the policy behind the existing feature flag, measure hit rate, eviction,
quota rejection and stale-snapshot counts, then enable it per environment. The
first implementation should reuse the existing cache/Redis primitives; a new
cache library is not required.
