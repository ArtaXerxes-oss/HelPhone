#!/usr/bin/env node
/**
 * Spike (ADR-014): runs src/utils/telemetryBench.js in headless Chrome and
 * adds main-thread GC pauses taken from a Chrome trace (the same MinorGC /
 * MajorGC events the DevTools Performance panel shows).
 *
 * No dependencies: a static file server plus a small Chrome DevTools
 * Protocol client over Node's built-in WebSocket (Node >= 22).
 *
 * Usage:
 *   CHROMIUM_PATH=/path/to/chrome node scripts/spikes/binary_browser_benchmark.js \
 *     [--seconds 10] [--rate 10000] [--frame-sizes 100,1000,10000] [--repeats 2] \
 *     [--only json/,flatbuffers/] [--cpu-throttle 4] [--resume] \
 *     [--out docs/spikes/results/binary-serialization-browser.json]
 *
 * --cpu-throttle N uses Emulation.setCPUThrottlingRate to slow the renderer
 * down N times, a rough stand-in for a mid-range phone.
 */

import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BENCH_SCENARIOS } from "../../src/utils/telemetryBench.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

// ---------------------------------------------------------------------------
// Static server (only src/ and scripts/spikes/ are served)

const MIME = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };

function serve() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
    const file = join(ROOT, path);
    const allowed = path.startsWith("src/") || path.startsWith("scripts/spikes/");
    if (!allowed || !file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
      // Cross-origin isolation raises performance.now() resolution from
      // 100 us to 5 us, which small frames (~5 us of decode) need.
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

// ---------------------------------------------------------------------------
// Minimal CDP client

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: ok, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`));
        else ok(msg.result);
      } else {
        for (const l of this.listeners) l(msg);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

async function launchChrome() {
  const bin = process.env.CHROMIUM_PATH;
  if (!bin || !existsSync(bin)) throw new Error("set CHROMIUM_PATH to a Chrome/Chromium binary");
  const profile = mkdtempSync(join(os.tmpdir(), "hp-chrome-"));
  const proc = spawn(bin, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--enable-precise-memory-info",
    "--js-flags=--expose-gc",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = "";
    const t = setTimeout(() => rej(new Error(`Chrome did not start: ${buf}`)), 30_000);
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(t);
        res(m[1]);
      }
    });
  });
  const cdp = new Cdp(wsUrl);
  await cdp.ready;
  const version = await cdp.send("Browser.getVersion");
  return { cdp, proc, profile, version };
}

// ---------------------------------------------------------------------------
// Trace analysis

const GC_EVENTS = new Set(["MinorGC", "MajorGC"]);

/** Main-thread GC pauses between the page's start/end marks. */
function analyseTrace(events) {
  const mainThreads = new Set(
    events.filter((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`),
  );
  const start = events.find((e) => e.name === "telemetry-bench-start");
  const end = events.find((e) => e.name === "telemetry-bench-end");
  if (!start || !end) return { error: "benchmark marks not found in trace" };
  const pid = start.pid;
  const inWindow = (e) => e.pid === pid && mainThreads.has(`${e.pid}:${e.tid}`) && e.ts >= start.ts && e.ts <= end.ts;
  const gc = events.filter((e) => e.ph === "X" && GC_EVENTS.has(e.name) && inWindow(e));
  const byType = {};
  for (const e of gc) {
    const t = (byType[e.name] ??= { count: 0, totalMs: 0, maxMs: 0 });
    const ms = e.dur / 1000;
    t.count++;
    t.totalMs = +(t.totalMs + ms).toFixed(3);
    t.maxMs = +Math.max(t.maxMs, ms).toFixed(3);
  }
  const pauses = gc.map((e) => e.dur / 1000);
  return {
    windowMs: +((end.ts - start.ts) / 1000).toFixed(1),
    count: pauses.length,
    totalMs: +pauses.reduce((a, b) => a + b, 0).toFixed(3),
    maxMs: +Math.max(0, ...pauses).toFixed(3),
    over4ms: pauses.filter((p) => p > 4).length,
    byType,
  };
}

async function runOne(cdp, base, scenario, frameSize, rate, seconds, cpuThrottle) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const events = [];
  let traceDone;
  const traceComplete = new Promise((r) => (traceDone = r));
  const off = cdp.on((msg) => {
    if (msg.method === "Tracing.dataCollected") events.push(...msg.params.value);
    if (msg.method === "Tracing.tracingComplete") traceDone();
  });
  try {
    await cdp.send("Runtime.enable", {}, sessionId);
    if (cpuThrottle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle }, sessionId);
    await cdp.send("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: { includedCategories: ["devtools.timeline", "v8", "blink.user_timing", "__metadata"], recordMode: "recordContinuously" },
    });
    const url = `${base}/scripts/spikes/binary_browser_bench.html?scenario=${encodeURIComponent(scenario)}&frameSize=${frameSize}&rate=${rate}&seconds=${seconds}`;
    await cdp.send("Page.navigate", { url }, sessionId);
    let result = null;
    for (let i = 0; i < 600 && !result; i++) {
      const r = await cdp.send("Runtime.evaluate", { expression: "window.__bench ? window.__bench.then(r => JSON.stringify(r)) : null", awaitPromise: true, returnByValue: true }, sessionId).catch(() => null);
      if (r?.result?.value) result = JSON.parse(r.result.value);
      else await new Promise((w) => setTimeout(w, 250));
    }
    await cdp.send("Tracing.end");
    await traceComplete;
    if (!result) throw new Error("benchmark did not finish");
    if (result.error) throw new Error(result.error);
    return { ...result, cpuThrottle, gc: analyseTrace(events) };
  } finally {
    off();
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

async function main() {
  const seconds = Number(arg("seconds", 10));
  const rate = Number(arg("rate", 10000));
  const frameSizes = String(arg("frame-sizes", "100,1000,10000")).split(",").map(Number);
  const repeats = Number(arg("repeats", 2));
  const only = arg("only") ? String(arg("only")).split(",") : null;
  const cpuThrottle = Number(arg("cpu-throttle", 1));
  const outPath = arg("out");

  const done = new Set();
  let previous = [];
  if (arg("resume") && outPath && existsSync(outPath)) {
    previous = JSON.parse(readFileSync(outPath, "utf8")).runs.filter((r) => !r.error);
    for (const r of previous) done.add(`${r.scenario}@${r.frameSize}#${r.rep}`);
    console.log(`resuming: ${done.size} run(s) already recorded`);
  }
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const { cdp, proc, profile, version } = await launchChrome();
  const results = {
    meta: { date: new Date().toISOString(), browser: version.product, v8: version.jsVersion, cpu: os.cpus()[0]?.model, rate, seconds, frameSizes, repeats, cpuThrottle },
    runs: previous,
  };
  const save = () => {
    if (!outPath) return;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
  };
  try {
    for (let rep = 0; rep < repeats; rep++) {
      for (const frameSize of frameSizes) {
        for (const scenario of BENCH_SCENARIOS) {
          if (only && !only.some((o) => scenario.includes(o))) continue;
          if (done.has(`${scenario}@${frameSize}#${rep}`)) continue;
          try {
            const r = await runOne(cdp, base, scenario, frameSize, rate, seconds, cpuThrottle);
            results.runs.push({ rep, ...r });
            save();
            console.log(
              `✓ [${rep + 1}/${repeats}] ${scenario.padEnd(22)} @${String(frameSize).padStart(5)}  ` +
                `${String(r.nsPerObject).padStart(7)} ns/obj  dropped ${String(r.droppedFrames).padStart(4)}  ` +
                `long>50ms ${String(r.longFrames50ms).padStart(3)}  rAF p99 ${r.rafIntervalMs.p99.toFixed(1).padStart(6)} ms  ` +
                `GC ${String(r.gc.count).padStart(4)} (total ${r.gc.totalMs} ms, max ${r.gc.maxMs} ms)`,
            );
          } catch (err) {
            console.error(`✗ ${scenario} @${frameSize}: ${err.message}`);
            results.runs.push({ rep, scenario, frameSize, error: err.message });
            save();
          }
        }
      }
    }
  } finally {
    // Chrome keeps writing to its profile while it shuts down; wait for it
    // to exit before deleting the directory (ENOTEMPTY otherwise).
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  save();
  if (outPath) console.log(`\nwrote ${outPath}`);
}

await main();
process.exit(0);
