# Spike #719 (ISP-049): WebRTC / COOP+COEP / background kill / dispatch audio

Status: **partial**. This report records what was checked against the code, one
experiment, and one fix. The device-lab work the issue asks for is not done (see
"Not done").

## 1. Claims in the issue, checked against the repository

Every row below was checked with `grep` or by reading the file, at commit `f87269c`.

| Claim in the issue | What the repository shows |
|---|---|
| `server/middleware/csp.ts` emits `COOP: same-origin` + `COEP: credentialless` | **No.** `csp.ts` sets neither. The headers are set in `vite.config.ts` (`server.headers` and `preview.headers`), and `test/coep-headers-spike.test.js` asserts they also appear in `server/index.ts`. |
| `webrtc.ts` allocates TURN at `turn:turn.helphone.org:3478` with credentials from `server/routes/turn-credentials` | **No.** `src/lib/webrtc.ts` is 27 lines: a one-shot ICE benchmark using STUN only (`stun.l.google.com`, `stun.cloudflare.com`). There is no `turn:` URL, no credentials route (the path does not exist) and no coturn config anywhere in the repo. |
| `iceCandidatePoolSize: 10` | The only value in the repo is `2` (in that benchmark). |
| `iceConnectionState` flips to `disconnected` with no resurrection | `iceConnectionState` is not used anywhere in `src/` or `server/`. There is no long-lived peer connection to lose. |
| COEP blocks TURN allocation, so calls fall back to host/STUN | **Not supported by the experiment in section 2** (UDP relay connects under COEP). |
| Reconnect needs jittered backoff | Already implemented: `src/lib/wsClient.ts` does exponential backoff with up to 50% jitter. |
| Web Push wake path | Not present (no `pushManager`, VAPID or `push` handler). Not built here. |
| Battery-aware policy | Partly present: `src/services/networkTransport.js` already reads `navigator.getBattery`. No NAT-type policy table exists. |
| `test/audio-alert.test.js` is green | **It was failing on `main`.** vitest 4 cannot `new` an arrow-function mock, so both tests threw "is not a constructor". Fixed in this PR. |
| `audioAlert.ts` has no autoplay unlock | It has `unlock()`, but nothing ever called it, and `play()` could hang forever (section 3). |

## 2. Experiment: does COOP/COEP block TURN relay in a real browser?

`scripts/spikes/webrtc_coep_turn_experiment.mjs` starts a real TURN server
(`node-turn`, loopback) and serves a page under three header sets. In Chrome it
opens two `RTCPeerConnection`s with `iceTransportPolicy: 'relay'`, so a data
channel can open only if the TURN allocation succeeds and traffic is relayed.

Run on Chrome 155.0.8059.80 (macOS), 10 runs per row. Raw data:
`docs/spikes/results/webrtc-coep-turn.json`.

| Headers | TURN transport | crossOriginIsolated | Connected | Via relay pair | Median connect |
|---|---|---|---|---|---|
| none (control) | UDP | false | 10/10 | 10/10 | 167 ms |
| COOP same-origin + COEP credentialless (the repo's config) | UDP | true | **10/10** | 10/10 | 252 ms |
| COOP same-origin + COEP require-corp | UDP | true | **10/10** | 10/10 | 169 ms |
| all three | TCP | – | 0/10 | 0/10 | – |

**Reading the result.**

- Over UDP, cross-origin isolation did **not** stop relay allocation or media
  flow, including with the repo's exact headers. This matches how the browser
  works: COEP/CORP govern HTTP resource loads, and ICE/TURN traffic is not an
  HTTP fetch, so a TURN 401 has no `CORP` header to be missing.
- The **TCP rows are inconclusive, not evidence of a COEP effect**. They fail
  identically in the no-headers control, so the cause is this local TURN setup
  (`node-turn` over TCP with Chrome), not the headers.
- If production calls fail to connect, the cause is more likely elsewhere:
  no TURN server is configured at all today (section 1), or the credential
  `fetch()` (which *is* an HTTP request and *would* be subject to COEP/CORS if it
  were cross-origin) is what fails. Keeping that endpoint same-origin avoids it.

**Limits.** One machine, one browser, loopback only. This shows what the
headers do to relay allocation. It does not emulate carrier NATs, Safari/Firefox,
or `turns:` (TLS).

## 3. Fix: `EmergencyAudioAlert` could hang silently when autoplay is blocked

`play()` awaited `AudioContext.resume()`. When the browser's autoplay policy
blocks audio, that promise stays pending forever (it neither resolves nor
rejects), so a siren triggered without a recent user gesture hung, made no sound,
and recorded nothing. `unlock()` existed but was never called.

Changes (`src/lib/audioAlert.ts`, `src/lib/telemetry.ts`, `src/pages/Help.tsx`):

- `play()` waits at most `RESUME_TIMEOUT_MS` (1 s). If the context is still not
  running it vibrates (`[500, 250, 500]`, best effort) and returns `'blocked'`
  instead of hanging; otherwise it returns `'played'`.
- `unlock()` now reports whether the context is running.
- `armOnFirstGesture()` unlocks audio on the first user gesture so a later
  gesture-less alert can sound. `Help.tsx` arms it on mount.
- `trackAudioAlert('played' | 'blocked', { fallback })` emits an `audio.alert`
  span, so the blocked rate is `blocked / (played + blocked)`. `getStats()` exposes
  the same counts locally.
- The "Test siren" button now says when sound is blocked instead of claiming it played.

Tests: `test/audio-alert.test.js` (10 tests; 9 fail on the old code).

## 4. Not done

Needs a real TURN deployment, devices or product decisions, so not attempted:

- TURN credential proxy / per-call ephemeral credentials (there is no TURN server to proxy yet).
- Web Push wake path (VAPID keys, `server/routes/push`, service-worker `push` handler, permission UX).
- NAT-type × battery × network policy table and the Moto G measurements behind it.
- Playwright `webrtc-nat` and `background-kill` projects; background-kill drills on locked phones.
- `ice*` / `turn401` / `wsReaped` / `pushDelivered` metrics, dashboards and alerts in `server/middleware/metrics.ts`.
- NAT-mix and background-churn peers in `server/tests/load.js`.
- Rejoin allowlist in `rateLimiter.ts`; reap timing in `keepAlive`; `crashRecovery.ts` (not examined).
- The ops runbook in `docs/webrtc-architecture.md`.
