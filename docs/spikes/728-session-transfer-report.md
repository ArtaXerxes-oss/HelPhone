# Spike #728: Cross-Device Session Transfer — Generation Semantics

Refs [#728](https://github.com/Hel-Phone/HelPhone/issues/728).

## 1. Executive Summary

The issue reports a QR session-copy flow that clones responders across
devices: presence flaps between replicas under one DID, dispatch double-books
humans, and photographed QR bundles create unrevocable clones. Against
current `main` the described QR transfer flow and per-DID presence system do
not exist: `src/lib/sessionKey.ts` is a non-extractable ECDH session-key
manager with auto-burn (no transfer, no generation, no device id),
`server/routes/wsCluster.js` is a tenant-filtered contract-event relay with a
`peer-relay` envelope type and no presence registry, and `Help.jsx` has no
transfer UI.

This spike ships the ownership core every transfer design needs: a
**single-use, expiring transfer ticket with explicit generation semantics**
in `sessionKey.ts`. Redeeming mints generation N+1 for the destination;
replays fail `already_redeemed`; expired tickets fail `expired`. Tests cover
the full redeem/replay/expiry/malformed matrix.

## 2. Design: Serverless-First Ticket, Reconcile Later

Exp 2's decision matrix pits server-mediated moves (needs connectivity at
transfer time — rare at field posts) against offline pre-authorized tickets.
This spike implements the ticket half: the source device signs/mints a
ticket bound to `(sessionId, generation, deviceId)` with a 90s TTL and a
single-use `ticketId`. The redemption set is process-local today; the runbook
below defines how a WS cluster promotes it to a Redis mark-and-sweep when the
presence layer lands.

State machine (target, partially shipped):

```
gen N (source, dispatchable)
  ──createTransferTicket──► ticket(N, TTL 90s)
  ──redeem on device B──► gen N+1 (dispatchable) ; gen N revoked → read-only
  ──replay ticket──► already_redeemed (no clone)
  ──expired ticket──► expired (re-mint required)
```

## 3. Grace Drain Note (not shipped)

The revoked generation keeps a grace window to drain its outbox without new
claims (AC: ISP-052 race not reintroduced). Draining requires the outbox
layer (`src/features/help/*`) to gate new claims on the active generation —
does not exist yet; tracked as remaining work.

## 4. Remaining Work (out of scope of this PR)

- QR UI in Help.jsx wrapping `createTransferTicket`/`redeemTransferTicket`
  with pairing-code ceremony (Exp 4: PAKE vs numeric compare).
- Presence single-winner enforcement in `wsCluster.js`/`redisPubSub.js`:
  heartbeat carries generation; stale generation → `stale_device` read-only;
  deterministic first-redeem tiebreak replicated across replicas (Exp 3).
- Redis-backed redeemed-ticket set (mark-and-sweep) for cluster-wide
  single-use.
- `CommunityMap.jsx` one-pin-per-DID + clone-attempt alerts via
  `auditStreamer.js`/`alertWebhook.ts`.
- `keyBackup.ts` restore mints a fresh generation (never resurrects revoked).
- CI test `session-clone-split-brain` gating dual-dispatch regressions.
