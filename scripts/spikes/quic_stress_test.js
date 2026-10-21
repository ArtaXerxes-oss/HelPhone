#!/usr/bin/env node
// Spike #603 — WebSocket (TCP) vs WebTransport (QUIC/HTTP3) alert delivery
// under 200 ms RTT and 10–30% packet loss.
//
// PROTOTYPE: to be discarded once ADR-003 is accepted.
//
//   node scripts/spikes/quic_stress_test.js sim   [--seeds 30] [--json]
//       Discrete-event model of alert streams over TCP and QUIC, plus a Monte
//       Carlo of reconnection after a WiFi→LTE switch. No privileges needed.
//
//   node scripts/spikes/quic_stress_test.js live  [--trials 3] [--n 200] [--interval-ms 50] [--json]
//       Real QUIC (quinn via wtransport, scripts/spikes/webtransport_server)
//       through an in-process UDP proxy that adds delay and random loss.
//       Compares stream-per-alert vs one ordered stream on the same stack.
//       Builds the Rust binary on first use (cargo required). No root needed.
//
//   sudo node scripts/spikes/quic_stress_test.js netem [--dev lo] [--trials 3]
//       Applies `tc qdisc ... netem delay 100ms loss X%` to the device (both
//       directions on lo → 200 ms RTT) and runs the live QUIC arms *and* a
//       real TCP arm (framed push, i.e. WebSocket-over-TCP semantics without
//       the HTTP upgrade). Requires root; removes the qdisc on exit.
//
// Common: --rtt 200 --loss 0,0.1,0.2,0.3 --deadline 2000

import { spawn, spawnSync } from "node:child_process";
import dgram from "node:dgram";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CRATE = join(HERE, "webtransport_server");
const BIN = join(CRATE, "target", "release", "wt-spike");

const argv = process.argv.slice(2);
const MODE = argv[0] && !argv[0].startsWith("--") ? argv[0] : "sim";
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const RTT = Number(opt("rtt", 200));
const LOSSES = String(opt("loss", "0,0.1,0.2,0.3")).split(",").map(Number);
const DEADLINE = Number(opt("deadline", 2000));
const JSON_OUT = argv.includes("--json");

// ── shared helpers ────────────────────────────────────────────────────────────

/** mulberry32: small, fast, seedable PRNG so every run is reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function summarize(latencies, total, deadline = DEADLINE) {
  const s = [...latencies].sort((a, b) => a - b);
  const late = s.filter((l) => l > deadline).length;
  return {
    p50: percentile(s, 0.5),
    p95: percentile(s, 0.95),
    p99: percentile(s, 0.99),
    max: s[s.length - 1] ?? NaN,
    // "Dropped frame": an alert not delivered within the deadline (late or never).
    missRate: (late + (total - s.length)) / total,
  };
}

const f0 = (v) =>
  Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "n/a";
const pct = (v) => `${(v * 100).toFixed(1)}%`;

// ── discrete-event transport model ────────────────────────────────────────────
//
// Both transports share: per-packet Bernoulli loss in both directions (data and
// ACKs), SACK/ACK-range style acknowledgement of every received packet, RACK /
// RFC 9002 loss detection (3-packet or 9/8·RTT threshold), NewReno-style
// AIMD congestion control with one reduction per recovery epoch.
// They differ only where the protocols differ:
//   * delivery order: TCP releases bytes to the app strictly in order, so one
//     lost segment stalls every later alert (head-of-line). QUIC stream-per-
//     alert releases each alert when its own packets are complete.
//   * retransmission timer: TCP first sends one RACK-TLP probe at 2·srtt, then
//     RTO = srtt + max(200 ms, 4·rttvar) (Linux floor), which collapses cwnd
//     to 1 MSS and presumes all outstanding data lost; QUIC PTO = srtt + 4·rttvar + 25 ms
//     max_ack_delay, sends two probes, and leaves cwnd alone (RFC 9002 §6.2).
// Not modelled: pacing, ECN, delayed ACKs, receive windows. All of these apply
// equally to both transports, so leaving them out does not change the comparison.

const MSS = 1200;

function workload(seed, { rate = 10, seconds = 30 } = {}) {
  const r = rng(seed);
  const alerts = [];
  let t = 0;
  while (t < seconds * 1000) {
    t += (-Math.log(1 - r()) / rate) * 1000; // Poisson arrivals
    // 85% compact alerts (~400 B JSON), 15% rich alerts (location trail, 3 KB).
    alerts.push({ t, size: r() < 0.85 ? 400 : 3000 });
  }
  return alerts;
}

class Heap {
  constructor() {
    this.a = [];
  }
  push(e) {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].t <= e.t) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = e;
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && a[c + 1].t < a[c].t) c++;
        if (a[c].t >= last.t) break;
        a[i] = a[c];
        i = c;
      }
      a[i] = last;
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

/**
 * @param {{transport:'tcp'|'quic', ordering:'stream'|'multiplexed', rtt:number, loss:number, seed:number}} cfg
 */
export function simulateAlertStream(cfg) {
  const { transport, ordering, rtt, loss, seed } = cfg;
  const r = rng(seed * 7919 + Math.round(loss * 1000));
  const owd = rtt / 2;
  const alerts = cfg.alerts ?? workload(seed, { rate: cfg.rate ?? 10 });

  const units = []; // one entry per MSS-sized chunk: { alert, bytes }
  const unitsLeft = alerts.map((a) => Math.ceil(a.size / MSS));
  const delivered = new Array(alerts.length).fill(null);
  const unitReceived = [];

  const q = new Heap();
  alerts.forEach((a, i) => q.push({ t: a.t, kind: "gen", alert: i }));

  const sendQueue = []; // unit ids awaiting (re)transmission, retransmissions first
  const inflight = new Map(); // pkt -> { unit, sentAt }
  let inflightBytes = 0;
  let pktSeq = 0;
  let firstSends = 0;
  let retransmits = 0;
  const everSent = [];
  // Congestion window in bytes (initial window 10·MSS, floor 2·MSS), as both
  // Linux TCP and RFC 9002 count it.
  let cwnd = 10 * MSS;
  let ssthresh = Infinity;
  let recoveryStart = -1;
  let srtt = rtt;
  let rttvar = rtt / 2;
  let backoff = 0;
  let timerAt = Infinity;
  let largestAcked = -1;
  let nextInOrder = 0;
  const arrivedAt = new Map(); // pkt -> arrival time at receiver

  let tlpArmed = true; // TCP: one Tail Loss Probe before falling back to RTO
  const timeoutMs = () =>
    transport === "tcp"
      ? tlpArmed
        ? 2 * srtt // RACK-TLP probe timeout (Linux default since 3.10)
        : srtt + Math.max(200, 4 * rttvar)
      : srtt + Math.max(1, 4 * rttvar) + 25;

  function armTimer(now) {
    if (inflight.size === 0) {
      timerAt = Infinity;
      return;
    }
    timerAt = now + timeoutMs() * 2 ** backoff;
    q.push({ t: timerAt, kind: "timer", at: timerAt });
  }

  const forget = (pkt, info) => {
    inflight.delete(pkt);
    inflightBytes -= units[info.unit].bytes;
  };

  function trySend(now) {
    while (
      sendQueue.length &&
      inflightBytes + units[sendQueue[0]].bytes <= Math.max(cwnd, MSS)
    ) {
      const unit = sendQueue.shift();
      if (unitReceived[unit]) continue; // already delivered via an earlier copy
      const pkt = pktSeq++;
      if (everSent[unit]) retransmits++;
      else {
        everSent[unit] = true;
        firstSends++;
      }
      inflight.set(pkt, { unit, sentAt: now });
      inflightBytes += units[unit].bytes;
      if (r() >= loss) q.push({ t: now + owd, kind: "arrive", pkt, unit });
      if (timerAt === Infinity) armTimer(now);
    }
  }

  function deliverReady(now) {
    if (ordering === "stream") {
      while (
        nextInOrder < alerts.length &&
        unitsLeft[nextInOrder] === 0 &&
        alerts[nextInOrder].t <= now
      ) {
        delivered[nextInOrder] = now - alerts[nextInOrder].t;
        nextInOrder++;
      }
    }
  }

  function onCongestion(now, sentAt) {
    if (sentAt <= recoveryStart) return; // one reduction per epoch
    recoveryStart = now;
    ssthresh = Math.max(2 * MSS, cwnd / 2);
    cwnd = ssthresh;
  }

  const horizon = alerts[alerts.length - 1].t + 60_000;
  while (q.size) {
    const ev = q.pop();
    const now = ev.t;
    if (now > horizon) break;

    if (ev.kind === "gen") {
      const size = alerts[ev.alert].size;
      const n = Math.ceil(size / MSS);
      for (let k = 0; k < n; k++) {
        units.push({ alert: ev.alert, bytes: Math.min(MSS, size - k * MSS) });
        sendQueue.push(units.length - 1);
      }
      trySend(now);
    } else if (ev.kind === "arrive") {
      arrivedAt.set(ev.pkt, now);
      if (!unitReceived[ev.unit]) {
        unitReceived[ev.unit] = true;
        const a = units[ev.unit].alert;
        unitsLeft[a]--;
        if (ordering === "multiplexed" && unitsLeft[a] === 0)
          delivered[a] = now - alerts[a].t;
        deliverReady(now);
      }
      // ACK for everything received so far (SACK blocks / QUIC ACK ranges).
      if (r() >= loss) q.push({ t: now + owd, kind: "ack", upTo: now });
    } else if (ev.kind === "ack") {
      let newlyAcked = false;
      let largestNew = -1;
      for (const [pkt, info] of inflight) {
        const at = arrivedAt.get(pkt);
        if (at !== undefined && at <= ev.upTo) {
          forget(pkt, info);
          newlyAcked = true;
          if (pkt > largestNew) largestNew = pkt;
          const b = units[info.unit].bytes;
          cwnd += cwnd < ssthresh ? b : (MSS * b) / cwnd;
          if (pkt === largestNew) {
            const sample = now - info.sentAt;
            rttvar = 0.75 * rttvar + 0.25 * Math.abs(srtt - sample);
            srtt = 0.875 * srtt + 0.125 * sample;
          }
        }
      }
      if (largestNew > largestAcked) largestAcked = largestNew;
      // Loss detection (packet threshold 3, time threshold 9/8·RTT).
      for (const [pkt, info] of inflight) {
        if (
          pkt < largestAcked &&
          (largestAcked - pkt >= 3 || now - info.sentAt > (9 / 8) * srtt)
        ) {
          forget(pkt, info);
          onCongestion(now, info.sentAt);
          sendQueue.unshift(info.unit);
        }
      }
      if (newlyAcked) {
        backoff = 0;
        tlpArmed = true;
        armTimer(now);
      }
      trySend(now);
    } else if (ev.kind === "timer") {
      if (ev.at !== timerAt || inflight.size === 0) continue; // stale timer
      if (transport === "tcp" && tlpArmed) {
        // TLP: re-send the most recent segment to elicit SACKs; no cwnd change,
        // no backoff. Loss of earlier segments is then found by RACK.
        const [pkt, info] = [...inflight].pop();
        forget(pkt, info);
        sendQueue.unshift(info.unit);
        tlpArmed = false;
        timerAt = Infinity;
        trySend(now);
        armTimer(now);
        continue;
      }
      if (transport === "tcp") {
        // RTO: everything outstanding is presumed lost; cwnd collapses to 1.
        for (const [pkt, info] of [...inflight].reverse()) {
          forget(pkt, info);
          sendQueue.unshift(info.unit);
        }
        ssthresh = Math.max(2 * MSS, cwnd / 2);
        cwnd = MSS;
        recoveryStart = now;
      } else {
        // PTO: two probe packets carrying the oldest outstanding data
        // (RFC 9002 §6.2.4); loss is declared later from the probes' ACKs.
        const oldest = [...inflight].slice(0, 2);
        for (const [pkt, info] of oldest.reverse()) {
          forget(pkt, info);
          sendQueue.unshift(info.unit);
        }
      }
      backoff++;
      timerAt = Infinity;
      trySend(now);
      armTimer(now);
    }
  }

  const lat = delivered.filter((d) => d !== null);
  cfg.collect?.push(...lat);
  return {
    ...summarize(lat, alerts.length),
    retransmitOverhead: firstSends ? retransmits / firstSends : 0,
  };
}

// ── reconnection after an interface switch (Monte Carlo) ─────────────────────

/**
 * Time for one request/response round trip whose flights are `up` and `down`
 * packets, with per-packet loss and a retransmission timer that doubles.
 */
function roundTrip(r, owd, loss, up, down, firstTimeout) {
  let t = 0;
  let timeout = firstTimeout;
  for (let left = up; left > 0;) {
    const lost = Array.from({ length: left }, () => r() < loss).filter(
      Boolean,
    ).length;
    if (lost === 0) {
      t += owd;
      break;
    }
    t += timeout;
    timeout *= 2;
    left = lost;
  }
  for (let left = down; left > 0;) {
    const lost = Array.from({ length: left }, () => r() < loss).filter(
      Boolean,
    ).length;
    if (lost === 0) {
      t += owd;
      break;
    }
    t += timeout;
    timeout *= 2;
    left = lost;
  }
  return t;
}

export function reconnectSample(kind, { rtt, loss, detection }, r) {
  const owd = rtt / 2;
  // How long until the client notices the old path is dead.
  const detect =
    detection === "event"
      ? r() * 50 // `online` / navigator.connection 'change' fires promptly
      : 10_000 + r() * 25_000; // heartbeat: up to one 25 s interval + 10 s timeout
  const rtoAfterSample = Math.max(200, 2 * rtt) + rtt; // TCP: srtt + max(200, 4·rtt/2)
  const ptoAfterSample = 2 * rtt + rtt + 25; // QUIC: srtt + 4·rttvar + max_ack_delay
  let t = detect;
  switch (kind) {
    case "ws-tcp":
      t += roundTrip(r, owd, loss, 1, 1, 1000); // SYN / SYN-ACK, 1 s initial SYN RTO
      t += roundTrip(r, owd, loss, 1, 4, rtoAfterSample); // TLS 1.3 ClientHello / ServerHello..Finished (~4 KB certs)
      t += roundTrip(r, owd, loss, 1, 1, rtoAfterSample); // Finished + HTTP Upgrade / 101
      t += roundTrip(r, owd, loss, 1, 1, rtoAfterSample); // resume(lastId) / first replayed alert
      break;
    case "wt-quic":
      t += roundTrip(r, owd, loss, 1, 4, 999); // Initial / Initial+Handshake (RFC 9002 initial PTO ≈ 999 ms)
      t += roundTrip(r, owd, loss, 1, 1, ptoAfterSample); // Finished+SETTINGS+CONNECT / 200
      t += roundTrip(r, owd, loss, 1, 1, ptoAfterSample); // resume / first alert
      break;
    case "wt-quic-migration":
      // Connection survives; client probes from the new address. No handshake.
      t += roundTrip(r, owd, loss, 1, 1, ptoAfterSample);
      break;
    default:
      throw new Error(kind);
  }
  return t;
}

function runSim() {
  const seeds = Number(opt("seeds", 30));
  const arms = [
    { name: "WebSocket / TCP", transport: "tcp", ordering: "stream" },
    {
      name: "WebTransport, single stream",
      transport: "quic",
      ordering: "stream",
    },
    {
      name: "WebTransport, stream per alert",
      transport: "quic",
      ordering: "multiplexed",
    },
  ];
  // 2 alerts/s: a responder following a handful of incidents. 10 alerts/s: a
  // dispatcher/coordinator view during a mass-casualty surge.
  const loads = String(opt("rates", "2,10")).split(",").map(Number);
  const stream = [];
  for (const rate of loads) {
    for (const loss of LOSSES) {
      for (const arm of arms) {
        // Pool every alert across seeds, then take percentiles (not a mean of per-seed percentiles).
        const lat = [];
        let total = 0;
        let overhead = 0;
        for (let s = 1; s <= seeds; s++) {
          const alerts = workload(s, { rate });
          const res = simulateAlertStream({
            ...arm,
            rtt: RTT,
            loss,
            seed: s,
            alerts,
            collect: lat,
          });
          total += alerts.length;
          overhead += res.retransmitOverhead / seeds;
        }
        stream.push({
          rate,
          loss,
          arm: arm.name,
          ...summarize(lat, total),
          retransmitOverhead: overhead,
        });
      }
    }
  }

  const trials = 20_000;
  const reconnect = [];
  for (const detection of ["event", "heartbeat"]) {
    for (const loss of LOSSES) {
      for (const kind of ["ws-tcp", "wt-quic", "wt-quic-migration"]) {
        const r = rng(0x603 + Math.round(loss * 100) + kind.length);
        const s = Array.from({ length: trials }, () =>
          reconnectSample(kind, { rtt: RTT, loss, detection }, r),
        ).sort((a, b) => a - b);
        const mean = s.reduce((a, x) => a + x, 0) / s.length;
        const sd = Math.sqrt(
          s.reduce((a, x) => a + (x - mean) ** 2, 0) / s.length,
        );
        reconnect.push({
          detection,
          loss,
          kind,
          p50: percentile(s, 0.5),
          p95: percentile(s, 0.95),
          p99: percentile(s, 0.99),
          jitterSd: sd,
        });
      }
    }
  }

  if (JSON_OUT)
    return console.log(
      JSON.stringify(
        { rtt: RTT, deadline: DEADLINE, seeds, stream, reconnect },
        null,
        2,
      ),
    );

  console.log(
    `## Alert delivery latency, simulated (RTT ${RTT} ms, ${seeds} seeds x 30 s of Poisson alerts, deadline ${DEADLINE} ms)\n`,
  );
  console.log(
    "| Load | Loss | Transport | p50 ms | p95 ms | p99 ms | Missed deadline | Retransmit overhead |",
  );
  console.log("| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const x of stream) {
    console.log(
      `| ${x.rate}/s | ${pct(x.loss)} | ${x.arm} | ${f0(x.p50)} | ${f0(x.p95)} | ${f0(x.p99)} | ${pct(x.missRate)} | ${pct(x.retransmitOverhead)} |`,
    );
  }
  console.log(
    `\n## Time to first alert after WiFi→LTE switch, simulated (${trials.toLocaleString()} trials, RTT ${RTT} ms)\n`,
  );
  console.log(
    "| Detection | Loss | Path | p50 ms | p95 ms | p99 ms | Jitter (SD) ms |",
  );
  console.log("| --- | ---: | --- | ---: | ---: | ---: | ---: |");
  const label = {
    "ws-tcp": "WebSocket reconnect (TCP+TLS+Upgrade)",
    "wt-quic": "WebTransport reconnect (QUIC+CONNECT)",
    "wt-quic-migration": "QUIC connection migration (best case)",
  };
  for (const x of reconnect) {
    console.log(
      `| ${x.detection} | ${pct(x.loss)} | ${label[x.kind]} | ${f0(x.p50)} | ${f0(x.p95)} | ${f0(x.p99)} | ${f0(x.jitterSd)} |`,
    );
  }
}

// ── live: real QUIC through a lossy UDP proxy ────────────────────────────────

function ensureBinary() {
  if (existsSync(BIN)) return;
  console.error(
    "[live] building scripts/spikes/webtransport_server (cargo build --release)…",
  );
  const b = spawnSync("cargo", ["build", "--release"], {
    cwd: CRATE,
    stdio: "inherit",
  });
  if (b.status !== 0) throw new Error("cargo build failed");
}

/** Forwards UDP between a client and `serverPort`, adding one-way delay and loss. */
export function startLossyUdpProxy({
  listenPort,
  serverPort,
  owdMs,
  loss,
  seed = 1,
}) {
  const r = rng(seed);
  const front = dgram.createSocket("udp4");
  const back = dgram.createSocket("udp4");
  let client = null;
  let closed = false;
  const stats = { forwarded: 0, dropped: 0 };
  const relay = (sock, msg, port) => {
    if (r() < loss) {
      stats.dropped++;
      return;
    }
    stats.forwarded++;
    // Packets still "on the wire" when the proxy closes are simply lost.
    setTimeout(() => !closed && sock.send(msg, port, "127.0.0.1"), owdMs);
  };
  front.on("message", (msg, rinfo) => {
    client = rinfo;
    relay(back, msg, serverPort);
  });
  back.on("message", (msg) => client && relay(front, msg, client.port));
  return new Promise((resolve) => {
    front.bind(listenPort, "127.0.0.1", () =>
      back.bind(0, "127.0.0.1", () =>
        resolve({
          stats,
          close: () => {
            closed = true;
            front.close();
            back.close();
          },
        }),
      ),
    );
  });
}

function runClient(args, timeoutS) {
  return new Promise((resolve, reject) => {
    const c = spawn(BIN, ["client", ...args, "--timeout-s", String(timeoutS)]);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", () => {});
    c.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").pop()));
      } catch (e) {
        reject(new Error(`client output: ${out}`));
      }
    });
  });
}

async function startServer(wtPort, tcpPort) {
  const srv = spawn(BIN, [
    "server",
    "--wt-port",
    String(wtPort),
    "--tcp-port",
    String(tcpPort),
  ]);
  let stderr = "";
  srv.stderr.on("data", (d) => (stderr += d));
  // Never leave an orphaned server holding the ports if this process dies.
  process.once("exit", () => srv.kill());
  await new Promise((resolve, reject) => {
    srv.stdout.once("data", (d) =>
      String(d).includes('"ready":true')
        ? resolve()
        : reject(new Error(String(d))),
    );
    srv.once("exit", (code) =>
      reject(new Error(`server exited ${code}: ${stderr.trim()}`)),
    );
  });
  return srv;
}

async function runLive({ netem = false } = {}) {
  ensureBinary();
  const trials = Number(opt("trials", 3));
  const n = Number(opt("n", 200));
  const interval = Number(opt("interval-ms", 50));
  const dev = opt("dev", "lo");
  const wtPort = 24433,
    tcpPort = 24434,
    proxyPort = 24435;
  const srv = await startServer(wtPort, tcpPort);
  const rows = [];
  const tc = (...a) => spawnSync("tc", a, { stdio: "inherit" });
  try {
    for (const loss of LOSSES) {
      let proxy = null;
      if (netem) {
        tc("qdisc", "del", "dev", dev, "root");
        // lo carries both directions through one qdisc: 100 ms each way = RTT 200.
        if (
          tc(
            "qdisc",
            "add",
            "dev",
            dev,
            "root",
            "netem",
            "delay",
            `${RTT / 2}ms`,
            "loss",
            `${loss * 100}%`,
          ).status !== 0
        ) {
          throw new Error("tc failed (root required)");
        }
      } else {
        proxy = await startLossyUdpProxy({
          listenPort: proxyPort,
          serverPort: wtPort,
          owdMs: RTT / 2,
          loss,
          seed: 603 + Math.round(loss * 100),
        });
      }
      const port = netem ? wtPort : proxyPort;
      const arms = [
        ["WebTransport, stream per alert", "multi"],
        ["WebTransport, single stream", "single"],
        ...(netem ? [["TCP push (WebSocket semantics)", "tcp"]] : []),
      ];
      for (const [name, mode] of arms) {
        const lat = [];
        const hs = [];
        let total = 0;
        for (let t = 0; t < trials; t++) {
          const timeoutS = Math.ceil((n * interval) / 1000) + 60;
          const res =
            mode === "tcp"
              ? await runClient(
                  [
                    "--tcp",
                    `127.0.0.1:${tcpPort}`,
                    "--n",
                    String(n),
                    "--interval-ms",
                    String(interval),
                  ],
                  timeoutS,
                )
              : await runClient(
                  [
                    "--url",
                    `https://127.0.0.1:${port}/alerts?n=${n}&interval_ms=${interval}&size=1024&mode=${mode}`,
                  ],
                  timeoutS,
                );
          lat.push(...res.latencies_ms);
          hs.push(res.handshake_ms);
          total += res.n;
        }
        rows.push({
          loss,
          arm: name,
          handshakeMs: hs.reduce((a, b) => a + b, 0) / hs.length,
          ...summarize(lat, total),
        });
        if (!JSON_OUT) console.error(`[live] loss ${pct(loss)} ${name}: done`);
      }
      proxy?.close();
    }
  } finally {
    if (netem) tc("qdisc", "del", "dev", dev, "root");
    srv.kill();
  }
  if (JSON_OUT)
    return console.log(
      JSON.stringify(
        { rtt: RTT, deadline: DEADLINE, n, trials, netem, rows },
        null,
        2,
      ),
    );
  console.log(
    `## Alert delivery latency, measured on real QUIC (${netem ? `tc netem on ${dev}` : "userspace UDP loss proxy"}, RTT ${RTT} ms, ${trials} x ${n} alerts at ${1000 / interval}/s, deadline ${DEADLINE} ms)\n`,
  );
  console.log(
    "| Loss | Arm | Session setup ms | p50 ms | p95 ms | p99 ms | Missed deadline |",
  );
  console.log("| ---: | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const x of rows) {
    console.log(
      `| ${pct(x.loss)} | ${x.arm} | ${f0(x.handshakeMs)} | ${f0(x.p50)} | ${f0(x.p95)} | ${f0(x.p99)} | ${pct(x.missRate)} |`,
    );
  }
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (MODE === "sim") runSim();
  else if (MODE === "live") await runLive();
  else if (MODE === "netem") {
    if (process.getuid?.() !== 0) {
      console.error(
        "netem mode needs root (tc qdisc). Try: sudo node scripts/spikes/quic_stress_test.js netem",
      );
      process.exit(1);
    }
    await runLive({ netem: true });
  } else {
    console.error(`unknown mode ${MODE}; use sim | live | netem`);
    process.exit(1);
  }
}
