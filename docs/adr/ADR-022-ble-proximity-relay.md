# ADR-022 — BLE Proximity Relay: Authenticated Beacon Format & Shippable-Scope Decision

**Date:** 2026-10-17
**Status:** Deferred (expires 2027-Q1, owner: @helphone-pwa-owner)
**ISP / Spike:** ISP-113 / #783
**Decision owner:** @helphone-pwa-owner
**Review required:** @helphone-maintainers, @helphone-pwa-owner

---

## Context

When the Wi-Fi island of ISP-112 is unavailable, BLE is the last proximity radio
a responder carries. HelPhone has no BLE path today: `src/lib/webrtc.ts` needs IP
signaling, `src/lib/wsClient.ts` needs `server/routes/wsCluster.js`, and the
`src/lib/syncManager.ts` queue has nowhere to send deltas. Incidents carry
life-safety authority, so a forged "all clear" or "evacuate" beacon is the
dominant risk, ahead of throughput.

This ADR records the part of ISP-113 that can be decided from the repository
alone (wire format, verify-before-forward, bounded ingress) and explicitly defers
the part that needs hardware (range, throughput, battery, iOS disposition, and
the go/no-go on scope). No radio was used to produce it.

---

## Options considered

### Option A — Pure-PWA WebBluetooth relay (Chromium/Android only)

**Description:** GATT client connections from the page via `navigator.bluetooth`.

**Evidence:** Platform limits are documented in the issue and in
[`docs/spikes/783-ble-gossip-report.md`](../spikes/783-ble-gossip-report.md); they
were not re-measured here.

**Pros:** Single release train; no native code.

**Cons:**
- No page-level advertising or background scanning; foreground discipline required.
- iOS Safari has no WebBluetooth, so iOS responders cannot participate.

**Cost / effort:** Not estimated (needs device trials).

### Option B — Gateway-assisted relay

**Description:** Only Chromium devices speak BLE; iOS devices receive beacons through
a nearby gateway over the island Wi-Fi of ISP-112.

**Pros:** Gives iOS responders a defined role. **Cons:** Depends on ISP-112 and a gateway device.

**Cost / effort:** Not estimated.

### Option C — Native BLE companion

**Description:** Native app bridging BLE and the PWA.

**Pros:** Background operation and iOS participation. **Cons:** Second release train and codebase.

**Cost / effort:** Not estimated.

### Option D — Declare BLE out of scope

**Description:** Double down on ISP-112 and station-install discipline.

**Pros:** No new attack surface. **Cons:** Responders with no Wi-Fi remain fully dark.

---

## Decision

**Deferred.** The shippable-scope choice between A–D requires real-radio range,
throughput, battery and background-survival numbers that have not been collected.
Whatever option is chosen, the following are adopted as transport-independent
requirements and prototyped in `src/lib/bleRelay.ts` (flag `VITE_BLE_GOSSIP`, not
wired into `syncManager.ts`):

1. **Verify-before-forward.** A relay forwards a beacon only after version, expiry,
   TTL, trusted-signer and Ed25519 checks pass. Forward-then-verify is rejected
   because it turns one forged beacon into a mesh-wide broadcast.
2. **Station-provisioned trust.** Signers are a pre-distributed key set with
   revocation; there is no server round-trip at verify time.
3. **Bounded lifetimes and replay state.** Beacons live at most 15 minutes, clock
   skew is capped at 30 s, and a per-(signer, incident) monotonic `seq` rejects
   replays and dedups the same beacon heard via several relays.
4. **Sub-MTU framing.** 8-byte fragment header, CRC-32 over the full message,
   bounded reassembly (16 partials, 32 fragments, 2 KiB, 10 s).
5. **Priority ingress and bearer policy.** Severity, then freshness, then fewest
   hops; telemetry and bulk CRDT payloads are embargoed on a `ble-trickle` bearer.

**Gating condition for closing this ADR:** hardware measurements on at least two
Android device classes, the cross-implementation test vector from a dongle-crafted
beacon, and the red-team run in the spike report's "Not done" list.

---

## Consequences

### Subsystems affected

| Subsystem | Impact | Follow-up action | Owner | Due |
|---|---|---|---|---|
| `src/lib/bleRelay.ts` | New flag-gated prototype, no app wiring | Wire ingress into `syncManager.ts` behind `VITE_BLE_GOSSIP` | @helphone-pwa-owner | 2027-Q1 |
| `src/lib/networkEstimator.ts` | No bearer concept yet | Add `ble-trickle` classification | @helphone-pwa-owner | 2027-Q1 |
| `src/lib/secureStorage.ts`, `keyRotation.ts` | Station key provisioning undefined | Define signer key issuance, rotation, revocation distribution | @helphone-maintainers | 2027-Q1 |
| `docs/security-architecture.md` | New offline-beacon threat-model annex | Close residual risks after red-team | @helphone-maintainers | 2027-Q1 |

### Risks

- Beacon signatures use the existing Stellar-strkey Ed25519 helpers; a compact
  binary encoding may be needed once real MTU numbers exist (the JSON message is
  readable, not minimal).
- Replay state is in memory; persistence across reboots (`crashRecovery.ts`) is not implemented.
- Passing unit tests do not demonstrate behaviour over a real radio.

### Follow-up ADRs

- ADR-023 (to be assigned): final scope decision A/B/C/D once measurements exist.

---

## Done-definition checklist

- [x] Status set
- [x] Context names the forcing function
- [x] ≥2 options considered with trade-offs
- [ ] Decision cites evidence (deferred: no hardware evidence yet)
- [x] Consequences table filled
- [x] Added to `docs/adr/README.md` index
- [ ] CODEOWNERS review obtained
