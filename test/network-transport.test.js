// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  backoffDelay,
  createNetworkTransport,
  detectCapabilities,
  selectTransports,
} from "../src/services/networkTransport.js";

const ENDPOINTS = {
  webTransport: "https://alerts.test:4433/alerts",
  webSocket: "wss://alerts.test/alerts",
  sse: "https://api.test/events/stream",
};

// ── fakes ─────────────────────────────────────────────────────────────────────

function makeWebSocket(behavior = () => "open") {
  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      instances.push(this);
      const mode = behavior(instances.length - 1);
      queueMicrotask(() => {
        if (mode === "open") this.onopen?.();
        else if (mode === "fail") {
          this.onerror?.();
          this.onclose?.({ code: 1006 });
        }
        // "hang": never opens
      });
    }
    send(t) {
      this.sent.push(JSON.parse(t));
    }
    close() {
      this.closed = true;
    }
    emit(obj) {
      this.onmessage?.({ data: JSON.stringify(obj) });
    }
    drop(code = 1006) {
      this.onclose?.({ code });
    }
  }
  FakeWebSocket.instances = instances;
  return FakeWebSocket;
}

function makeWebTransport(behavior = () => "open") {
  const instances = [];
  const enc = new TextEncoder();
  class FakeWebTransport {
    constructor(url) {
      this.url = url;
      this.sent = [];
      instances.push(this);
      let pushStream;
      this.incomingUnidirectionalStreams = new ReadableStream({
        start: (c) => (pushStream = c),
      });
      this._push = pushStream;
      this.closed = new Promise((res, rej) => {
        this._closeOk = res;
        this._closeErr = rej;
      });
      this.closed.catch(() => {});
      const mode = behavior(instances.length - 1);
      this.ready =
        mode === "open"
          ? Promise.resolve()
          : mode === "fail"
            ? Promise.reject(new Error("QUIC blocked"))
            : new Promise(() => {});
      this.ready.catch(() => {});
    }
    /** Server pushes one message on its own unidirectional stream, optionally split in chunks. */
    emit(obj, chunks = 1) {
      const bytes = enc.encode(JSON.stringify(obj));
      const size = Math.ceil(bytes.length / chunks);
      this._push.enqueue(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < bytes.length; i += size)
              c.enqueue(bytes.slice(i, i + size));
            c.close();
          },
        }),
      );
    }
    async createUnidirectionalStream() {
      const dec = new TextDecoder();
      let text = "";
      return new WritableStream({
        write: (chunk) => {
          text += dec.decode(chunk, { stream: true });
        },
        close: () => {
          this.sent.push(JSON.parse(text + dec.decode()));
        },
      });
    }
    close() {
      this.closedByClient = true;
    }
    drop() {
      this._closeErr(new Error("idle timeout"));
    }
  }
  FakeWebTransport.instances = instances;
  return FakeWebTransport;
}

function makeEventSource(behavior = () => "open") {
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      instances.push(this);
      const mode = behavior(instances.length - 1);
      queueMicrotask(() => {
        if (mode === "open") this.onopen?.();
        else if (mode === "fail") this.onerror?.();
      });
    }
    close() {
      this.closed = true;
    }
    emit(obj) {
      this.onmessage?.({ data: JSON.stringify(obj) });
    }
  }
  FakeEventSource.instances = instances;
  return FakeEventSource;
}

function makeNavigator({ type = "wifi", onLine = true, battery } = {}) {
  const connection = new EventTarget();
  connection.type = type;
  return {
    onLine,
    connection,
    ...(battery ? { getBattery: () => Promise.resolve(battery) } : {}),
  };
}

function setup({
  WebTransport,
  WebSocket,
  EventSource,
  navigator = makeNavigator(),
  ...opts
} = {}) {
  const network = new EventTarget();
  const messages = [];
  const statuses = [];
  const globals = { WebTransport, WebSocket, EventSource, navigator };
  const t = createNetworkTransport({
    endpoints: ENDPOINTS,
    globals,
    network,
    random: () => 0.5,
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    ...opts,
  });
  return { t, network, navigator, messages, statuses };
}

// 1 ms, not 0: fake timers schedule a 0 ms timeout created *during* a tick at
// +1 ms, and the reconnect after a heartbeat/grace timeout is exactly that.
const flush = () => vi.advanceTimersByTimeAsync(1);

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

// ── decision tree ─────────────────────────────────────────────────────────────

describe("selectTransports", () => {
  const all = { webTransport: true, webSocket: true, eventSource: true };

  it("prefers WebTransport, then WebSocket, then SSE", () => {
    const { plan } = selectTransports({
      endpoints: ENDPOINTS,
      capabilities: all,
    });
    expect(plan.map((p) => p.kind)).toEqual([
      "webtransport",
      "websocket",
      "sse",
    ]);
  });

  it("skips transports the browser lacks (e.g. Safari without WebTransport)", () => {
    const { plan, skipped } = selectTransports({
      endpoints: ENDPOINTS,
      capabilities: { ...all, webTransport: false },
    });
    expect(plan.map((p) => p.kind)).toEqual(["websocket", "sse"]);
    expect(skipped).toContainEqual({
      kind: "webtransport",
      reason: "unsupported",
    });
  });

  it("skips transports without an endpoint", () => {
    const { plan } = selectTransports({
      endpoints: { sse: ENDPOINTS.sse },
      capabilities: all,
    });
    expect(plan.map((p) => p.kind)).toEqual(["sse"]);
  });

  it("cools down a transport after repeated failures, then retries it", () => {
    const health = { webtransport: { failures: 2, lastFailureAt: 1_000 } };
    const during = selectTransports({
      endpoints: ENDPOINTS,
      capabilities: all,
      health,
      now: 1_000 + 60_000,
    });
    expect(during.plan[0].kind).toBe("websocket");
    expect(during.skipped).toContainEqual({
      kind: "webtransport",
      reason: "cooldown",
    });
    const after = selectTransports({
      endpoints: ENDPOINTS,
      capabilities: all,
      health,
      now: 1_000 + 5 * 60_000,
    });
    expect(after.plan[0].kind).toBe("webtransport");
  });

  it("never returns an empty plan while something usable is merely cooling down", () => {
    const health = { sse: { failures: 5, lastFailureAt: 0 } };
    const { plan } = selectTransports({
      endpoints: { sse: ENDPOINTS.sse },
      capabilities: all,
      health,
      now: 1,
    });
    expect(plan.map((p) => p.kind)).toEqual(["sse"]);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially with full jitter and caps at maxMs", () => {
    expect(backoffDelay(0, { random: () => 0.999 })).toBe(499);
    expect(backoffDelay(3, { random: () => 0.999 })).toBe(3996);
    expect(backoffDelay(20, { random: () => 0.999 })).toBe(29_970);
    expect(backoffDelay(5, { random: () => 0 })).toBe(0);
  });
});

describe("detectCapabilities", () => {
  it("reads constructors from the given global", () => {
    expect(detectCapabilities({ WebSocket: class {} })).toEqual({
      webTransport: false,
      webSocket: true,
      eventSource: false,
    });
  });
});

// ── controller ────────────────────────────────────────────────────────────────

describe("createNetworkTransport", () => {
  it("connects over WebTransport and delivers each stream's alert independently", async () => {
    const WT = makeWebTransport();
    const { t, messages } = setup({
      WebTransport: WT,
      WebSocket: makeWebSocket(),
    });
    t.start();
    await flush();
    expect(t.transport).toBe("webtransport");
    WT.instances[0].emit({ id: "a1", topic: "RqCreated" }, 3);
    WT.instances[0].emit({ id: "a2", topic: "RqAcptd" });
    await flush();
    expect(messages.map((m) => m.id).sort()).toEqual(["a1", "a2"]);
  });

  it("falls back to WebSocket when QUIC is blocked, and cools WebTransport down", async () => {
    const WT = makeWebTransport(() => "fail");
    const WS = makeWebSocket();
    const { t } = setup({ WebTransport: WT, WebSocket: WS });
    t.start();
    await flush();
    expect(t.transport).toBe("websocket");
    expect(t.getMetrics()).toMatchObject({
      fallbacks: 1,
      failures: { webtransport: 1 },
    });

    // Second failure puts WebTransport into cooldown: the next reconnect skips it.
    WS.instances[0].drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(WT.instances).toHaveLength(2);
    WS.instances[1].drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(WT.instances).toHaveLength(2);
    expect(t.transport).toBe("websocket");
  });

  it("treats a WebTransport handshake that never completes as a failure after connectTimeoutMs", async () => {
    const WT = makeWebTransport(() => "hang");
    const WS = makeWebSocket();
    const { t } = setup({
      WebTransport: WT,
      WebSocket: WS,
      connectTimeoutMs: 3_000,
    });
    t.start();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(t.transport).toBe(null);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.transport).toBe("websocket");
    expect(WT.instances[0].closedByClient).toBe(true);
  });

  it("falls all the way back to the existing SSE stream", async () => {
    const ES = makeEventSource();
    const { t, messages } = setup({
      WebSocket: makeWebSocket(() => "fail"),
      EventSource: ES,
    });
    t.start();
    await flush();
    expect(t.transport).toBe("sse");
    ES.instances[0].emit({ topic: "Arrived", ledger: 9, id: "0000-1" });
    expect(messages).toEqual([{ topic: "Arrived", ledger: 9, id: "0000-1" }]);
    expect(t.send({ type: "x" })).toBe(false);
  });

  it("reconnects with jittered backoff after an unexpected close and records the gap", async () => {
    const WS = makeWebSocket((i) => (i === 1 ? "fail" : "open"));
    const { t } = setup({ WebSocket: WS });
    t.start();
    await flush();
    WS.instances[0].drop();
    // attempt 0: 0.5 * 500 = 250 ms; the retry fails, attempt 1: 0.5 * 1000 = 500 ms
    await vi.advanceTimersByTimeAsync(249);
    expect(WS.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(WS.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(WS.instances).toHaveLength(3);
    expect(t.state).toBe("open");
    expect(t.getMetrics().reconnectGapsMs).toEqual([750]);
  });

  it("drops duplicate alerts and resumes from the last id after reconnecting", async () => {
    const WS = makeWebSocket();
    const { t, messages } = setup({ WebSocket: WS });
    t.start();
    await flush();
    WS.instances[0].emit({ id: 1 });
    WS.instances[0].emit({ id: 2 });
    WS.instances[0].drop();
    await vi.advanceTimersByTimeAsync(250);
    const ws = WS.instances[1];
    await flush();
    expect(ws.sent).toContainEqual({ type: "resume", lastId: 2 });
    ws.emit({ id: 2 }); // server replays the overlap
    ws.emit({ id: 3 });
    expect(messages.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(t.getMetrics().duplicatesDropped).toBe(1);
  });

  it("rebuilds a TCP transport immediately on a WiFi→LTE switch", async () => {
    const WS = makeWebSocket();
    const { t, navigator } = setup({ WebSocket: WS });
    t.start();
    await flush();
    navigator.connection.type = "cellular";
    navigator.connection.dispatchEvent(new Event("change"));
    expect(WS.instances[0].closed).toBe(true);
    await flush();
    expect(WS.instances).toHaveLength(2);
    expect(t.getMetrics()).toMatchObject({ networkChanges: 1 });
    expect(t.getMetrics().reconnectGapsMs).toEqual([0]);
  });

  it("keeps a WebTransport session that survives the switch via QUIC migration", async () => {
    const WT = makeWebTransport();
    const { t, navigator } = setup({ WebTransport: WT });
    t.start();
    await flush();
    navigator.connection.type = "cellular";
    navigator.connection.dispatchEvent(new Event("change"));
    await flush();
    expect(WT.instances[0].sent.at(-1)).toMatchObject({ type: "ping" });
    WT.instances[0].emit({ type: "pong" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(WT.instances).toHaveLength(1);
    expect(t.getMetrics().migrationsSurvived).toBe(1);
  });

  it("rebuilds a WebTransport session that does not answer within the migration grace", async () => {
    const WT = makeWebTransport();
    const { t, navigator } = setup({ WebTransport: WT });
    t.start();
    await flush();
    navigator.connection.type = "cellular";
    navigator.connection.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(1_500);
    await flush();
    expect(WT.instances).toHaveLength(2);
    expect(t.transport).toBe("webtransport");
  });

  it("detects a silently dead link by heartbeat timeout", async () => {
    const WS = makeWebSocket();
    const { t } = setup({ WebSocket: WS });
    t.start();
    await flush();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(WS.instances[0].sent).toContainEqual({ type: "ping", t: 1_025_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(WS.instances[0].closed).toBe(true);
    await flush();
    expect(WS.instances).toHaveLength(2);
  });

  it("keeps a link alive while pongs arrive", async () => {
    const WS = makeWebSocket();
    const { t } = setup({ WebSocket: WS });
    t.start();
    await flush();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      WS.instances[0].emit({ type: "pong" });
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(WS.instances).toHaveLength(1);
    expect(t.getMetrics().heartbeatsSent).toBe(3);
  });

  it("stretches heartbeats on low battery", async () => {
    const battery = Object.assign(new EventTarget(), {
      charging: false,
      level: 0.1,
    });
    const WS = makeWebSocket();
    const { t } = setup({
      WebSocket: WS,
      navigator: makeNavigator({ battery }),
    });
    t.start();
    await flush();
    expect(t.lowPower).toBe(true);
    await vi.advanceTimersByTimeAsync(59_000); // well past the normal 25 s cadence
    expect(t.getMetrics().heartbeatsSent).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.getMetrics().heartbeatsSent).toBe(1);
  });

  it("stays quiet while offline and reconnects at once when back online", async () => {
    const WS = makeWebSocket();
    const { t, network } = setup({ WebSocket: WS });
    t.start();
    await flush();
    network.dispatchEvent(new Event("offline"));
    expect(t.state).toBe("offline");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(WS.instances).toHaveLength(1);
    network.dispatchEvent(new Event("online"));
    await flush();
    expect(WS.instances).toHaveLength(2);
    expect(t.state).toBe("open");
  });

  it("stop() closes the link and cancels pending retries", async () => {
    const WS = makeWebSocket((i) => (i === 0 ? "open" : "fail"));
    const { t, statuses } = setup({ WebSocket: WS });
    t.start();
    await flush();
    WS.instances[0].drop();
    t.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(WS.instances).toHaveLength(1);
    expect(statuses.at(-1)).toEqual({ state: "stopped", transport: null });
  });
});
