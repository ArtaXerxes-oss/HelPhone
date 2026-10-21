# Spike #783 — BLE proximity relay (ISP-113): prototype report

## Question

Can a minimal, authenticated offline gossip layer be carried over WebBluetooth, and
what does the beacon format need to guarantee so a spoofed beacon cannot be
forwarded? See [ADR-022](../adr/ADR-022-ble-proximity-relay.md).

## What was built

| Piece | Where |
|---|---|
| Beacon v0 format, signing, fragment/reassemble, verify-before-forward gate, priority queue, bearer policy, `VITE_BLE_GOSSIP` flag | `src/lib/bleRelay.ts` |
| Unit harness (fragmentation, checksum, expiry, signature, replay, dedup, flood, rate limit) | `test/ble-gossip-spike.test.js` |
| Offline-beacon threat model | `docs/security-architecture.md` (annex) |

The prototype is transport-free: it never calls `navigator.bluetooth` and is not wired into `syncManager.ts` or any UI.

## Wire format v0

Fragment: `0x48 | version | index | total | crc32(message) (4 bytes BE) | chunk`.
Message: UTF-8 JSON array `[v, incidentId, geohash, severity, seq, issuedAt, expiresAt, signer, note, sigHex]`.
The Ed25519 signature covers `v|incidentId|geohash|severity|seq|issuedAt|expiresAt|signer|note`.
With the default 20-byte payload each fragment carries 12 bytes of message.

## Gate order

malformed/rate-limit → version → expired → future-dated → TTL → trusted signer → signature → replay/duplicate.
Cheap checks run first; replay state advances only after the signature verifies.

## Not done (no invented numbers)

None of the following was measured or executed. They remain open acceptance criteria of #783:

- Range, throughput, battery, and background/foreground survival on any Android device; iOS disposition table.
- Cross-implementation test vector (dongle-crafted beacon verified by app code).
- Red-team with commodity hardware (spoof, replay, connection-flood, battery drain); only simulated by unit tests.
- Scan duty-cycling and connection-attempt throttling (only a per-source beacon rate limit exists).
- Integration into `syncManager.ts` / `crdt.ts`, `ble-trickle` in `networkEstimator.ts`, telemetry suppression at call sites, queue persistence in `crashRecovery.ts`.
- Station key provisioning/rotation/revocation distribution (`secureStorage.ts`, `keyRotation.ts`).
- HQ-rejoin merge property test; proximity roster / staleness-badge UX.
- Go/no-go scope decision (ADR-022 is Deferred).

## Reproducing

```bash
npx vitest run test/ble-gossip-spike.test.js
```
