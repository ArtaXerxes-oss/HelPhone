import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { server as mswServer } from "../src/mocks/server.js";

const VALID_PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let mockPngSize = 256;

vi.mock("canvas", () => {
  const fakeCtx = {
    fillStyle: "",
    font: "",
    fillRect: vi.fn(),
    fillText: vi.fn(),
  };
  return {
    default: {
      createCanvas: vi.fn(() => ({
        getContext: () => fakeCtx,
        toBuffer: () => Buffer.concat([VALID_PNG_HEADER, Buffer.alloc(Math.max(0, mockPngSize - 8), 0xaa)]),
      })),
    },
  };
});

import {
  createOGPreviewRouter,
  isValidRequestId,
  buildOgCacheKey,
  isValidPngBuffer,
  DEFAULT_MAX_OG_IMAGE_BYTES,
} from "../server/routes/ogPreview.ts";

beforeAll(() => mswServer.close());

function createMockRedis() {
  const store = new Map();
  return {
    store,
    getBuffer: vi.fn(async (key) => store.get(key) ?? null),
    setex: vi.fn(async (key, _ttl, buf) => {
      store.set(key, buf);
      return "OK";
    }),
    del: vi.fn(async (key) => {
      const existed = store.delete(key);
      return existed ? 1 : 0;
    }),
  };
}

describe("OG preview SSRF and cache-poisoning hardening (#948)", () => {
  let redis;
  let app;

  beforeEach(() => {
    mockPngSize = 256;
    redis = createMockRedis();
    app = express();
    app.use(
      createOGPreviewRouter(redis, {
        requestExists: (requestId, tenantId) =>
          requestId === "req-101" || (tenantId === "team-a" && requestId === "req-team-a"),
      }),
    );
  });

  it("rejects malicious requestId values before touching Redis", () => {
    const malicious = [
      "http://169.254.169.254/latest/meta-data",
      "../etc/passwd",
      "req:other-tenant:1",
      "req*",
      "req\nset",
      "a".repeat(65),
    ];
    for (const id of malicious) {
      expect(isValidRequestId(id)).toBe(false);
    }
    expect(() => buildOgCacheKey("team-a", "req:bad")).toThrow();
  });

  it("returns 400 on invalid requestId or tenantId without querying Redis", async () => {
    const res1 = await request(app).get("/og/req:inject");
    expect(res1.status).toBe(400);
    expect(redis.getBuffer).not.toHaveBeenCalled();

    const res2 = await request(app).get("/og/req-101").set("X-Tenant-Id", "bad:tenant");
    expect(res2.status).toBe(400);
    expect(redis.getBuffer).not.toHaveBeenCalled();
  });

  it("returns 404 when requestId does not exist for tenant", async () => {
    const res = await request(app).get("/og/req-team-a").set("X-Tenant-Id", "team-b");
    expect(res.status).toBe(404);
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it("isolates cache keys and responses across tenants", async () => {
    const resA = await request(app).get("/og/req-101").set("X-Tenant-Id", "team-a");
    expect(resA.status).toBe(200);
    expect(resA.headers["vary"]).toBe("X-Tenant-Id");
    expect(resA.headers["cache-control"]).toBe("private, max-age=3600");
    expect(resA.headers["x-content-type-options"]).toBe("nosniff");
    expect(resA.headers["x-og-integrity"]).toMatch(/^sha256-/);

    const resB = await request(app).get("/og/req-101").set("X-Tenant-Id", "team-b");
    expect(resB.status).toBe(200);

    expect(redis.store.has("og:v1:team-a:req-101")).toBe(true);
    expect(redis.store.has("og:v1:team-b:req-101")).toBe(true);
    expect(redis.setex).toHaveBeenCalledTimes(2);
  });

  it("evicts poisoned or oversized cached entries and regenerates", async () => {
    redis.store.set("og:v1:team-a:req-101", Buffer.from("<html>poisoned</html>"));
    const res = await request(app).get("/og/req-101").set("X-Tenant-Id", "team-a");
    expect(res.status).toBe(200);
    expect(redis.del).toHaveBeenCalledWith("og:v1:team-a:req-101");
    expect(isValidPngBuffer(res.body, DEFAULT_MAX_OG_IMAGE_BYTES)).toBe(true);
  });

  it("rejects oversized generated images and does not cache them", async () => {
    mockPngSize = DEFAULT_MAX_OG_IMAGE_BYTES + 1024;
    const res = await request(app).get("/og/req-101").set("X-Tenant-Id", "team-a");
    expect(res.status).toBe(413);
    expect(redis.setex).not.toHaveBeenCalled();
  });
});
