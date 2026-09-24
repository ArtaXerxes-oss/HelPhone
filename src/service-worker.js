import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

cleanupOutdatedCaches();

const manifest = self.__WB_MANIFEST || [];
precacheAndRoute(manifest);

const CACHE_NAME = 'helphone-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(() => {
      self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      self.clients.claim();
    })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.pathname === '/') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const cache = caches.open(CACHE_NAME);
          cache.then((c) => c.put(request, response.clone()));
          return response;
        })
        .catch(() => {
          return caches.match(request).then((response) => {
            return response || caches.match('/');
          });
        })
    );
    return;
  }

  if (request.method === 'GET') {
    if (url.hostname.includes('mapbox.com')) {
      event.respondWith(
        caches.match(request).then((response) => {
          return (
            response ||
            fetch(request)
              .then((response) => {
                if (!response || response.status !== 200) {
                  return response;
                }
                const responseClone = response.clone();
                caches.open(CACHE_NAME).then((cache) => {
                  cache.put(request, responseClone);
                });
                return response;
              })
              .catch(() => {
                return caches.match(request);
              })
          );
        })
      );
      return;
    }

    if (request.url.endsWith('.wasm') || request.url.endsWith('.json')) {
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
        })
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
              message: 'Offline',
              description: 'You are currently offline. Some features may not be available.',
            }),
            {
              status: 503,
              statusText: 'Service Unavailable',
              headers: { 'Content-Type': 'application/json' },
            }
          )
        );
      });
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CRDT_SYNC') {
    event.waitUntil(fetch('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event.data.payload) }))
  }
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
