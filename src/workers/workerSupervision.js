/**
 * Worker supervision shared by every file in src/workers/* (#793, #797).
 *
 * Blob/null-origin workers have no window.onerror parity: an exception or OOM
 * terminates them silently. Inside the worker, `installWorkerHooks` forwards
 * errors as messages and posts a heartbeat carrying queue depth; on the main
 * thread, `superviseWorker` treats a missed heartbeat (> stallMs) as a
 * termination. Both sides also share the kill-switch snapshot over the
 * `helphone-flags` BroadcastChannel so a kill reaches workers without the
 * main thread relaying it.
 */

export const HEARTBEAT_MS = 10_000;
export const STALL_MS = 30_000;
const FLAG_CHANNEL = "helphone-flags";

// ── Worker side ──────────────────────────────────────────────────────────────

const workerState = {
  name: "worker",
  queueDepth: 0,
  pendingBytes: 0,
  flags: { version: "0", fetchedAt: 0, kills: {} },
};

export function setQueueStats(depth, pendingBytes = 0) {
  workerState.queueDepth = depth;
  workerState.pendingBytes = pendingBytes;
}

/** Worker-side kill check. Unknown switches are open; known kills win. */
export function isKilled(key) {
  return workerState.flags.kills[key] === false;
}

export function workerFlagVersion() {
  return workerState.flags.version;
}

export function installWorkerHooks(scope, name) {
  if (!scope || typeof scope.postMessage !== "function") return () => {};
  workerState.name = name;
  const post = (msg) => {
    try {
      scope.postMessage(msg);
    } catch {
      /* port closed */
    }
  };
  const describe = (err) => ({
    name: (err && err.name) || "Error",
    message: String((err && err.message) || err).slice(0, 500),
    stack: typeof err?.stack === "string" ? err.stack.slice(0, 2000) : undefined,
  });

  scope.addEventListener?.("error", (e) => post({ type: "__worker_error", worker: name, error: describe(e.error || e.message) }));
  scope.addEventListener?.("unhandledrejection", (e) => post({ type: "__worker_error", worker: name, error: describe(e.reason) }));
  scope.addEventListener?.("messageerror", () => post({ type: "__worker_error", worker: name, error: { name: "MessageError", message: "undeserialisable message" } }));

  let channel = null;
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(FLAG_CHANNEL);
    channel.onmessage = (e) => {
      const s = e.data?.snapshot;
      if (e.data?.type === "flags.patch" && s && Number(s.version) >= Number(workerState.flags.version)) {
        workerState.flags = s;
      }
    };
  }

  const beat = () =>
    post({
      type: "__heartbeat",
      worker: name,
      at: Date.now(),
      queueDepth: workerState.queueDepth,
      pendingBytes: workerState.pendingBytes,
      flagVersion: workerState.flags.version,
    });
  const timer = setInterval(beat, HEARTBEAT_MS);
  beat();
  return () => {
    clearInterval(timer);
    channel?.close();
  };
}

/**
 * Applies a flag snapshot sent directly by the main thread (for browsers
 * without BroadcastChannel in workers). Messages with an older flagVersion
 * than the worker already holds are ignored.
 */
export function handleFlagMessage(msg) {
  if (msg?.type !== "flags.patch" || !msg.snapshot) return false;
  if (Number(msg.snapshot.version) >= Number(workerState.flags.version)) workerState.flags = msg.snapshot;
  return true;
}

// ── Main-thread side ─────────────────────────────────────────────────────────

/**
 * Supervises a Worker. `onBeat({worker, queueDepth, pendingBytes, ageMs})`
 * fires per heartbeat; `onDead({worker, reason, error?})` fires once on a
 * forwarded error or a missed heartbeat.
 */
export function superviseWorker(worker, name, { onBeat, onDead, stallMs = STALL_MS } = {}) {
  let last = Date.now();
  let dead = false;
  const die = (reason, error) => {
    if (dead) return;
    dead = true;
    onDead?.({ worker: name, reason, error });
  };
  const onMessage = (e) => {
    const msg = e.data;
    if (msg?.type === "__heartbeat") {
      last = msg.at || Date.now();
      onBeat?.({ worker: name, queueDepth: msg.queueDepth, pendingBytes: msg.pendingBytes, flagVersion: msg.flagVersion, ageMs: 0 });
    } else if (msg?.type === "__worker_error") {
      die("error", msg.error);
    }
  };
  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", (e) => die("error", { name: "Error", message: String(e.message || "worker error") }));
  worker.addEventListener("messageerror", () => die("error", { name: "MessageError", message: "undeserialisable message" }));
  const watchdog = setInterval(() => {
    const age = Date.now() - last;
    if (age > stallMs) die("heartbeat_stall");
  }, Math.min(stallMs / 3, HEARTBEAT_MS));
  return () => {
    clearInterval(watchdog);
    worker.removeEventListener("message", onMessage);
  };
}
