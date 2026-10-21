# Spike #726: E2E Message Franking — Abuse Reporting Without Breaking Deniability

Refs [#726](https://github.com/Hel-Phone/HelPhone/issues/726).

## 1. Executive Summary

The issue describes a DM pipeline with a Report button whose moderator view
accepts unverifiable pasted plaintext, and an `alertWebhook.ts` that forwards
plaintext excerpts. Against the current `main` the described pipeline does not
exist in that form: `server/lib/alertWebhook.ts` is a one-line placeholder,
`server/routes/wsCluster.js` relays contract events with tenant filters and
carries no per-DM sender/recipient/task logging, and the indexer has no
`dm_reports` projection. `src/lib/crypto.ts` has a complete E2EE envelope
system but, as the issue predicted, **zero franking or commitment
constructions** (`grep frank|commitment src/lib/crypto.ts` → no hits).

This spike therefore ships the hard core the issue asks for first: an
HMAC-commitment franking primitive in `crypto.ts` with key-rotation-safe
`keyId` envelopes, verified by tests (round-trip, fabrication, tamper,
rotation). The escrow/report flow wiring is specced below and left for the
pipeline that grows the DM report feature.

## 2. Construction Chosen

**Symmetric HMAC-commitment franking** (Exp 2, candidate a):

- Sender computes `mac = truncate16(HMAC-SHA256(frankKey, nonce ‖ ciphertext))`
  and attaches `{ keyId, nonce, mac }` to the transmitted envelope.
- Moderator verification: look up `keyId` in the key directory, recompute,
  compare in constant time. Fabricated reports fail deterministically
  (`test/franking-spike.test.js`: wrong key, tampered mac/nonce, mutated
  ciphertext — all rejected; batch checks never throw).

Why not asymmetric (Exp 2, candidate b): Ed25519-over-transcript tags give the
accused a repudiation path only via designated-verifier tricks that are
significantly more complex, and the tag still binds a stable sender key —
the ISP-055 linkage concern. The symmetric+escrow design confines the
per-message linkage to the franking key holder (moderator escrow), matching
the issue's desired end state: verifiable reports without server-side read
access to unreported traffic.

## 3. Deniability Argument (red-team sketch, Exp 5 partial)

- The server never holds `frankKey`; without it, `mac` proves nothing to a
  third party and cannot be forged onto a new ciphertext.
- Non-reported traffic's tags are indistinguishable HMAC values; content
  proof requires the escrow key, which is only opened for explicit reports.
- Residual risk (documented, not closed here): a colluding sender+recipient
  can fabricate "signed" transcripts between themselves — inherent to any
  symmetric scheme; mitigated by moderator escalation flows, not cryptography.

## 4. Key Lifecycle (ties to ISP-054/058)

- `keyId` is embedded in every tag → verification directory maps
  `keyId → key`, old generations retained **read-only** for pre-rotation
  report verification, never used to tag new traffic.
- Test `keyId enables rotation` in `test/franking-spike.test.js` proves
  cross-generation checks fail and historical checks pass.
- Backup/restore (ISP-054): franking keys belong in the moderator escrow,
  **not** in user key backups — user restore must never resurrect escrow
  material.

## 5. Remaining Work (out of scope of this PR)

- Report endpoint wiring: passkey-authenticated `POST /api/dm/report` with
  `(ciphertext, tag, transcript)` → moderator verify → verdict-only audit row.
- `alertWebhook.ts` payload = `{ reportId, severity, taskScope }` only —
  zero excerpts, zero stable DIDs (AC grep test once the pipeline exists).
- Windowed aggregate retention replacing per-message linkage in traces.
- 100/100 red-team drill once the report endpoint exists.
