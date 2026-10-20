import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { createPartialResponse } from "workbox-range-requests";

cleanupOutdatedCaches();

const manifest = self.__WB_MANIFEST || [];
precacheAndRoute(manifest);

const CACHE_NAME = "helphone-v1";
const TILES_CACHE_VERSION = "v1";
const TILES_CACHE_NAME = `tiles-${TILES_CACHE_VERSION}`;
const ALLOWED_TILE_MIMES = [
  "application/x-protobuf",
  "application/vnd.mapbox-vector-tile",
  "application/octet-stream",
  "image/png",
  "image/webp",
  "image/jpeg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // ISP-046: Precache critical locale files for offline i18n support
      // Ensures Arabic Help form renders offline without suspense hang
      return cache.addAll([
        '/locales/en/common.json',
        '/locales/en/help.json',
        '/locales/ar/common.json',
        '/locales/ar/help.json',
      ]).then(() => {
        self.skipWaiting();
      });
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (
            cacheName !== CACHE_NAME &&
            cacheName !== "helphone-zk-assets-v1" &&
            cacheName !== TILES_CACHE_NAME
          ) {
            return caches.delete(cacheName);
          }
        }),
      );
    }).then(() => {
      self.clients.claim();
    })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // #742: Skip caching for HMR and dev server requests to avoid stale-while-revalidate
  if (
    url.searchParams.has("t") || // Vite HMR timestamp query
    /\/@vite\//.test(url.pathname) || // Vite HMR module
    /\.hmr(?:\.json)?$/.test(url.pathname) // HMR manifest
  ) {
    return; // Let fetch proceed normally, don't cache
  }

  if (
    request.method === "GET" &&
    url.origin === self.location.origin &&
    /\/zk-assets\/aegis\.chunk\d{4}$/.test(url.pathname)
  ) {
    event.respondWith((async () => {
      const cache = await caches.open("helphone-zk-assets-v1");
      const key = new Request(url.href, { method: "GET" });
      let full = await cache.match(key);
      if (!full) {
        full = await fetch(key);
        if (full.ok) await cache.put(key, full.clone());
      }
      if (!request.headers.has("range") || !full.ok) return full;
      try {
        return await createPartialResponse(request, full);
      } catch {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${full.headers.get("content-length") || 0}` } });
      }
    })());
    return;
  }

  if (url.pathname === "/") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const cache = caches.open(CACHE_NAME);
          cache.then((c) => c.put(request, response.clone()));
          return response;
        })
        .catch(() => {
          return caches.match(request).then((response) => {
            return response || caches.match("/");
          });
        }),
    );
    return;
  }

  if (request.method === "GET") {
    if (url.hostname.includes("mapbox.com")) {
      event.respondWith(
        (async () => {
          const cache = await caches.open(TILES_CACHE_NAME);
          const cachedResponse = await cache.match(request);

          const revalidatePromise = (async () => {
            try {
              const networkResponse = await fetch(request);
              // Strict integrity verification:
              // 1. Must be HTTP 200 (reject status 0 opaque responses and errors)
              if (!networkResponse || networkResponse.status !== 200) {
                return networkResponse;
              }

              // 2. Upstream revocation check
              const isRevoked = networkResponse.headers.get("x-tile-revoke");
              if (isRevoked === "true" || isRevoked === "1") {
                await cache.delete(request);
                const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
                clients.forEach((c) => c.postMessage({ type: "TILE_REVOKED", url: request.url }));
                return networkResponse;
              }

              // 3. MIME type check
              const contentType = (networkResponse.headers.get("content-type") || "")
                .split(";")[0]
                .trim()
                .toLowerCase();
              const isAllowedMime = ALLOWED_TILE_MIMES.some(
                (m) => contentType === m || contentType.includes("protobuf") || contentType.includes("vector-tile")
              );

              // 4. Size check: reject oversized > 1MB
              const contentLength = parseInt(networkResponse.headers.get("content-length") || "0", 10);
              const isOversized = contentLength > 1024 * 1024;

              if (isAllowedMime && !isOversized) {
                await cache.put(request, networkResponse.clone());
              } else {
                const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
                clients.forEach((c) =>
                  c.postMessage({
                    type: "TILE_ANOMALY",
                    payload: {
                      url: request.url,
                      contentType,
                      contentLength,
                      reason: isOversized ? "OVERSIZED" : "MIME_MISMATCH",
                    },
                  })
                );
              }
              return networkResponse;
            } catch (err) {
              if (cachedResponse) return cachedResponse;
              throw err;
            }
          })();

          if (cachedResponse) {
            event.waitUntil(revalidatePromise.catch(() => {}));
            return cachedResponse;
          }

          return revalidatePromise;
        })()
      );
      return;
    }

    if (request.url.endsWith(".wasm") || request.url.endsWith(".json")) {
      event.respondWith(
        caches.match(request).then((response) => {
          return (
            response ||
            fetch(request).then((response) => {
              const responseClone = response.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, responseClone);
              });
              return response;
            })
          );
        }),
      );
      return;
    }
  }

  event.respondWith(
    fetch(request).catch(() => {
      return caches.match(request).then((response) => {
        return (
          response ||
          new Response(
            JSON.stringify({
              message: "Offline",
              description:
                "You are currently offline. Some features may not be available.",
            }),
            {
              status: 503,
              statusText: "Service Unavailable",
              headers: { "Content-Type": "application/json" },
            },
          )
        );
      });
    }),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};

  // CRDT sync: forward the local state change to the backend sync endpoint.
  if (data.type === "CRDT_SYNC") {
    event.waitUntil(
      fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data.payload),
      }),
    );
  }

  // Contract update events and CRDT/state sync (issue #516): reflect the
  // message to every other open window client so a single leader's poll or
  // SSE result reaches all tabs without each tab owning a subscription.
  if (data.type === "CONTRACT_EVENT" || data.type === "CRDT_SYNC" || data.type === "STATE_SYNC") {
    event.waitUntil(
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clients) => {
          return Promise.all(
            clients.map((client) => {
              if (client === event.source) return Promise.resolve();
              return client.postMessage({ ...data, source: data.source || "service-worker" });
            }),
          );
        })
        .catch(() => {}),
    );
  }

  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

  // ISP-092: Emergency purge for poisoned Mapbox vector tiles without wiping app-shell
  if (data.type === "PURGE_TILES") {
    event.waitUntil(
      caches
        .keys()
        .then((cacheNames) => {
          const tileCaches = cacheNames.filter(
            (name) =>
              name.startsWith("tiles-") ||
              name.includes("mapbox-tiles") ||
              name.includes("mapbox-api")
          );
          return Promise.all(tileCaches.map((name) => caches.delete(name)));
        })
        .then(() => {
          return self.clients.matchAll({ type: "window", includeUncontrolled: true });
        })
        .then((clients) => {
          for (const client of clients) {
            client.postMessage({ type: "TILES_PURGED", timestamp: Date.now() });
          }
        })
    );
  }

  // ISP-135/ISP-134: the SW can never hold a Serial port or NDEFReader, so
  // it only relays field intents (radio RX, NFC results, SOS) between
  // clients. TX always happens in a foreground page.
  if (event.data && event.data.type === "HELPHONE_RELAY") {
    event.waitUntil(
      self.clients
        .matchAll({ includeUncontrolled: true, type: "window" })
        .then((clientList) => {
          for (const client of clientList) {
            client.postMessage(event.data);
          }
        }),
    );
  }
});
