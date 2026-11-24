import { Router, raw } from "express";
import { TELEMETRY_BUDGETS, verifyIngest } from "../telemetry.js";

/** Low-rate JSON event APIs plus the binary-frame ingest fallback (ADR-014). */
export const eventsRouter = Router();

eventsRouter.get("/ice-config", (_req, res) => {
  const urls = (process.env.TURN_URLS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  res.set("Cache-Control", "no-store").json({
    iceServers: [
      {
        urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"],
      },
      ...(urls.length
        ? [
            {
              urls,
              username: process.env.TURN_USERNAME,
              credential: process.env.TURN_CREDENTIAL,
            },
          ]
        : []),
    ],
    fallback: { transport: "websocket", endpoint: "/api/events/frame-stream" },
  });
});

eventsRouter.post("/ice-metrics", (req, res) => {
  const { gatheringMs, success, hasRelay } = req.body || {};
  if (
    !Number.isFinite(gatheringMs) ||
    typeof success !== "boolean" ||
    typeof hasRelay !== "boolean"
  ) {
    res.status(400).json({ error: "invalid ICE metric" });
    return;
  }
  console.info("[ice-metric]", { gatheringMs, success, hasRelay });
  res.status(202).json({ accepted: true });
});

// Discovery/budgets stay JSON; only the high-rate live position stream is binary.
eventsRouter.get("/frames/config", (_req, res) => {
  res.set("Cache-Control", "no-store").json({
    transport: "websocket",
    endpoint: "/api/events/frame-stream",
    binaryType: "arraybuffer",
    fileIdentifier: "HPTL",
    ...TELEMETRY_BUDGETS,
  });
});

// HTTP fallback ingest. Verification never throws: malformed frames get 400
// and never reach the main path or a WebSocket subscriber.
eventsRouter.post(
  "/frames",
  raw({ type: () => true, limit: TELEMETRY_BUDGETS.maxFrameBytes }),
  (req, res) => {
    const body =
      req.body instanceof Uint8Array ? req.body : Buffer.from(req.body || "");
    const result = verifyIngest(body);
    if (!result.ok) {
      res.status(400).json({ accepted: false, error: result.error });
      return;
    }
    res.status(202).json({
      accepted: true,
      objectCount: result.objectCount,
      byteLength: result.byteLength,
    });
  },
);
