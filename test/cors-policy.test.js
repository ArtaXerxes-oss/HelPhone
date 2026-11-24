import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isOriginAllowed,
  buildOriginRegexes,
  createCorsMiddleware,
  MAX_AGE,
  ALLOWED_METHODS,
} from "../server/middleware/cors.js";
import { compileOriginPattern, parseAllowedOrigins } from "../server/env.js";

// Helper to make mock req/res/next
function mockReq({ method = "GET", origin, headers = {} } = {}) {
  return {
    method,
    headers: {
      ...(origin ? { origin } : {}),
      ...headers,
    },
    ip: "127.0.0.1",
  };
}
function mockRes() {
  const headers = {};
  let statusCode = 200;
  let body = null;
  let ended = false;
  return {
    headers,
    statusCode,
    body,
    ended,
    setHeader(k, v) {
      headers[k.toLowerCase()] = String(v);
    },
    getHeader(k) {
      return headers[k.toLowerCase()];
    },
    status(s) {
      statusCode = s;
      this.statusCode = s;
      return this;
    },
    json(b) {
      body = b;
      this.body = b;
      return this;
    },
    end() {
      ended = true;
      this.ended = true;
      return this;
    },
  };
}

describe("CORS — Stateful Origin Validation & Preflight Caching", () => {
  describe("compileOriginPattern / parseAllowedOrigins", () => {
    it("parses comma-separated list", () => {
      expect(
        parseAllowedOrigins(
          "https://helphone.com, https://staging.helphone.com",
        ),
      ).toEqual(["https://helphone.com", "https://staging.helphone.com"]);
    });

    it("compiles exact origin to anchored regex", () => {
      const re = compileOriginPattern("https://helphone.com");
      expect(re.test("https://helphone.com")).toBe(true);
      expect(re.test("https://helphone.com.evil.com")).toBe(false);
      expect(re.test("https://helphone.com/")).toBe(false);
    });

    it("compiles wildcard https://*.helphone.com", () => {
      const re = compileOriginPattern("https://*.helphone.com");
      expect(re.test("https://api.helphone.com")).toBe(true);
      expect(re.test("https://staging.helphone.com")).toBe(true);
      expect(re.test("https://evil.com")).toBe(false);
    });

    it("compiles explicit regex https://.*\\.helphone\\.com", () => {
      const re = compileOriginPattern("https://.*\\.helphone\\.com");
      expect(re.test("https://api.helphone.com")).toBe(true);
      expect(re.test("https://helphone.com")).toBe(false); // needs subdomain for .* pattern
      expect(re.test("https://evil.com")).toBe(false);
    });
  });

  describe("isOriginAllowed", () => {
    const regexes = buildOriginRegexes(
      "https://helphone.com,https://staging.helphone.com,https://.*\\.helphone\\.com",
    );

    it("allows prod domain", () => {
      expect(isOriginAllowed("https://helphone.com", regexes)).toBe(true);
    });
    it("allows staging domain", () => {
      expect(isOriginAllowed("https://staging.helphone.com", regexes)).toBe(
        true,
      );
    });
    it("allows subdomain via regex", () => {
      expect(isOriginAllowed("https://api.helphone.com", regexes)).toBe(true);
      expect(isOriginAllowed("https://foo.bar.helphone.com", regexes)).toBe(
        true,
      );
    });
    it("rejects unauthorized origins", () => {
      expect(isOriginAllowed("https://evil.com", regexes)).toBe(false);
      expect(isOriginAllowed("https://helphone.com.evil.com", regexes)).toBe(
        false,
      );
      expect(isOriginAllowed("http://helphone.com", regexes)).toBe(false); // scheme mismatch
      expect(isOriginAllowed("", regexes)).toBe(false);
      expect(isOriginAllowed(null, regexes)).toBe(false);
      expect(isOriginAllowed(undefined, regexes)).toBe(false);
    });
    it("rejects partial spoofing", () => {
      expect(isOriginAllowed("https://helphone.com.attacker.io", regexes)).toBe(
        false,
      );
    });
  });

  describe("createCorsMiddleware — preflight caching (Access-Control-Max-Age: 86400)", () => {
    it("exposes MAX_AGE 86400", () => {
      expect(MAX_AGE).toBe(86400);
    });

    it("allows valid prod origin on preflight — 204 + Max-Age 86400 + ACAO", () => {
      const cors = createCorsMiddleware({
        allowedPatterns: [
          "https://helphone.com",
          "https://staging.helphone.com",
        ],
        maxAge: 86400,
      });
      const req = mockReq({
        method: "OPTIONS",
        origin: "https://helphone.com",
      });
      const res = mockRes();
      let nextCalled = false;
      cors(req, res, () => (nextCalled = true));

      expect(res.statusCode).toBe(204);
      expect(res.getHeader("access-control-allow-origin")).toBe(
        "https://helphone.com",
      );
      expect(res.getHeader("access-control-max-age")).toBe("86400");
      expect(res.getHeader("access-control-allow-methods")).toContain("GET");
      expect(nextCalled).toBe(false);
    });

    it("allows valid staging origin on preflight", () => {
      const cors = createCorsMiddleware({
        allowedPatterns: [
          "https://helphone.com",
          "https://staging.helphone.com",
        ],
      });
      const req = mockReq({
        method: "OPTIONS",
        origin: "https://staging.helphone.com",
      });
      const res = mockRes();
      cors(req, res, () => {});
      expect(res.statusCode).toBe(204);
      expect(res.getHeader("access-control-allow-origin")).toBe(
        "https://staging.helphone.com",
      );
      expect(res.getHeader("access-control-max-age")).toBe("86400");
    });

    it("rejects unauthorized origin on preflight — 403 without ACAO or Max-Age", () => {
      const cors = createCorsMiddleware({
        allowedPatterns: [
          "https://helphone.com",
          "https://staging.helphone.com",
        ],
      });
      const req = mockReq({ method: "OPTIONS", origin: "https://evil.com" });
      const res = mockRes();
      let nextCalled = false;
      cors(req, res, () => (nextCalled = true));

      expect(res.statusCode).toBe(403);
      expect(res.getHeader("access-control-allow-origin")).toBeUndefined();
      expect(res.getHeader("access-control-max-age")).toBeUndefined();
      expect(res.body).toMatchObject({ success: false });
      expect(nextCalled).toBe(false);
    });

    it("rejects unauthorized subdomain spoof on preflight", () => {
      const cors = createCorsMiddleware({
        allowedPatterns: ["https://helphone.com"],
      });
      const req = mockReq({
        method: "OPTIONS",
        origin: "https://helphone.com.evil.com",
      });
      const res = mockRes();
      cors(req, res, () => {});
      expect(res.statusCode).toBe(403);
      expect(res.getHeader("access-control-allow-origin")).toBeUndefined();
    });

    it("allows regex wildcard subdomain", () => {
      const cors = createCorsMiddleware({
        allowedPatterns: ["https://.*\\.helphone\\.com"],
      });
      const req = mockReq({
        method: "OPTIONS",
        origin: "https://api.helphone.com",
      });
      const res = mockRes();
      cors(req, res, () => {});
      expect(res.statusCode).toBe(204);
      expect(res.getHeader("access-control-allow-origin")).toBe(
        "https://api.helphone.com",
      );
    });

    it("caches preflight for 24h — Max-Age header present and numeric", () => {
      const cors = createCorsMiddleware({
        allowedPatterns: ["https://helphone.com"],
      });
      const req = mockReq({
        method: "OPTIONS",
        origin: "https://helphone.com",
      });
      const res = mockRes();
      cors(req, res, () => {});
      const maxAge = res.getHeader("access-control-max-age");
      expect(maxAge).toBe("86400");
      expect(Number(maxAge)).toBe(86400);
    });

    it("sets Vary: Origin on every request", () => {
      const cors = createCorsMiddleware({
        allowedPatterns: ["https://helphone.com"],
      });
      const req = mockReq({ method: "GET", origin: "https://helphone.com" });
      const res = mockRes();
      cors(req, res, () => {});
      expect(res.getHeader("vary")).toBe("Origin");
    });
  });

  describe("simple CORS requests (GET/POST)", () => {
    it("sets ACAO for allowed origin on GET and calls next", () => {
      const cors = createCorsMiddleware({
        allowedPatterns: [
          "https://helphone.com",
          "https://staging.helphone.com",
        ],
      });
      const req = mockReq({ method: "GET", origin: "https://helphone.com" });
      const res = mockRes();
      let nextCalled = false;
      cors(req, res, () => (nextCalled = true));
      expect(res.getHeader("access-control-allow-origin")).toBe(
        "https://helphone.com",
      );
      expect(nextCalled).toBe(true);
    });

    it("does NOT set ACAO for unauthorized origin on GET", () => {
      const cors = createCorsMiddleware({
        allowedPatterns: ["https://helphone.com"],
      });
      const req = mockReq({ method: "GET", origin: "https://evil.com" });
      const res = mockRes();
      let nextCalled = false;
      cors(req, res, () => (nextCalled = true));
      expect(res.getHeader("access-control-allow-origin")).toBeUndefined();
      expect(nextCalled).toBe(true);
    });

    it("passes through non-CORS requests (no Origin) without ACAO", () => {
      const cors = createCorsMiddleware({
        allowedPatterns: ["https://helphone.com"],
      });
      const req = mockReq({ method: "GET" }); // no origin
      const res = mockRes();
      let nextCalled = false;
      cors(req, res, () => (nextCalled = true));
      expect(res.getHeader("access-control-allow-origin")).toBeUndefined();
      expect(nextCalled).toBe(true);
    });
  });

  describe("env integration — ALLOWED_ORIGINS", () => {
    const original = process.env.ALLOWED_ORIGINS;
    afterEach(() => {
      if (original === undefined) delete process.env.ALLOWED_ORIGINS;
      else process.env.ALLOWED_ORIGINS = original;
    });

    it("reads from process.env.ALLOWED_ORIGINS", async () => {
      process.env.ALLOWED_ORIGINS =
        "https://helphone.com,https://staging.helphone.com";
      // Dynamic import to re-evaluate env; but our middleware caches at construction
      const { getAllowedOriginPatterns } = await import("../server/env.js");
      const patterns = getAllowedOriginPatterns();
      expect(patterns).toContain("https://helphone.com");
      expect(patterns).toContain("https://staging.helphone.com");
    });

    it("defaults to prod + staging when env empty", async () => {
      delete process.env.ALLOWED_ORIGINS;
      const { parseAllowedOrigins } = await import("../server/env.js");
      const patterns = parseAllowedOrigins("");
      expect(patterns).toEqual([
        "https://helphone.com",
        "https://staging.helphone.com",
      ]);
    });
  });
});
