# ADR-025 — Liability Sign-off for Triage Shedding

**Status:** Proposed  
**Decision owner:** `@helphone-maintainers`

## Decision

Every production triage-shedding policy must have a signed approval artifact
before it can be enabled. The artifact records the policy identifier and hash,
scope, reviewer identity, approval timestamp, expiry, and rollback owner. CI
requires the artifact for changes to shedding order, queue limits, or protected
traffic classes.

At runtime, the service validates the policy hash and expiry before loading the
policy. Missing, expired, or mismatched approval disables P1–P3 shedding and
fails closed to the protected P0 path. P0 remains available and emits an
operator alert rather than being disabled by a missing administrative artifact.

## Incident and review flow

1. Freeze the policy version and record the incident id.
2. Export the approval artifact, policy hash, and shedding counters.
3. Roll back to the last approved policy; do not edit an approved artifact.
4. Require a new approval for the corrected policy.
5. Review expiry and scope before re-enabling shedding.

Approval files contain no responder or requester PII. CI and runtime logs emit
only the policy id, hash prefix, scope, and reason for rejection.
