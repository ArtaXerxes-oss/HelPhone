# Spike #729: WebAuthn UV Tiers — Honest Sessions on Shared Devices

Refs [#729](https://github.com/Hel-Phone/HelPhone/issues/729).

## 1. Executive Summary

The issue reports `uv=preferred` silently downgrading the whole auth chain:
UV-less ceremonies accepted as fully authenticated, sessions carrying no
capability tier, and shared-device handoffs leaking keys between operators.
Against current `main` the central server-side defect is **already closed**:
`server/routes/passkey-auth.js` requests `userVerification: 'required'` and
verifies with `requireUserVerification: true` on **both** registration and
login — a UV-less ceremony now fails at verification, never reaches
`issueSession`. `src/lib/secureStorage.ts` is passphrase-keyed AES-GCM with
an explicit `lock()` (per-operator isolation holds when each operator uses
their own passphrase).

What remained missing: sessions carried no UV/capability claim, so audit
could not attribute `(user, uv_tier)` and no middleware could gate sensitive
actions by tier if enforcement ever relaxes to step-up. This spike binds the
UV tier into the session token at every mint/refresh/renew path, with tests.

## 2. Changes Shipped

- `server/lib/session-store.js`: `issueSession` accepts `opts.uv` and embeds
  `uv` in claims (default `true` — sessions are only minted after
  UV-required ceremonies). `renewSessionIfNeeded` preserves the incoming
  tier.
- `server/routes/passkey-auth.js`:
  - `register/verify` → `issueSession(..., { uv: true })` (precondition of
    the `requireUserVerification` gate above it).
  - `login/verify` → `uv` taken from the authenticator's measured answer
    (`authenticationInfo.userVerified`) so the claim stays honest if
    enforcement is ever relaxed to a step-up model.
  - `session/refresh` → preserves `claims.uv` across rotation.
- `test/session-uv-spike.test.js`: default-true, explicit-false preservation,
  refresh preservation, step-up upgrade path.

## 3. Policy Table (current state)

| Action | UV tier required | Enforcement point |
|---|---|---|
| Register / login | `uv=true` (hard) | `requireUserVerification: true` |
| Sensitive API (future gating) | `cap` from `claims.uv` | middleware reads `claims.uv` |
| secureStorage unlock | operator passphrase | PBKDF2-derived key (per-operator) |

## 4. Remaining Work (out of scope of this PR)

- Middleware that returns `403 uv_tier_insufficient` for sensitive endpoints
  when `claims.uv !== true` (only meaningful if `preferred` is ever
  reintroduced for degraded tablets).
- Per-operator IndexedDB namespaces in `secureStorage.ts` (today: one
  passphrase key; a shared-device operator who knows the passphrase reads
  the prior shift's data — the lock-not-wipe compartment work, Exp 2).
- Handoff ceremony UX (Lock button, limited-mode banner, auto-lock timeout).
- `auditStreamer.js` attribution with daily-rotated user pseudonyms
  (`user_hash_per_day, uv_tier, device_class`) — no perpetual join key.
- PRF-less + UV-less combined degraded-mode banner (ISP-054 matrix).
