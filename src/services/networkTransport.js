// Emergency alert transport with WebTransport → WebSocket → SSE fallback (#603).
//
// Decision tree and the evidence behind every default below:
// docs/adr/ADR-003-webtransport-vs-websocket.md
//
//   const t = createNetworkTransport({
//     endpoints: {
//       webTransport: "https://alerts.helphone.com:4433/alerts",   // HTTP/3
//       webSocket: "wss://alerts.helphone.com/alerts",
//       sse: "https://api.helphone.com/events/stream",            // exists today
//     },
//     onMessage: (alert) => ...,
//     onStatus: ({ state, transport }) => ...,
//   });
//   t.start();
//
// Wire protocol (JSON text): server → client alerts carry a unique `id`, which
// is used for de-duplication across reconnects. On bidirectional transports the client sends
// `{type:"resume", lastId}` after connecting and `{type:"ping", t}` heartbeats;
// the server answers pings with `{type:"pong", t}`. On WebTransport each message
// travels on its own unidirectional stream, so a lost packet delays only the
// alert it belongs to (no cross-alert head-of-line blocking).

export const TRANSPORTS = Object.freeze(["webtransport", "websocket", "sse"]);

export const DEFAULTS = Object.freeze({
  connectTimeoutMs: 5_000,
  // 25 s keeps NAT/LB mappings alive (most idle out at 30–60 s). Each ping is a
  // radio wake-up on cellular, so it stretches to 60 s on low battery.
  heartbeatMs: 25_000,
  lowPowerHeartbeatMs: 60_000,
  heartbeatTimeoutMs: 10_000,
  // After an interface switch, how long a WebTransport session gets to prove
  // it survived via QUIC connection migration before we rebuild it.
  migrationGraceMs: 1_500,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
  // A transport that failed this many times in a row is skipped for cooldownMs,
  // e.g. networks that block UDP/443 so QUIC can never connect.
  maxFailures: 2,
  cooldownMs: 5 * 60_000,
  dedupeWindow: 1_000,
});

export function detectCapabilities(g = globalThis) {
  return {
    webTransport: typeof g.WebTransport === "function",
    webSocket: typeof g.WebSocket === "function",
    eventSource: typeof g.EventSource === "function",
  };
}

/**
 * Orders the transports to try. Pure, so the decision tree is unit-testable.
 * @returns {{ plan: {kind: string, url: string}[], skipped: {kind: string, reason: string}[] }}
 */
export function selectTransports({
  endpoints = {},
  capabilities,
  health = {},
  now = Date.now(),
  maxFailures = DEFAULTS.maxFailures,
  cooldownMs = DEFAULTS.cooldownMs,
}) {
  const candidates = [
    ["webtransport", endpoints.webTransport, capabilities.webTransport],
    ["websocket", endpoints.webSocket, capabilities.webSocket],
    ["sse", endpoints.sse, capabilities.eventSource],
  ];
  const plan = [];
  const skipped = [];
  const cooling = [];
  for (const [kind, url, supported] of candidates) {
    if (!url) skipped.push({ kind, reason: "no-endpoint" });
    else if (!supported) skipped.push({ kind, reason: "unsupported" });
    else {
      const h = health[kind];
      if (
        h &&
        h.failures >= maxFailures &&
        now - h.lastFailureAt < cooldownMs
      ) {
        skipped.push({ kind, reason: "cooldown" });
        cooling.push({ kind, url });
      } else plan.push({ kind, url });
    }
  }
  // If every usable transport is cooling down, try them anyway, because giving
  // up is never the right call for emergency alerts.
  return { plan: plan.length ? plan : cooling, skipped };
}

/** Full-jitter exponential backoff: uniform in [0, min(max, base·2^attempt)). */
export function backoffDelay(
  attempt,
  {
    baseMs = DEFAULTS.backoffBaseMs,
    maxMs = DEFAULTS.backoffMaxMs,
    random = Math.random,
  } = {},
) {
  return Math.floor(random() * Math.min(maxMs, baseMs * 2 ** attempt));
}

// ── adapters: each resolves to { kind, send(text)|null, close() } ─────────────

function openWebTransport(url, ctx) {
  const wt = new ctx.globals.WebTransport(url);
  let closedByUs = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = ctx.timers.setTimeout(
      () => reject(new Error("webtransport: connect timeout")),
      ctx.connectTimeoutMs,
    );
  });
  return Promise.race([wt.ready, timeout]).then(
    () => {
      ctx.timers.clearTimeout(timer);
      const decoder = new TextDecoder();
      const readStream = async (stream) => {
        const reader = stream.getReader();
        let text = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
        ctx.onFrame(text + decoder.decode());
      };
      (async () => {
        const incoming = wt.incomingUnidirectionalStreams.getReader();
        for (;;) {
          const { value, done } = await incoming.read();
          if (done) return;
          // Not awaited: streams complete independently, which is the whole point.
          readStream(value).catch(() => {});
        }
      })().catch(() => {});
      wt.closed.then(
        () => !closedByUs && ctx.onClose("webtransport closed"),
        (err) =>
          !closedByUs && ctx.onClose(`webtransport ${err?.message ?? "error"}`),
      );
      const encoder = new TextEncoder();
      return {
        kind: "webtransport",
        async send(text) {
          const stream = await wt.createUnidirectionalStream();
          const writer = stream.getWriter();
          await writer.write(encoder.encode(text));
          await writer.close();
        },
        close() {
          closedByUs = true;
          try {
            wt.close();
          } catch {
            /* already closed */
          }
        },
      };
    },
    (err) => {
      ctx.timers.clearTimeout(timer);
      closedByUs = true;
      try {
        wt.close();
      } catch {
        /* never opened */
      }
      throw err;
    },
  );
}

function openWebSocket(url, ctx) {
  return new Promise((resolve, reject) => {
    const ws = new ctx.globals.WebSocket(url);
    let opened = false;
    let done = false; // closed by us or already reported
    const fail = (why) => {
      if (done) return;
      done = true;
      ctx.timers.clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error(`websocket: ${why}`));
    };
    const timer = ctx.timers.setTimeout(
      () => fail("connect timeout"),
      ctx.connectTimeoutMs,
    );
    ws.onopen = () => {
      opened = true;
      ctx.timers.clearTimeout(timer);
      resolve({
        kind: "websocket",
        send: (text) => ws.send(text),
        close() {
          done = true;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      });
    };
    ws.onmessage = (e) => typeof e.data === "string" && ctx.onFrame(e.data);
    ws.onerror = () => !opened && fail("error");
    ws.onclose = (e) => {
      if (!opened) return fail(`closed ${e?.code ?? ""}`.trim());
      if (done) return;
      done = true;
      ctx.onClose(`websocket closed ${e?.code ?? ""}`.trim());
    };
  });
}

function openEventSource(url, ctx) {
  return new Promise((resolve, reject) => {
    const es = new ctx.globals.EventSource(url);
    let opened = false;
    let done = false;
    const timer = ctx.timers.setTimeout(() => {
      if (done) return;
      done = true;
      es.close();
      reject(new Error("sse: connect timeout"));
    }, ctx.connectTimeoutMs);
    es.onopen = () => {
      opened = true;
      ctx.timers.clearTimeout(timer);
      resolve({
        kind: "sse",
        send: null,
        close() {
          done = true;
          es.close();
        },
      });
    };
    es.onmessage = (e) => ctx.onFrame(e.data);
    es.onerror = () => {
      // EventSource would silently retry on its own fixed delay. Take over, so
      // the controller applies its backoff and can upgrade back to WT/WS.
      es.close();
      if (done) return;
      done = true;
      ctx.timers.clearTimeout(timer);
      if (!opened) reject(new Error("sse: error"));
      else ctx.onClose("sse error");
    };
  });
}

const OPENERS = {
  webtransport: openWebTransport,
  websocket: openWebSocket,
  sse: openEventSource,
};

/**
 * @param {object} options
 * @param {{webTransport?: string, webSocket?: string, sse?: string}} options.endpoints
 * @param {(msg: object) => void} options.onMessage
 * @param {(status: {state: string, transport: string|null, reason?: string}) => void} [options.onStatus]
 * @param {object} [options.globals]  WebTransport/WebSocket/EventSource/navigator source (tests inject fakes)
 * @param {EventTarget} [options.network]  receives `online`/`offline` (defaults to globals)
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers]
 * @param {() => number} [options.now]
 * @param {() => number} [options.random]
 */
export function createNetworkTransport(options) {
  const cfg = { ...DEFAULTS, ...options };
  const globals = options.globals ?? globalThis;
  const timers = options.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  };
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const network =
    options.network ??
    (typeof globals.addEventListener === "function" ? globals : null);
  const connection = globals.navigator?.connection ?? null;

  let state = "idle";
  let conn = null;
  let generation = 0; // bumps on every (re)connect so stale async results are ignored
  let attempt = 0;
  let offline = false;
  let lowPower = false;
  let retryTimer = null;
  let heartbeatTimer = null;
  let pongTimer = null;
  let graceTimer = null;
  let lastInboundAt = 0;
  let disconnectedAt = null;
  let lastId = null;
  let lastConnectionType =
    connection?.type ?? connection?.effectiveType ?? null;
  const health = {};
  const seen = new Set();
  const seenOrder = [];
  const metrics = {
    connects: 0,
    fallbacks: 0,
    reconnectGapsMs: [],
    messages: 0,
    duplicatesDropped: 0,
    heartbeatsSent: 0,
    networkChanges: 0,
    migrationsSurvived: 0,
    failures: { webtransport: 0, websocket: 0, sse: 0 },
  };

  const setState = (next, reason) => {
    state = next;
    options.onStatus?.({
      state,
      transport: conn?.kind ?? null,
      ...(reason ? { reason } : {}),
    });
  };
  const clear = (t) => t !== null && timers.clearTimeout(t);

  function remember(id) {
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > cfg.dedupeWindow) seen.delete(seenOrder.shift());
  }

  function onFrame(text) {
    lastInboundAt = now();
    clear(pongTimer);
    pongTimer = null;
    if (graceTimer !== null) {
      // Traffic arrived after an interface switch: the session migrated.
      clear(graceTimer);
      graceTimer = null;
      metrics.migrationsSurvived++;
    }
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // malformed frame: ignore rather than tear down the link
    }
    if (msg?.type === "pong") return;
    if (msg?.id != null) {
      if (seen.has(msg.id)) {
        metrics.duplicatesDropped++;
        return;
      }
      remember(msg.id);
      lastId = msg.id;
    }
    metrics.messages++;
    options.onMessage?.(msg);
  }

  function stopHeartbeat() {
    clear(heartbeatTimer);
    clear(pongTimer);
    clear(graceTimer);
    heartbeatTimer = pongTimer = graceTimer = null;
  }

  function ping() {
    if (!conn?.send) return;
    metrics.heartbeatsSent++;
    const sentAt = now();
    Promise.resolve()
      .then(() => conn?.send(JSON.stringify({ type: "ping", t: sentAt })))
      .catch(() => {});
    clear(pongTimer);
    pongTimer = timers.setTimeout(() => {
      pongTimer = null;
      if (lastInboundAt < sentAt) reconnectNow("heartbeat timeout");
    }, cfg.heartbeatTimeoutMs);
  }

  function scheduleHeartbeat() {
    clear(heartbeatTimer);
    heartbeatTimer = null;
    if (!conn?.send) return; // SSE is receive-only; EventSource errors cover liveness
    heartbeatTimer = timers.setTimeout(
      () => {
        ping();
        scheduleHeartbeat();
      },
      lowPower ? cfg.lowPowerHeartbeatMs : cfg.heartbeatMs,
    );
  }

  function onUnexpectedClose(gen, reason) {
    if (gen !== generation || state === "stopped") return;
    conn = null;
    stopHeartbeat();
    disconnectedAt ??= now();
    setState("reconnecting", reason);
    scheduleReconnect(false);
  }

  function dropConnection() {
    generation++;
    stopHeartbeat();
    if (conn) {
      conn.close();
      conn = null;
      disconnectedAt ??= now();
    }
  }

  function scheduleReconnect(immediate) {
    clear(retryTimer);
    retryTimer = null;
    if (state === "stopped" || offline) return;
    const delay = immediate
      ? 0
      : backoffDelay(attempt++, {
          baseMs: cfg.backoffBaseMs,
          maxMs: cfg.backoffMaxMs,
          random,
        });
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function reconnectNow(reason) {
    if (state === "stopped") return;
    dropConnection();
    attempt = 0;
    setState("reconnecting", reason);
    scheduleReconnect(true);
  }

  async function connect() {
    if (state === "stopped" || offline) return;
    const gen = ++generation;
    setState(state === "idle" ? "connecting" : "reconnecting");
    const { plan } = selectTransports({
      endpoints: cfg.endpoints,
      capabilities: detectCapabilities(globals),
      health,
      now: now(),
      maxFailures: cfg.maxFailures,
      cooldownMs: cfg.cooldownMs,
    });
    for (let i = 0; i < plan.length; i++) {
      const { kind, url } = plan[i];
      const ctx = {
        globals,
        timers,
        connectTimeoutMs: cfg.connectTimeoutMs,
        onFrame: (text) => gen === generation && onFrame(text),
        onClose: (reason) => onUnexpectedClose(gen, reason),
      };
      try {
        const c = await OPENERS[kind](url, ctx);
        if (gen !== generation || state === "stopped") {
          c.close(); // superseded while connecting
          return;
        }
        conn = c;
        health[kind] = { failures: 0, lastFailureAt: 0 };
        metrics.connects++;
        if (i > 0) metrics.fallbacks++;
        if (disconnectedAt !== null) {
          metrics.reconnectGapsMs.push(now() - disconnectedAt);
          disconnectedAt = null;
        }
        attempt = 0;
        lastInboundAt = now();
        if (conn.send && lastId != null) {
          Promise.resolve()
            .then(() => conn?.send(JSON.stringify({ type: "resume", lastId })))
            .catch(() => {});
        }
        scheduleHeartbeat();
        setState("open");
        return;
      } catch {
        if (gen !== generation) return;
        const h = (health[kind] ??= { failures: 0, lastFailureAt: 0 });
        h.failures++;
        h.lastFailureAt = now();
        metrics.failures[kind]++;
      }
    }
    if (gen === generation) {
      disconnectedAt ??= now();
      setState("reconnecting", "all transports failed");
      scheduleReconnect(false);
    }
  }

  // ── network & power signals ──────────────────────────────────────────────────

  const onOffline = () => {
    offline = true;
    clear(retryTimer);
    retryTimer = null;
    dropConnection();
    setState("offline");
  };

  const onOnline = () => {
    offline = false;
    if (conn) return; // still connected; heartbeat will vouch for it
    attempt = 0;
    scheduleReconnect(true);
  };

  const onConnectionChange = () => {
    const type = connection?.type ?? connection?.effectiveType ?? null;
    if (type === lastConnectionType) return;
    lastConnectionType = type;
    metrics.networkChanges++;
    if (!conn) {
      if (!offline) reconnectNow("network change");
      return;
    }
    if (conn.kind === "webtransport") {
      // QUIC can migrate to the new interface; probe before rebuilding.
      ping();
      clear(graceTimer);
      graceTimer = timers.setTimeout(() => {
        graceTimer = null;
        reconnectNow("network change (migration failed)");
      }, cfg.migrationGraceMs);
    } else {
      // A TCP socket stays bound to the old interface and would hang until a
      // heartbeat timeout; rebuild now.
      reconnectNow("network change");
    }
  };

  function watchBattery() {
    const getBattery = globals.navigator?.getBattery;
    if (typeof getBattery !== "function") return;
    getBattery
      .call(globals.navigator)
      .then((battery) => {
        const update = () => {
          const next = !battery.charging && battery.level <= 0.2;
          if (next !== lowPower) {
            lowPower = next;
            if (conn) scheduleHeartbeat();
          }
        };
        update();
        battery.addEventListener?.("levelchange", update);
        battery.addEventListener?.("chargingchange", update);
      })
      .catch(() => {});
  }

  return {
    start() {
      if (state !== "idle") return;
      network?.addEventListener("offline", onOffline);
      network?.addEventListener("online", onOnline);
      connection?.addEventListener?.("change", onConnectionChange);
      watchBattery();
      if (globals.navigator?.onLine === false) {
        offline = true;
        setState("offline");
        return;
      }
      connect();
    },
    stop() {
      state = "stopped";
      clear(retryTimer);
      retryTimer = null;
      dropConnection();
      network?.removeEventListener("offline", onOffline);
      network?.removeEventListener("online", onOnline);
      connection?.removeEventListener?.("change", onConnectionChange);
      options.onStatus?.({ state, transport: null });
    },
    /** Sends a JSON message; returns false on receive-only or closed transports. */
    send(msg) {
      if (!conn?.send) return false;
      Promise.resolve()
        .then(() => conn?.send(JSON.stringify(msg)))
        .catch(() => {});
      return true;
    },
    get state() {
      return state;
    },
    get transport() {
      return conn?.kind ?? null;
    },
    get lowPower() {
      return lowPower;
    },
    getMetrics() {
      return {
        ...metrics,
        reconnectGapsMs: [...metrics.reconnectGapsMs],
        failures: { ...metrics.failures },
      };
    },
  };
}
