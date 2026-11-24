# ADR-026 — UV-tier policy for sensitive endpoints

**Date:** 2026-11-22
**Status:** Accepted (enforcement on the protected route and session-bound GraphQL mutations; remaining routes listed below as follow-up)
**ISP / Spike:** ISP-059 / #729, issue #924
**Decision owner:** @helphone-maintainers (proposed under #924; security owner to confirm)
**Review required:** @helphone-maintainers (see `.github/CODEOWNERS`)

---

## Context

`docs/spikes/729-webauthn-uv-tier-report.md` shows that passkey ceremonies
already require user verification (`requireUserVerification: true`). Sessions
carry a `uv` claim (`server/lib/session-store.js`), and `authMiddleware` did not
expose it to request handlers. No middleware could therefore refuse a sensitive
action from a limited (`uv=false`) session. This ADR fixes the tier policy and
the enforcement point.

## Decision

1. A passkey session is **UV-tier** only when its claim is exactly `uv === true`.
   Missing or legacy claims count as UV-less. The check fails closed.
2. A sensitive endpoint responds `403 { "error": "uv_tier_insufficient" }` to a
   UV-less session. Anonymous callers and signature-header callers are not
   session-bound, so this policy does not apply to them. That is an explicit
   gap, listed below.
3. Upgrades do not need re-registration. A UV-verified passkey **login** mints a
   new session with `uv` taken from the authenticator's answer
   (`authenticationInfo.userVerified`). The limited session stays read-only until
   it expires or is revoked.

### Implementation

| Piece | Location |
|---|---|
| Claim carried on the request user | `server/middleware/auth.ts` (`verifyBearerSession`, `uv: claims.uv === true`) |
| Express gate | `server/middleware/uvTier.ts` `requireUvTier` |
| Applied to | `POST /api/protected/action` (`server/index.ts`) |
| GraphQL gate | `server/graphql/resolvers.ts` `assertSessionUvTier` on `assignResponder`, `syncFlush` |
| Tests | `test/uv-tier-gate.test.js` |

## Policy table

| Endpoint / action | UV tier required | Anonymous | Signature headers | Passkey session `uv=false` | Passkey session `uv=true` | Status |
|---|---|---|---|---|---|---|
| `POST /api/protected/action` | yes | 401 (`authMiddleware`) | refused by `requireUvTier` (no UV claim) | 403 `uv_tier_insufficient` | allowed | **enforced** |
| GraphQL `assignResponder` | yes (session callers) | allowed (unchanged) | allowed (unchanged) | 403 `uv_tier_insufficient` | allowed | **enforced for sessions** |
| GraphQL `syncFlush` | yes (session callers) | allowed (field sync path) | allowed (unchanged) | 403 `uv_tier_insufficient` | allowed | **enforced for sessions** |
| `POST /api/dispatch/*` (`/`, `/:id/assign`, `/:id/ack`, `/sos`, `/keys`, `/payload/:id`) | proposed: yes | allowed today | allowed today | not enforced | not enforced | **follow-up** |
| `POST /api/federation/dispatch`, `/settlement`, `/ack`, `/sync`, `/trust-bundle/gossip` | proposed: yes | allowed today | allowed today | not enforced | not enforced | **follow-up** |
| `POST /api/sync/*` (peer deltas, flush) | proposed: yes | allowed today | allowed today | not enforced | not enforced | **follow-up** |

The **follow-up** rows are not gated in this change because the field clients
call them anonymously. Gating them would stop SOS intake and offline sync at the
moment they are needed. They move to `uv=true` only after a session-attaching
client ships and the anonymous path is retired.

## Consequences

- A limited session can still read and renew, and can still log out. It cannot
  run the enforced sensitive actions. Re-verifying with a passkey gives a new
  `uv=true` session without re-registration.
- Signature-header auth has no UV claim. It is refused on
  `/api/protected/action` and unchanged on the GraphQL mutations. Giving device
  keys a UV-equivalent tier is a separate decision.
- The policy table is the source of truth. A new sensitive route must add a row
  here in the same PR as the `requireUvTier` mount.

## Refs

- `docs/spikes/729-webauthn-uv-tier-report.md` (remaining work, policy table)
- `docs/adr/ADR-016-attestation-cryptography.md`
