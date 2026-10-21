#!/usr/bin/env node
/**
 * Spike ISP-049 (#719) — does cross-origin isolation block WebRTC TURN relay?
 *
 * The issue claims COOP `same-origin` + COEP `credentialless` make Chromium
 * refuse TURN allocation, forcing host/STUN fallback that fails on symmetric
 * NAT. This script tests that claim directly. It starts a real TURN server
 * (node-turn) on loopback, serves a page under each header set, and in a real
 * Chrome opens two RTCPeerConnections with `iceTransportPolicy: 'relay'`, so
 * a data channel can only open if the TURN allocation succeeds and traffic is
 * relayed. It reports whether it connected and which candidate pair carried it.
 *
 * It repeats each header set over TURN/UDP and TURN/TCP.
 *
 * Usage:
 *   npm i --no-save node-turn          # test-only dependency, not in package.json
 *   node scripts/spikes/webrtc_coep_turn_experiment.mjs
 *     [--runs 5] [--timeout 10000]
 *     [--executable /path/to/chrome]   (or CHROMIUM_PATH env)
 *     [--headed]
 *     [--out docs/spikes/results/webrtc-coep-turn.json]
 *
 * Browser: uses --executable / CHROMIUM_PATH if given, else the system Chrome
 * (Playwright channel "chrome"), else Playwright's bundled Chromium.
 *
 * Limits: one machine, loopback only. It proves what COOP/COEP do to relay
 * allocation in the browser. It does NOT emulate carrier NATs.
 */

import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const RUNS = Number(opt("runs", 5));
const TIMEOUT_MS = Number(opt("timeout", 10_000));
const EXECUTABLE = opt("executable", process.env.CHROMIUM_PATH);
const HEADED = args.includes("--headed");
const OUT = opt("out", null);

const TURN_PORT = 34780;
const TURN_USER = "helphone";
const TURN_PASS = "spike-secret";

let Turn;
try {
  ({ default: Turn } = await import("node-turn"));
} catch {
  console.error("node-turn is not installed. Run: npm i --no-save node-turn");
  process.exit(2);
}

const TRANSPORTS = ["udp", "tcp"];
const VARIANTS = [
  { name: "control: no isolation headers", headers: {} },
  {
    name: "repo config: COOP same-origin + COEP credentialless",
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  {
    name: "strict: COOP same-origin + COEP require-corp",
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
];

const PAGE = `<!doctype html><meta charset="utf-8"><title>webrtc coep spike</title>
<script>
window.run = async function run({ turnUrl, user, pass, timeoutMs }) {
  const config = {
    iceServers: [{ urls: turnUrl, username: user, credential: pass }],
    iceTransportPolicy: 'relay', // only TURN-relayed candidates are allowed
  };
  const a = new RTCPeerConnection(config);
  const b = new RTCPeerConnection(config);
  const candidateTypes = new Set();
  const typ = (c) => (/ typ (\\w+)/.exec(c) || [])[1] || 'unknown';
  a.onicecandidate = (e) => { if (e.candidate) { candidateTypes.add(typ(e.candidate.candidate)); b.addIceCandidate(e.candidate); } };
  b.onicecandidate = (e) => { if (e.candidate) { candidateTypes.add(typ(e.candidate.candidate)); a.addIceCandidate(e.candidate); } };
  const opened = new Promise((resolve) => {
    b.ondatachannel = (ev) => { ev.channel.onopen = () => resolve(true); };
  });
  a.createDataChannel('probe');
  const started = performance.now();
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  const connected = await Promise.race([opened, new Promise((r) => setTimeout(() => r(false), timeoutMs))]);
  let selectedPair = null;
  try {
    const stats = await a.getStats();
    const byId = {}; stats.forEach((s) => { byId[s.id] = s; });
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
        selectedPair = { local: byId[s.localCandidateId]?.candidateType, remote: byId[s.remoteCandidateId]?.candidateType };
      }
    });
  } catch {}
  const result = {
    connected,
    msToConnect: connected ? Math.round(performance.now() - started) : null,
    iceConnectionState: { a: a.iceConnectionState, b: b.iceConnectionState },
    candidateTypes: [...candidateTypes].sort(),
    selectedPair,
    crossOriginIsolated: window.crossOriginIsolated,
  };
  a.close(); b.close();
  return result;
};
</script>`;

function startPageServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/favicon.ico")) { res.writeHead(204).end(); return; }
    const m = /^\/v(\d+)$/.exec(req.url.split("?")[0]);
    const variant = m && VARIANTS[Number(m[1])];
    if (!variant) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...variant.headers });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const turn = new Turn({
  authMech: "long-term",
  credentials: { [TURN_USER]: TURN_PASS },
  listeningPort: TURN_PORT,
  listeningIps: ["127.0.0.1"],
  relayIps: ["127.0.0.1"],
  debugLevel: "OFF",
});
turn.start();

const pageServer = await startPageServer();
const origin = `http://127.0.0.1:${pageServer.address().port}`;

const launchOptions = {
  headless: !HEADED,
  args: ["--allow-loopback-in-peer-connection", "--disable-features=WebRtcHideLocalIpsWithMdns"],
};
let browser;
try {
  if (EXECUTABLE) browser = await chromium.launch({ ...launchOptions, executablePath: EXECUTABLE });
  else {
    try { browser = await chromium.launch({ ...launchOptions, channel: "chrome" }); }
    catch { browser = await chromium.launch(launchOptions); }
  }
} catch (err) {
  console.error(`Could not launch a browser: ${err.message}\nPass --executable /path/to/chrome or set CHROMIUM_PATH.`);
  turn.stop?.(); pageServer.close();
  process.exit(2);
}

const report = {
  generatedAt: new Date().toISOString(),
  browser: browser.version(),
  turn: "node-turn on 127.0.0.1 (UDP+TCP), long-term credentials",
  runsPerVariant: RUNS,
  timeoutMs: TIMEOUT_MS,
  variants: [],
};

for (const transport of TRANSPORTS) for (let v = 0; v < VARIANTS.length; v++) {
  const variant = VARIANTS[v];
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    await page.goto(`${origin}/v${v}`);
    const result = await page.evaluate(
      (p) => window.run(p),
      { turnUrl: `turn:127.0.0.1:${TURN_PORT}?transport=${transport}`, user: TURN_USER, pass: TURN_PASS, timeoutMs: TIMEOUT_MS },
    );
    runs.push({ ...result, consoleErrors });
    await page.close();
  }
  const connected = runs.filter((r) => r.connected).length;
  const relayed = runs.filter((r) => r.selectedPair && (r.selectedPair.local === "relay" || r.selectedPair.remote === "relay")).length;
  report.variants.push({
    name: variant.name,
    transport,
    headers: variant.headers,
    crossOriginIsolated: runs.every((r) => r.crossOriginIsolated),
    connected: `${connected}/${RUNS}`,
    viaRelayPair: `${relayed}/${RUNS}`,
    medianMsToConnect: median(runs.filter((r) => r.connected).map((r) => r.msToConnect)),
    consoleErrors: [...new Set(runs.flatMap((r) => r.consoleErrors))],
    sample: runs[0],
  });
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

await browser.close();
pageServer.close();
turn.stop?.();

console.log(`\nBrowser: ${report.browser}   (relay-only peer connection through a local TURN server)\n`);
console.table(report.variants.map((v) => ({
  variant: v.name,
  transport: v.transport,
  crossOriginIsolated: v.crossOriginIsolated,
  connected: v.connected,
  "via relay pair": v.viaRelayPair,
  "median ms": v.medianMsToConnect,
  "console errors": v.consoleErrors.length,
})));
for (const v of report.variants) {
  if (v.consoleErrors.length) console.log(`${v.name} (${v.transport})\n  console errors: ${JSON.stringify(v.consoleErrors)}`);
}

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nWrote ${OUT}`);
}
process.exit(0);
