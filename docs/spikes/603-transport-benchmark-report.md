# Spike #603: Transport Benchmark Report

Supporting data for [ADR-003](../adr/ADR-003-webtransport-vs-websocket.md). Every table below is reproducible with `scripts/spikes/quic_stress_test.js`. Measurement host: Intel i5-4300U, Linux, Node 22.22.2; QUIC stack quinn via `wtransport` 0.7.2.

## What was run, and how much to trust each source

| Source         | Command                          | What it is                                                                                                                                                                                                                                | Trust                                                                                                                                            |
| -------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Live QUIC**  | `quic_stress_test.js live`       | Real quinn WebTransport server and client (`scripts/spikes/webtransport_server`) talking through a user-space UDP proxy that adds 100 ms each way (200 ms RTT) and independent random loss on every datagram, including handshake packets | High for QUIC-vs-QUIC comparisons. It is real loss recovery and congestion control. Loopback timing, not a radio.                                |
| **Simulation** | `quic_stress_test.js sim`        | Discrete-event model of TCP and QUIC sharing loss detection and AIMD. TCP has RACK-TLP plus a 200 ms-floor RTO that collapses cwnd; QUIC has RFC 9002 PTO with two probes and no collapse. Monte Carlo reconnection model.                | Medium. It is the only TCP-vs-QUIC evidence in this spike. Live data showed it gets the value of stream-per-alert only partly right (see below). |
| **Live TCP**   | `sudo quic_stress_test.js netem` | Same harness plus a real TCP push arm, with the link impaired by `tc netem`                                                                                                                                                               | **Not run.** It needs root, which the spike machine did not have. The harness is ready, and this is follow-up item 1.                            |
| **Battery**    | none                             | none                                                                                                                                                                                                                                      | **Not measured.** No physical devices were available. See ADR-003 for the wake-up model and measurement protocol.                                |

"Missed deadline" means an alert not delivered within 2,000 ms, either late or never. It is the report's _dropped frame rate_.

## 1. Live QUIC: stream-per-alert vs one ordered stream

### Surge load: 20 alerts/s, 1 KB each (3 trials × 200 alerts per cell)

| Loss | Arm              | Session setup ms | p50 ms | p95 ms | p99 ms | Missed deadline |
| ---: | ---------------- | ---------------: | -----: | -----: | -----: | --------------: |
|   0% | Stream per alert |              613 |    101 |    102 |    104 |            0.0% |
|   0% | Single stream    |              609 |    100 |    103 |    105 |            0.0% |
|  10% | Stream per alert |              910 |    268 |  1,444 |  2,544 |            2.7% |
|  10% | Single stream    |            1,332 |    266 |  1,393 |  1,629 |            0.0% |
|  20% | Stream per alert |            1,249 |  3,126 |  9,927 | 11,813 |           59.3% |
|  20% | Single stream    |            1,954 |  3,031 |  6,130 |  6,479 |           62.7% |
|  30% | Stream per alert |            1,931 | 16,260 | 38,532 | 41,689 |           91.8% |
|  30% | Single stream    |            3,633 | 10,173 | 27,279 | 29,184 |           91.2% |

### Normal load: 2 alerts/s, 1 KB each (2 trials × 60 alerts per cell)

| Loss | Arm              | Session setup ms | p50 ms | p95 ms | p99 ms | Missed deadline |
| ---: | ---------------- | ---------------: | -----: | -----: | -----: | --------------: |
|  10% | Stream per alert |            1,823 |    101 |    537 |  1,035 |            0.0% |
|  10% | Single stream    |              936 |    101 |    546 |    801 |            0.0% |
|  20% | Stream per alert |              818 |    101 |    801 |  1,272 |            0.0% |
|  20% | Single stream    |            1,429 |    101 |  1,660 |  3,012 |            3.3% |
|  30% | Stream per alert |            3,975 |    698 | 10,591 | 13,389 |           35.8% |
|  30% | Single stream    |           30,405 |    554 |  5,388 |  6,285 |           17.5% |

Only 120 alerts per cell (about 1 minute of traffic). The 30% single-stream setup mean is inflated by one session whose handshake took most of a minute, which is itself a data point about QUIC setup under heavy loss.

### Reading the live results

- **Multiplexing helps only in one band.** At normal load and 20% loss, stream-per-alert halved p95 (801 vs 1,660 ms) and missed no deadlines (vs 3.3%). This is the head-of-line effect the spike was looking for.
  - At surge load it gave no gain.
  - At 30% loss it was _worse_ at both loads (35.8% vs 17.5% missed at 2/s).
  - A likely cause: each alert opens a new stream, and the receiver must grant stream credit (`MAX_STREAMS`). When loss hits those credit frames and the stream FINs, a fresh stream can wait as long as a head-of-line-blocked byte would.
  - Sample sizes are small; treat the direction as reliable and the magnitudes as rough.
- **Above 10% loss, surge load exceeds what congestion control will carry.** At 20 alerts/s, both arms miss the deadline for about 60% of alerts at 20% loss and about 91% at 30%. That is loss-based congestion control throttling throughput below the offered load, and no stream layout fixes it. Session setup time (shown for scale) also grows with loss, from 0.6 s to 1.9–3.6 s.
- Session setup is the full QUIC + TLS + HTTP/3 `CONNECT` exchange, which is 3 RTTs. The 0% value of ~610 ms matches that.

## 2. Simulation: TCP vs QUIC (30 seeds × 30 s of Poisson alerts per cell, 85% 400 B and 15% 3 KB)

| Load | Loss | Transport                      | p50 ms | p95 ms | p99 ms | Missed deadline | Retransmit overhead |
| ---: | ---: | ------------------------------ | -----: | -----: | -----: | --------------: | ------------------: |
|  2/s |  10% | WebSocket / TCP                |    100 |    715 |  1,126 |            0.0% |               12.1% |
|  2/s |  10% | WebTransport, single stream    |    100 |    526 |    778 |            0.0% |               11.5% |
|  2/s |  10% | WebTransport, stream per alert |    100 |    514 |    725 |            0.0% |               11.5% |
|  2/s |  20% | WebSocket / TCP                |    112 |  1,815 |  3,491 |            4.1% |               28.3% |
|  2/s |  20% | WebTransport, single stream    |    100 |    874 |  1,576 |            0.3% |               27.8% |
|  2/s |  20% | WebTransport, stream per alert |    100 |    778 |  1,450 |            0.2% |               27.8% |
|  2/s |  30% | WebSocket / TCP                |    661 |  6,023 | 11,730 |           16.9% |               46.4% |
|  2/s |  30% | WebTransport, single stream    |    300 |  1,689 |  4,009 |            3.2% |               43.4% |
|  2/s |  30% | WebTransport, stream per alert |    100 |  1,400 |  3,599 |            2.6% |               43.4% |
| 10/s |  10% | WebSocket / TCP                |    189 |    839 |  1,438 |            0.3% |               11.6% |
| 10/s |  10% | WebTransport, single stream    |    141 |    700 |  1,016 |            0.0% |               11.5% |
| 10/s |  10% | WebTransport, stream per alert |    100 |    601 |    911 |            0.0% |               11.5% |
| 10/s |  20% | WebSocket / TCP                |    783 |  3,893 |  6,353 |           21.1% |               25.3% |
| 10/s |  20% | WebTransport, single stream    |    548 |  1,928 |  2,859 |            4.6% |               25.3% |
| 10/s |  20% | WebTransport, stream per alert |    367 |  1,763 |  2,727 |            3.6% |               25.3% |
| 10/s |  30% | WebSocket / TCP                | 10,069 | 32,680 | 49,988 |           83.7% |               43.6% |
| 10/s |  30% | WebTransport, single stream    |  2,965 | 13,354 | 22,826 |           62.8% |               42.9% |
| 10/s |  30% | WebTransport, stream per alert |  2,691 | 12,996 | 22,353 |           59.0% |               42.9% |

All arms deliver in 100 ms (one-way delay) at 0% loss; those rows are omitted.

### Reading the simulation

- In the model, almost all of QUIC's advantage comes from **loss recovery**, not multiplexing: compare TCP with single-stream QUIC. TCP's retransmission-timeout path collapses the congestion window and has a 200 ms floor. QUIC's probe timeout does neither.
- The model predicts a uniform 5–15% p95 gain from multiplexing (single stream vs stream-per-alert). **Live, the gain appeared only at normal load with 20% loss**, and reversed at 30%. Do not rely on the model's per-stream numbers.
- Retransmit overhead roughly equals the loss rate for every transport. The extra airtime, and therefore battery, is set by the loss rate, not by the protocol.
- Absolute TCP-vs-QUIC gaps remain unconfirmed until the netem run (follow-up 1).

## 3. Reconnection after a WiFi→LTE switch (simulation, 20,000 trials per cell, RTT 200 ms)

Time from the interface switch to the first alert on the new path. **Detection** is how the client notices:

- `event`: `online` or `navigator.connection` `change` fires, which the transport handles immediately.
- `heartbeat`: no event, so the dead link is only found by the next heartbeat (25 s) plus the pong timeout (10 s).

| Detection | Loss | Path                                                | p50 ms | p95 ms | p99 ms | Jitter (SD) ms |
| --------- | ---: | --------------------------------------------------- | -----: | -----: | -----: | -------------: |
| event     |   0% | WebSocket reconnect (TCP+TLS+Upgrade+resume, 4 RTT) |    825 |    847 |    850 |             14 |
| event     |   0% | WebTransport reconnect (QUIC+CONNECT+resume, 3 RTT) |    625 |    647 |    650 |             14 |
| event     |   0% | QUIC connection migration (best case, 1 RTT)        |    225 |    247 |    250 |             14 |
| event     |  10% | WebSocket reconnect                                 |  1,430 |  3,825 |  5,649 |          1,637 |
| event     |  10% | WebTransport reconnect                              |  1,260 |  3,641 |  7,624 |          1,681 |
| event     |  10% | QUIC connection migration                           |    231 |    868 |  2,111 |            476 |
| event     |  20% | WebSocket reconnect                                 |  2,617 |  9,618 | 19,419 |          4,046 |
| event     |  20% | WebTransport reconnect                              |  2,248 |  8,623 | 19,983 |          6,196 |
| event     |  20% | QUIC connection migration                           |    239 |  2,111 |  4,617 |          2,306 |
| event     |  30% | WebSocket reconnect                                 |  4,839 | 21,635 | 65,042 |         26,641 |
| event     |  30% | WebTransport reconnect                              |  4,226 | 22,974 | 65,430 |         18,692 |
| event     |  30% | QUIC connection migration                           |    827 |  4,608 | 19,580 |          5,563 |
| heartbeat |   0% | WebSocket reconnect                                 | 23,243 | 34,542 | 35,551 |          7,219 |
| heartbeat |   0% | WebTransport reconnect                              | 23,139 | 34,287 | 35,352 |          7,217 |
| heartbeat |  20% | WebSocket reconnect                                 | 25,881 | 37,648 | 45,071 |          8,234 |
| heartbeat |  20% | WebTransport reconnect                              | 25,619 | 37,658 | 46,335 |          9,492 |
| heartbeat |  30% | WebSocket reconnect                                 | 28,936 | 48,156 | 87,997 |         27,737 |
| heartbeat |  30% | WebTransport reconnect                              | 28,487 | 48,962 | 92,519 |         20,034 |

(`sim` also prints heartbeat rows at 10% loss and heartbeat rows for migration; they add nothing beyond the rows above.)

### Reading the reconnection results

- **Detection dominates everything.** Reacting to the network-change event instead of waiting for a heartbeat is worth about 22 s at p50. No protocol choice comes close to that.
- A fresh WebTransport session saves exactly one RTT over WebSocket (3 vs 4 flights). Under loss the gap disappears into retransmission-timer noise, and jitter is similar.
- **Only connection migration changes the picture:** about 10× faster at p50 under loss. Whether browsers migrate WebTransport sessions on an interface change is **not verified**. `networkTransport.js` therefore gives a WebTransport session a 1.5 s grace window to prove it migrated before rebuilding it, and counts `migrationsSurvived` so field telemetry can answer the question.

## Reproduce

```bash
node scripts/spikes/quic_stress_test.js sim --seeds 30
node scripts/spikes/quic_stress_test.js live --trials 3 --n 200                         # 20/s
node scripts/spikes/quic_stress_test.js live --trials 2 --n 60 --interval-ms 500 --loss 0.1,0.2,0.3   # 2/s
sudo node scripts/spikes/quic_stress_test.js netem --trials 3                           # adds the real TCP arm
```
