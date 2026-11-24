/**
 * Server-side telemetry frames (ADR-014 follow-up 2).
 *
 * The browser keeps JSON for low-rate APIs (ICE config/metrics, request
 * details). High-rate live positions go out as binary FlatBuffers frames over
 * the same WebSocket fallback path. Every outbound frame is built with the
 * official `flatbuffers` Builder and every inbound frame is verified before it
 * reaches the main path; a RangeError is always a dropped frame, never a
 * partially encoded one.
 */

import { WebSocketServer } from "ws";
import {
  FILE_IDENTIFIER,
  MAX_FRAME_BYTES,
  MAX_OBJECTS_PER_FRAME,
  SCHEMA_VERSION,
  encodeTelemetryFrame,
  verifyFrame,
} from "../src/lib/telemetryFrame.js";

export const TELEMETRY_WS_PATH = "/api/events/frame-stream";

export const TELEMETRY_BUDGETS = Object.freeze({
  maxObjectsPerFrame: MAX_OBJECTS_PER_FRAME,
  maxFrameBytes: MAX_FRAME_BYTES,
  maxFramesPerSecond: 30,
  maxClients: 200,
});

/**
 * Budgeted frame encoder.
 *
 * Enforces both the per-frame object cap and a rolling one-second frame-rate
 * budget. `RangeError` from the codec is swallowed and counted as a drop so a
 * burst can never take down the request path.
 */
export function createFrameEncoder({
  now = () => Date.now(),
  budgets = TELEMETRY_BUDGETS,
} = {}) {
  let seq = 0;
  let windowStart = now();
  let framesInWindow = 0;
  let dropped = 0;
  let encoded = 0;
  let bytes = 0;
  let rangeErrors = 0;

  return {
    encode(objects, meta = {}) {
      if (
        !Array.isArray(objects) ||
        objects.length > budgets.maxObjectsPerFrame
      ) {
        dropped++;
        return null;
      }
      const current = now();
      if (current - windowStart >= 1000) {
        windowStart = current;
        framesInWindow = 0;
      }
      if (framesInWindow >= budgets.maxFramesPerSecond) {
        dropped++;
        return null;
      }
      try {
        const frame = encodeTelemetryFrame(objects, {
          tsSec: Math.floor(current / 1000),
          seq: seq++,
          ...meta,
        });
        if (frame.byteLength > budgets.maxFrameBytes) {
          dropped++;
          return null;
        }
        framesInWindow++;
        encoded++;
        bytes += frame.byteLength;
        return frame;
      } catch (err) {
        if (err instanceof RangeError) {
          rangeErrors++;
          dropped++;
          return null;
        }
        throw err;
      }
    },

    stats() {
      return {
        encoded,
        dropped,
        rangeErrors,
        bytes,
        framesPerSecondBudget: budgets.maxFramesPerSecond,
        maxObjectsPerFrame: budgets.maxObjectsPerFrame,
        maxFrameBytes: budgets.maxFrameBytes,
        identifier: FILE_IDENTIFIER,
        schemaVersion: SCHEMA_VERSION,
      };
    },
  };
}

/**
 * Ingest gate. Never throws: the caller drops the frame on `ok: false`.
 */
export function verifyIngest(input, budgets = TELEMETRY_BUDGETS) {
  return verifyFrame(input, { maxFrameBytes: budgets.maxFrameBytes });
}

/**
 * Attach the binary frame stream to an existing HTTP server.
 *
 * Clients must set `WebSocket.binaryType = 'arraybuffer'` so frames arrive as
 * ArrayBuffer rather than Blob (the in-repo reader consumes both, but the
 * arraybuffer path avoids a copy on the main thread).
 */
export function attachTelemetryWebSocket(
  server,
  { budgets = TELEMETRY_BUDGETS, logger = console } = {},
) {
  const wss = new WebSocketServer({
    noServer: true,
    path: TELEMETRY_WS_PATH,
    maxPayload: budgets.maxFrameBytes,
  });

  const onUpgrade = (request, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(request.url || "", "http://localhost").pathname;
    } catch {
      return;
    }
    if (pathname !== TELEMETRY_WS_PATH) return;
    if (wss.clients.size >= budgets.maxClients) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.binaryType = "arraybuffer";
      wss.emit("connection", ws, request);
    });
  };
  server.on("upgrade", onUpgrade);

  wss.on("connection", (ws) => {
    ws.binaryType = "arraybuffer";
    // Verified frames from clients are relayed verbatim to peers. Malformed
    // frames are dropped here and never reach a subscriber or the main path.
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const result = verifyIngest(data, budgets);
      if (!result.ok) {
        logger.warn?.(
          "[telemetry] dropped malformed ingest frame:",
          result.error,
        );
        return;
      }
      for (const peer of wss.clients) {
        if (peer !== ws && peer.readyState === 1)
          peer.send(data, { binary: true });
      }
    });
    ws.on("error", () => {});
  });

  return {
    wss,
    path: TELEMETRY_WS_PATH,
    broadcast(frame) {
      const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
      const payload = Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(payload, { binary: true });
      }
    },
    clientCount: () => wss.clients.size,
    close() {
      server.off("upgrade", onUpgrade);
      for (const client of wss.clients) client.close();
      return new Promise((resolve) => wss.close(resolve));
    },
  };
}
