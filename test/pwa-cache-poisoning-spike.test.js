import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  TileCacheIntegrityManager,
  ALLOWED_TILE_HOSTS,
  ALLOWED_TILE_MIMES,
} from "../server/lib/tileCacheIntegrity.js";

describe("ISP-092: PWA Cache Poisoning & Map Tile Integrity Spike", () => {
  let manager;
  let telemetryEvents;

  beforeEach(() => {
    telemetryEvents = [];
    manager = new TileCacheIntegrityManager({
      version: "1",
      maxTileSize: 1024 * 1024,
      minTileSize: 40,
      telemetryListener: (event) => telemetryEvents.push(event),
    });
  });

  describe("Opaque Response & Status Hardening", () => {
    it("should strictly reject opaque responses (status 0) and trigger anomaly", () => {
      const result = manager.validateTileResponse({
        status: 0,
        url: "https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/10/200/400.vector.pbf",
        headers: {},
      });

      expect(result.valid).toBe(false);
      expect(result.code).toBe("STATUS_OPAQUE");
      expect(telemetryEvents.length).toBe(1);
      expect(telemetryEvents[0].type).toBe("OPAQUE_RESPONSE_REJECTED");
    });

    it("should reject non-200 HTTP statuses (e.g., 404, 500, 502)", () => {
      const result = manager.validateTileResponse({
        status: 502,
        statusText: "Bad Gateway",
        url: "https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/10/200/400.vector.pbf",
        headers: {},
      });

      expect(result.valid).toBe(false);
      expect(result.code).toBe("STATUS_NON_200");
    });

    it("should accept valid HTTP 200 responses with protobuf MIME type", () => {
      const result = manager.validateTileResponse({
        status: 200,
        url: "https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/10/200/400.vector.pbf",
        headers: {
          "content-type": "application/x-protobuf",
        },
        bodySize: 12450,
      });

      expect(result.valid).toBe(true);
      expect(telemetryEvents.length).toBe(0);
    });
  });

  describe("MIME Type Guard & Poison Filtering", () => {
    it("should reject spoofed HTML or JSON responses masquerading as tiles", () => {
      const htmlResult = manager.validateTileResponse({
        status: 200,
        url: "https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/10/200/400.vector.pbf",
        headers: { "content-type": "text/html; charset=utf-8" },
        bodySize: 512,
      });

      expect(htmlResult.valid).toBe(false);
      expect(htmlResult.code).toBe("MIME_MISMATCH");

      const jsonResult = manager.validateTileResponse({
        status: 200,
        url: "https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/10/200/400.vector.pbf",
        headers: { "content-type": "application/json" },
        bodySize: 200,
      });

      expect(jsonResult.valid).toBe(false);
      expect(jsonResult.code).toBe("MIME_MISMATCH");
      expect(telemetryEvents.length).toBe(2);
    });

    it("should allow verified Mapbox vector tile MIME types", () => {
      for (const mime of [
        "application/x-protobuf",
        "application/vnd.mapbox-vector-tile",
        "application/octet-stream",
      ]) {
        const result = manager.validateTileResponse({
          status: 200,
          url: "https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/10/200/400.vector.pbf",
          headers: { "content-type": mime },
          bodySize: 8192,
        });
        expect(result.valid).toBe(true);
      }
    });
  });

  describe("Payload Size Boundary Enforcement", () => {
    it("should reject oversized tile payloads exceeding 1MB", () => {
      const result = manager.validateTileResponse({
        status: 200,
        url: "https://api.mapbox.com/v4/test.pbf",
        headers: { "content-type": "application/x-protobuf" },
        bodySize: 1024 * 1024 + 100, // 1MB + 100B
      });

      expect(result.valid).toBe(false);
      expect(result.code).toBe("OVERSIZED");
      expect(telemetryEvents.some((e) => e.type === "TILE_OVERSIZED")).toBe(true);
    });

    it("should reject stub/undersized payloads below 40 bytes", () => {
      const result = manager.validateTileResponse({
        status: 200,
        url: "https://api.mapbox.com/v4/test.pbf",
        headers: { "content-type": "application/x-protobuf" },
        bodySize: 12,
      });

      expect(result.valid).toBe(false);
      expect(result.code).toBe("UNDERSIZED");
    });
  });

  describe("Revocation & Version Skew Handling", () => {
    it("should flag revocation and signal cache purge when X-Tile-Revoke header is received", () => {
      const result = manager.validateTileResponse({
        status: 200,
        url: "https://api.mapbox.com/v4/test.pbf",
        headers: {
          "content-type": "application/x-protobuf",
          "x-tile-revoke": "true",
        },
        bodySize: 5000,
      });

      expect(result.valid).toBe(false);
      expect(result.shouldPurge).toBe(true);
      expect(result.code).toBe("REVOKED_BY_UPSTREAM");
      expect(telemetryEvents.some((e) => e.type === "TILE_REVOCATION_TRIGGERED")).toBe(true);
    });

    it("should trigger purge when upstream reports a newer tile version", () => {
      const result = manager.validateTileResponse({
        status: 200,
        url: "https://api.mapbox.com/v4/test.pbf",
        headers: {
          "content-type": "application/x-protobuf",
          "x-tile-version": "2",
        },
        bodySize: 5000,
      });

      expect(result.valid).toBe(false);
      expect(result.shouldPurge).toBe(true);
      expect(result.code).toBe("VERSION_MISMATCH");
    });
  });

  describe("Tile Cache Lifecycle & Version Scoping", () => {
    it("should isolate tile caches and filter outdated generations without touching app shell", () => {
      const existingCaches = [
        "helphone-v1",
        "helphone-zk-assets-v1",
        "tiles-v0",
        "tiles-v1",
        "mapbox-tiles-cache",
      ];

      const outdated = manager.filterOutdatedTileCaches(existingCaches);
      expect(outdated).toContain("tiles-v0");
      expect(outdated).toContain("mapbox-tiles-cache");
      expect(outdated).not.toContain("tiles-v1");
      expect(outdated).not.toContain("helphone-v1");
      expect(outdated).not.toContain("helphone-zk-assets-v1");
    });

    it("should purge all tile caches while keeping app-shell intact during emergency purge", () => {
      const existingCaches = [
        "helphone-v1",
        "helphone-zk-assets-v1",
        "tiles-v1",
        "mapbox-api-cache",
      ];

      const toPurge = manager.filterAllTileCachesForPurge(existingCaches);
      expect(toPurge).toEqual(["tiles-v1", "mapbox-api-cache"]);
      expect(toPurge).not.toContain("helphone-v1");
      expect(toPurge).not.toContain("helphone-zk-assets-v1");
    });
  });

  describe("URL Allowlist Validation", () => {
    it("should accept canonical Mapbox vector tile endpoints over HTTPS", () => {
      expect(
        manager.isTileUrlAllowed("https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/1/0/0.vector.pbf")
      ).toBe(true);
      expect(
        manager.isTileUrlAllowed("https://tiles.mapbox.com/v4/mapbox.terrain-rgb/1/0/0.png")
      ).toBe(true);
    });

    it("should reject non-HTTPS URLs or foreign domains", () => {
      expect(
        manager.isTileUrlAllowed("http://api.mapbox.com/v4/mapbox.mapbox-streets-v8/1/0/0.vector.pbf")
      ).toBe(false);
      expect(
        manager.isTileUrlAllowed("https://evil-cdn.example.com/v4/mapbox.vector.pbf")
      ).toBe(false);
      expect(
        manager.isTileUrlAllowed("not-a-valid-url")
      ).toBe(false);
    });
  });
});
