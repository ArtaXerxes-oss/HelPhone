import { WebSocketServer, WebSocket } from "ws";
import { subscribeContractEvents, subscribeFlagSnapshots } from "../lib/redisPubSub.js";

const EVENT_TOPICS = new Set(["RqCreated", "RqAcptd", "LocUpd", "Arrived", "Resolved", "Cancelled"]);
const MAX_BUFFERED_BYTES = 1024 * 1024;

export function attachWebSocketRelay(server, { heartbeatMs = 30_000 } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, clientTracking: true });

  server.on("upgrade", (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/events/ws") return;
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });

  wss.on("connection", (client, request) => {
    const tenant = new URL(request.url || "/", "http://localhost").searchParams.get("tenant");
    if (tenant !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(tenant)) {
      client.close(1008, "Invalid tenant filter");
      return;
    }
    const tenantId = tenant;
    const subscription = { tenantId, topics: new Set(EVENT_TOPICS) };
    client.isAlive = true;
    client.on("pong", () => { client.isAlive = true; });
    client.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message?.type === "peer-relay" && message.peerInstance && message.envelope) {
          // Route peer-instance envelope across connected tenants
          let relayed = 0;
          for (const target of wss.clients) {
            if (target !== client && target.readyState === WebSocket.OPEN && target.subscription?.tenantId === message.peerInstance) {
              target.send(JSON.stringify({ type: "peer-relay", fromInstance: tenantId, envelope: message.envelope }));
              relayed++;
            }
          }
          client.send(JSON.stringify({ type: "peer-relay-ack", messageId: message.envelope?.nonce, relayedCount: relayed }));
          return;
        }

        if (message?.type !== "subscribe" || !Array.isArray(message.topics) || message.topics.length > EVENT_TOPICS.size) {
          client.close(1008, "Invalid subscription");
          return;
        }
        if (!message.topics.every((topic) => EVENT_TOPICS.has(topic))) {
          client.close(1008, "Unsupported topic");
          return;
        }
        subscription.topics = new Set(message.topics);
        client.send(JSON.stringify({ type: "subscribed", topics: [...subscription.topics], tenant: tenantId }));
      } catch {
        client.close(1008, "Invalid message");
      }
    });
    client.send(JSON.stringify({ type: "ready", topics: [...subscription.topics], tenant: tenantId }));
    client.subscription = subscription;
  });

  const unsubscribe = subscribeContractEvents((event) => {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > MAX_BUFFERED_BYTES) {
        if (client.readyState === WebSocket.OPEN) client.close(1013, "Client is too slow");
        continue;
      }
      const filter = client.subscription;
      if (!filter?.topics.has(event.topic)) continue;
      if (filter.tenantId && event.tenantId !== filter.tenantId) continue;
      client.send(JSON.stringify({ type: "contract-event", ...event }));
    }
  });

  // Kill-switch push (#797): every connected client gets flag deltas,
  // regardless of topic subscription. Slow clients are skipped, not closed —
  // they still converge via the poll fallback.
  const unsubscribeFlags = subscribeFlagSnapshots((snapshot) => {
    const message = JSON.stringify({ type: "flags.patch", snapshot });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount <= MAX_BUFFERED_BYTES) client.send(message);
    }
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    wss,
    close: async () => {
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribeFlags();
      for (const client of wss.clients) client.close(1001, "Server shutting down");
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}
