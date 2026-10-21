import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { requestMetrics, renderMetrics, resetMetrics } from "../middleware/metrics.js";
import { connectEventBus, publishContractEvent } from "../lib/redisPubSub.js";
import { attachWebSocketRelay } from "../routes/wsCluster.js";

test("Prometheus endpoint data includes bounded HTTP request histograms", () => {
  resetMetrics();
  const req = { method: "GET", baseUrl: "/api", route: { path: "/events" } };
  const res = new EventEmitter();
  res.statusCode = 200;
  requestMetrics(req, res, () => {});
  res.emit("finish");

  const output = renderMetrics();
  assert.match(output, /# TYPE helphone_http_requests_total counter/);
  assert.match(output, /# TYPE helphone_http_request_duration_seconds histogram/);
  assert.match(output, /helphone_http_request_duration_seconds_bucket\{method="GET",route="\/api\/events",status="200",le="\+Inf"\} 1/);
});

test("WebSocket relay applies topic and tenant filters and emits health heartbeats", async () => {
  await connectEventBus({ redisUrl: "" });
  const server = createServer();
  const relay = attachWebSocketRelay(server, { heartbeatMs: 1000 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/events/ws?tenant=team-a`);
  const messages = [];
  socket.on("message", (value) => messages.push(JSON.parse(value.toString())));

  try {
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    socket.send(JSON.stringify({ type: "subscribe", topics: ["RqCreated"] }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await publishContractEvent({ topic: "RqCreated", ledger: 4, id: "event-other", tenantId: "team-b" });
    await publishContractEvent({ topic: "LocUpd", ledger: 5, id: "event-wrong-topic", tenantId: "team-a" });
    await publishContractEvent({ topic: "RqCreated", ledger: 6, id: "event-match", tenantId: "team-a" });
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.ok(messages.some((message) => message.type === "subscribed"));
    assert.deepEqual(
      messages.filter((message) => message.type === "contract-event").map((message) => message.id),
      ["event-match"],
    );
  } finally {
    socket.close();
    await relay.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
