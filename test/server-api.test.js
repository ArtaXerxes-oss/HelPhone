import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import express from "express";
import request from "supertest";
import { createRateLimiter, errorHandler } from "../server/index.js";
import { server as mswServer } from "../src/mocks/server.js";

// The global setup (test/setup.js) starts MSW, whose default handlers mock
// `*/api/preferences/:address` and `*/api/feedback`. This file drives *real*
// Express apps over supertest's loopback server, so MSW would answer those
// routes before the request ever reached Express. Turn the interceptor off for
// the whole file; setup.js's afterAll close() is idempotent.
beforeAll(() => mswServer.close());

describe("Express API Endpoints", () => {
  describe("Rate Limiter", () => {
    let app;
    let rateLimiter;

    beforeEach(() => {
      app = express();
      rateLimiter = createRateLimiter({ windowMs: 1000, max: 3 });
      app.use(rateLimiter);
      app.get("/test", (req, res) => res.json({ success: true }));
    });

    it("should allow requests within rate limit", async () => {
      const res1 = await request(app).get("/test");
      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);

      const res2 = await request(app).get("/test");
      expect(res2.status).toBe(200);
    });

    it("should block requests exceeding rate limit", async () => {
      // Make 3 requests (at limit)
      await request(app).get("/test");
      await request(app).get("/test");
      await request(app).get("/test");

      // 4th request should be blocked
      const res = await request(app).get("/test");
      expect(res.status).toBe(429);
      expect(res.body.error).toContain("Too many requests");
    });

    it("should set rate limit headers", async () => {
      const res = await request(app).get("/test");
      expect(res.headers["x-ratelimit-limit"]).toBe("3");
      expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
      expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    });

    it("should reset rate limit after window expires", async () => {
      // Make 3 requests
      await request(app).get("/test");
      await request(app).get("/test");
      await request(app).get("/test");

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should allow new requests
      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
    });
  });

  describe("Error Handler", () => {
    let app;

    beforeEach(() => {
      app = express();
      app.get("/error", () => {
        const err = new Error("Test error");
        err.status = 400;
        throw err;
      });
      app.use(errorHandler);
    });

    it("should format errors as JSON", async () => {
      const res = await request(app).get("/error");
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
    });

    it("should hide error details in production", async () => {
      process.env.NODE_ENV = "production";
      const res = await request(app).get("/error");
      expect(res.body.error).toBe("Internal server error");
      process.env.NODE_ENV = "test";
    });
  });

  describe("Preferences API", () => {
    let app;

    beforeEach(() => {
      app = express();
      app.use(express.json());

      // Mock preferences store
      const preferencesStore = new Map();

      const ALLOWED_PREF_KEYS = new Set([
        "nickname",
        "contact",
        "gender",
        "mapStyleIndex",
        "selectedChar",
        "notificationsEnabled",
        "language",
      ]);

      function sanitizePreferences(raw) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
        const clean = {};
        for (const key of ALLOWED_PREF_KEYS) {
          if (Object.prototype.hasOwnProperty.call(raw, key)) {
            clean[key] = raw[key];
          }
        }
        return clean;
      }

      function isValidStellarAddress(addr) {
        return typeof addr === "string" && /^G[A-Z2-7]{55}$/.test(addr);
      }

      app.get("/api/preferences/:address", (req, res) => {
        const { address } = req.params;
        if (!isValidStellarAddress(address)) {
          return res.status(400).json({ error: "Invalid Stellar address" });
        }
        const prefs = preferencesStore.get(address) || {};
        res.json({ address, preferences: prefs });
      });

      app.post("/api/preferences/:address", (req, res) => {
        const { address } = req.params;
        if (!isValidStellarAddress(address)) {
          return res.status(400).json({ error: "Invalid Stellar address" });
        }
        const incoming = sanitizePreferences(req.body);
        const existing = preferencesStore.get(address) || {};
        const merged = { ...existing, ...incoming };
        preferencesStore.set(address, merged);
        res.json({ address, preferences: merged });
      });
    });

    it("should reject invalid Stellar addresses", async () => {
      const res = await request(app).get("/api/preferences/invalid");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid Stellar address");
    });

    it("should return empty preferences for new addresses", async () => {
      const validAddress =
        "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
      const res = await request(app).get(`/api/preferences/${validAddress}`);
      expect(res.status).toBe(200);
      expect(res.body.preferences).toEqual({});
    });

    it("should store and retrieve preferences", async () => {
      const validAddress =
        "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
      const prefs = { nickname: "TestUser", language: "en" };

      const postRes = await request(app)
        .post(`/api/preferences/${validAddress}`)
        .send(prefs);
      expect(postRes.status).toBe(200);
      expect(postRes.body.preferences).toMatchObject(prefs);

      const getRes = await request(app).get(`/api/preferences/${validAddress}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.preferences).toMatchObject(prefs);
    });

    it("should sanitize preferences", async () => {
      const validAddress =
        "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
      const prefs = { nickname: "Test", invalidKey: "should be filtered" };

      const res = await request(app)
        .post(`/api/preferences/${validAddress}`)
        .send(prefs);

      expect(res.body.preferences.nickname).toBe("Test");
      expect(res.body.preferences.invalidKey).toBeUndefined();
    });
  });

  describe("Feedback API", () => {
    let app;

    beforeEach(() => {
      app = express();
      app.use(express.json());

      const feedbackStore = new Map();

      function isValidStellarAddress(addr) {
        return typeof addr === "string" && /^G[A-Z2-7]{55}$/.test(addr);
      }

      app.post("/api/feedback", (req, res) => {
        const { requestId, responderAddress, rating, comment } = req.body;
        if (!Number.isFinite(Number(requestId))) {
          return res
            .status(400)
            .json({ error: "Missing or invalid requestId" });
        }
        const ratingNum = Number(rating);
        if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) {
          return res.status(400).json({ error: "rating must be 1–5" });
        }
        const entry = {
          requestId: Number(requestId),
          responderAddress: isValidStellarAddress(responderAddress)
            ? responderAddress
            : null,
          rating: Math.round(ratingNum),
          comment: typeof comment === "string" ? comment.slice(0, 500) : "",
          createdAt: new Date().toISOString(),
        };
        feedbackStore.set(Number(requestId), entry);
        res.json({ success: true, entry });
      });

      app.get("/api/feedback/:requestId", (req, res) => {
        const id = Number(req.params.requestId);
        if (!Number.isFinite(id))
          return res.status(400).json({ error: "Invalid requestId" });
        const entry = feedbackStore.get(id);
        if (!entry) return res.status(404).json({ error: "Not found" });
        res.json(entry);
      });
    });

    it("should reject invalid rating values", async () => {
      const res = await request(app)
        .post("/api/feedback")
        .send({ requestId: 1, rating: 6 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("rating must be 1–5");
    });

    it("should store feedback successfully", async () => {
      const feedback = {
        requestId: 123,
        responderAddress:
          "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
        rating: 5,
        comment: "Great service!",
      };

      const res = await request(app).post("/api/feedback").send(feedback);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.entry.rating).toBe(5);
      expect(res.body.entry.comment).toBe("Great service!");
    });

    it("should retrieve stored feedback", async () => {
      const feedback = {
        requestId: 456,
        rating: 4,
        comment: "Good",
      };

      await request(app).post("/api/feedback").send(feedback);

      const res = await request(app).get("/api/feedback/456");
      expect(res.status).toBe(200);
      expect(res.body.rating).toBe(4);
      expect(res.body.comment).toBe("Good");
    });

    it("should return 404 for non-existent feedback", async () => {
      const res = await request(app).get("/api/feedback/999");
      expect(res.status).toBe(404);
    });
  });
});
