/**
 * ISP-092: PWA Cache Poisoning via Compromised Mapbox Tile CDN
 * Tile Cache Integrity & Revalidation Manager
 *
 * Enforces strict vector tile validation, preventing opaque response (status 0)
 * caching footguns, oversized payloads, MIME mismatches, and enabling version-scoped
 * cache eviction and emergency purge protocols.
 */

export const ALLOWED_TILE_HOSTS = new Set([
  "api.mapbox.com",
  "tiles.mapbox.com",
  "a.tiles.mapbox.com",
  "b.tiles.mapbox.com",
  "c.tiles.mapbox.com",
  "d.tiles.mapbox.com",
]);

export const ALLOWED_TILE_MIMES = new Set([
  "application/x-protobuf",
  "application/vnd.mapbox-vector-tile",
  "application/octet-stream",
  "image/png",
  "image/webp",
  "image/jpeg",
]);

export const DEFAULT_MAX_TILE_SIZE = 1024 * 1024; // 1MB cap per tile
export const DEFAULT_MIN_TILE_SIZE = 40; // Empty/stub vector tile floor
export const DEFAULT_CACHE_VERSION = "1";
export const TILE_CACHE_PREFIX = "tiles-v";

export class TileCacheIntegrityManager {
  constructor(options = {}) {
    this.activeVersion = String(options.version || DEFAULT_CACHE_VERSION);
    this.cacheName = `${TILE_CACHE_PREFIX}${this.activeVersion}`;
    this.maxTileSize = options.maxTileSize || DEFAULT_MAX_TILE_SIZE;
    this.minTileSize = options.minTileSize || DEFAULT_MIN_TILE_SIZE;
    this.maxAgeSeconds = options.maxAgeSeconds || 7 * 24 * 60 * 60; // 7 days bounded TTL
    this.allowedHosts = options.allowedHosts ? new Set(options.allowedHosts) : ALLOWED_TILE_HOSTS;
    this.allowedMimes = options.allowedMimes ? new Set(options.allowedMimes) : ALLOWED_TILE_MIMES;
    this.anomalies = [];
    this.telemetryListener = options.telemetryListener || null;
  }

  /**
   * Check if a URL matches allowlisted Mapbox vector tile endpoints.
   */
  isTileUrlAllowed(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:") return false;
      if (!this.allowedHosts.has(url.hostname)) return false;

      // Ensure path corresponds to mapbox tile patterns
      const isTilePath =
        url.pathname.startsWith("/v4/") ||
        url.pathname.startsWith("/styles/v1/") ||
        /\/tiles\/\d+\/\d+\/\d+/.test(url.pathname) ||
        /\.(mvt|pbf|vector\.pbf)$/.test(url.pathname);

      return isTilePath;
    } catch {
      return false;
    }
  }

  /**
   * Validates an incoming HTTP response or response metadata for tile caching.
   * Returns { valid: boolean, reason?: string, shouldPurge?: boolean }
   */
  validateTileResponse(metadata) {
    const { status, statusText, headers = {}, bodySize, url } = metadata;

    // Strict status check: Opaque responses (status 0) and errors are rejected
    if (status === 0) {
      const anomaly = {
        type: "OPAQUE_RESPONSE_REJECTED",
        url,
        status,
        timestamp: Date.now(),
        reason: "Opaque response (status 0) rejected: footgun causes un-revalidatable poisoned cache",
      };
      this._recordAnomaly(anomaly);
      return { valid: false, reason: anomaly.reason, code: "STATUS_OPAQUE" };
    }

    if (status !== 200) {
      return {
        valid: false,
        reason: `Non-200 HTTP status: ${status} ${statusText || ""}`.trim(),
        code: "STATUS_NON_200",
      };
    }

    // Inspect revocation header
    const revokeHeader = headers["x-tile-revoke"] || headers["X-Tile-Revoke"];
    if (revokeHeader === "true" || revokeHeader === "1") {
      const anomaly = {
        type: "TILE_REVOCATION_TRIGGERED",
        url,
        timestamp: Date.now(),
        reason: "Upstream CDN issued X-Tile-Revoke header",
      };
      this._recordAnomaly(anomaly);
      return { valid: false, shouldPurge: true, reason: anomaly.reason, code: "REVOKED_BY_UPSTREAM" };
    }

    // Inspect tile version header if provided
    const tileVersionHeader = headers["x-tile-version"] || headers["X-Tile-Version"];
    if (tileVersionHeader && String(tileVersionHeader) !== this.activeVersion) {
      const anomaly = {
        type: "TILE_VERSION_MISMATCH",
        url,
        serverVersion: tileVersionHeader,
        clientVersion: this.activeVersion,
        timestamp: Date.now(),
        reason: `Tile version mismatch: upstream=${tileVersionHeader}, active=${this.activeVersion}`,
      };
      this._recordAnomaly(anomaly);
      return { valid: false, shouldPurge: true, reason: anomaly.reason, code: "VERSION_MISMATCH" };
    }

    // Content-Type validation
    const rawContentType = headers["content-type"] || headers["Content-Type"] || "";
    const mime = rawContentType.split(";")[0].trim().toLowerCase();

    if (!mime || !this.allowedMimes.has(mime)) {
      const anomaly = {
        type: "TILE_MIME_MISMATCH",
        url,
        mime: mime || "missing",
        timestamp: Date.now(),
        reason: `Disallowed MIME type: "${mime}". Expected protobuf or mapbox vector tile.`,
      };
      this._recordAnomaly(anomaly);
      return { valid: false, reason: anomaly.reason, code: "MIME_MISMATCH" };
    }

    // Size boundary checks
    if (typeof bodySize === "number") {
      if (bodySize > this.maxTileSize) {
        const anomaly = {
          type: "TILE_OVERSIZED",
          url,
          bodySize,
          maxAllowed: this.maxTileSize,
          timestamp: Date.now(),
          reason: `Tile payload size ${bodySize} bytes exceeds maximum allowed limit of ${this.maxTileSize} bytes`,
        };
        this._recordAnomaly(anomaly);
        return { valid: false, reason: anomaly.reason, code: "OVERSIZED" };
      }

      if (bodySize < this.minTileSize) {
        const anomaly = {
          type: "TILE_UNDERSIZED",
          url,
          bodySize,
          minAllowed: this.minTileSize,
          timestamp: Date.now(),
          reason: `Tile payload size ${bodySize} bytes below minimum valid vector tile size (${this.minTileSize} bytes)`,
        };
        this._recordAnomaly(anomaly);
        return { valid: false, reason: anomaly.reason, code: "UNDERSIZED" };
      }
    }

    return { valid: true };
  }

  /**
   * Identifies outdated tile cache versions to delete, while strictly
   * protecting app-shell caches (e.g. helphone-v1, helphone-zk-assets-v1).
   */
  filterOutdatedTileCaches(cacheNames = []) {
    const activeCache = this.cacheName;
    return cacheNames.filter((name) => {
      // Must be a tile cache
      if (!name.startsWith(TILE_CACHE_PREFIX) && !name.startsWith("mapbox-tiles")) {
        return false;
      }
      // Keep only active version
      return name !== activeCache;
    });
  }

  /**
   * Returns all tile cache names to purge during an emergency purge protocol.
   * Never purges app-shell or zk asset caches.
   */
  filterAllTileCachesForPurge(cacheNames = []) {
    return cacheNames.filter((name) => {
      return (
        name.startsWith(TILE_CACHE_PREFIX) ||
        name.startsWith("mapbox-tiles") ||
        name.includes("mapbox-api-cache")
      );
    });
  }

  /**
   * Internal telemetry anomaly recording
   */
  _recordAnomaly(anomaly) {
    this.anomalies.push(anomaly);
    if (this.telemetryListener) {
      try {
        this.telemetryListener(anomaly);
      } catch {
        // Telemetry must never crash cache validation
      }
    }
  }

  getAnomalies() {
    return [...this.anomalies];
  }

  clearAnomalies() {
    this.anomalies = [];
  }
}
