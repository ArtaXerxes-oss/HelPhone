// @vitest-environment node
/** ADR-014 server transport tests: WS binaryType, ingest verification, budgets. */

import { createServer } from "node:http";
import { beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import WebSocket from "ws";
import { server as msw } from "../src/mocks/server.js";

// The WS handshake is a loopback HTTP request; MSW must not swallow it.
beforeAll(() => {
  msw.close();
  msw.listen({ onUnhandledRequest: "bypass" });
});
import {
  TELEMETRY_WS_PATH,
  attachTelemetryWebSocket,
  createFrameEncoder,
  verifyIngest,
} from "../server/telemetry.js";
import {
  encodeTelemetryFrame,
  frameSummary,
  getRootAsFrame,
} from "../src/lib/telemetryFrame.js";
import { createTelemetryClient } from "../src/lib/telemetry.ts";
import { eventsRouter } from "../server/routes/events.js";

const object = (i = 0) => ({
  id: i + 1,
  kind: 0,
  status: 1,
  lat: 6.52 + i / 1000,
  lng: 3.37,
  heading: 90,
  speed: 20,
});

describe("server frame encoder", () => {
  it("rejects an oversized object list without throwing", () => {
    const encoder = createFrameEncoder();
    const frame = encoder.encode(
      Array.from({ length: 1001 }, (_, i) => object(i)),
    );
    expect(frame).toBeNull();
    expect(encoder.stats()).toMatchObject({ dropped: 1, encoded: 0 });
  });

  it("enforces the rate budget and then recovers in the next window", () => {
    const clock = { t: 0 };
    const encoder = createFrameEncoder({ now: () => clock.t });
    for (let i = 0; i < 30; i++)
      expect(encoder.encode([object(i)])).not.toBeNull();
    expect(encoder.encode([object()])).toBeNull();
    clock.t = 1000;
    expect(encoder.encode([object()])).not.toBeNull();
  });

  it("stamps sequence numbers in order", () => {
    const encoder = createFrameEncoder();
    encoder.encode([object()]);
    encoder.encode([object(1)]);
    const frame = encoder.encode([object(2)]);
    expect(frameSummary(frame)).toMatchObject({ objectCount: 1, seq: 2 });
  });
});

describe("ingest verification", () => {
  it("accepts a well-formed frame", () => {
    expect(verifyIngest(encodeTelemetryFrame([object()])).ok).toBe(true);
  });

  it("rejects junk without throwing", () => {
    expect(verifyIngest(new Uint8Array([1, 2, 3])).ok).toBe(false);
    expect(verifyIngest(null).ok).toBe(false);
  });

  it("relays only verified frames over WebSocket", async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, resolve));
    const telemetry = attachTelemetryWebSocket(server);
    const { port } = server.address();
    const url = `ws://127.0.0.1:${port}${TELEMETRY_WS_PATH}`;

    const a = new WebSocket(url);
    const b = new WebSocket(url);
    await Promise.all(
      [a, b].map((ws) => new Promise((resolve) => ws.once("open", resolve))),
    );

    const received = new Promise((resolve) =>
      b.once("message", (data) => resolve(data)),
    );
    const frame = encodeTelemetryFrame([object()]);
    a.send(Buffer.from(frame));

    const data = await received;
    expect(frameSummary(new Uint8Array(data)).ok).toBe(true);

    a.close();
    b.close();
    await telemetry.close();
    await new Promise((resolve) => server.close(resolve));
  }, 15000);
});

describe("HTTP fallback ingest", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);

  it("serves JSON discovery with the binary budgets", async () => {
    const res = await request(app).get("/api/events/frames/config");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      binaryType: "arraybuffer",
      fileIdentifier: "HPTL",
      maxObjectsPerFrame: 1000,
      maxFramesPerSecond: 30,
    });
  });

  it("accepts a valid binary frame", async () => {
    const frame = encodeTelemetryFrame([object()]);
    const res = await request(app)
      .post("/api/events/frames")
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from(frame));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: true, objectCount: 1 });
  });

  it("rejects malformed bytes with 400 without throwing", async () => {
    const res = await request(app)
      .post("/api/events/frames")
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from([1, 2, 3]));
    expect(res.status).toBe(400);
    expect(res.body.accepted).toBe(false);
  });
});

describe("client binary transport", () => {
  it("sets binaryType to arraybuffer before opening", () => {
    const instances = [];
    class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.binaryType = "blob";
        this.closed = false;
        instances.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    const client = createTelemetryClient({
      url: "ws://x",
      WebSocketImpl: FakeWebSocket,
    });
    expect(instances[0].binaryType).toBe("arraybuffer");
    client.close();
    expect(instances[0].closed).toBe(true);
  });

  it("decodes ArrayBuffer frames and drops malformed ones", () => {
    let socket;
    class FakeWebSocket {
      constructor() {
        socket = this;
        this.binaryType = "blob";
      }
      close() {}
    }
    const onFrame = vi.fn();
    const onDropped = vi.fn();
    createTelemetryClient({
      url: "ws://x",
      WebSocketImpl: FakeWebSocket,
      onFrame,
      onDropped,
    });

    const frame = encodeTelemetryFrame([object()]);
    socket.onmessage({
      data: frame.buffer.slice(
        frame.byteOffset,
        frame.byteOffset + frame.byteLength,
      ),
    });
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(
      getRootAsFrame(encodeTelemetryFrame([object()])).objectsLength(),
    ).toBe(1);

    socket.onmessage({ data: new Uint8Array([1, 2, 3]).buffer });
    expect(onDropped).toHaveBeenCalledTimes(1);
  });

  it("routes text frames to the JSON callback", () => {
    let socket;
    class FakeWebSocket {
      constructor() {
        socket = this;
        this.binaryType = "blob";
      }
      close() {}
    }
    const onJson = vi.fn();
    createTelemetryClient({
      url: "ws://x",
      WebSocketImpl: FakeWebSocket,
      onJson,
    });
    socket.onmessage({ data: '{"kind":"config"}' });
    expect(onJson).toHaveBeenCalledWith({ kind: "config" });
  });
});
