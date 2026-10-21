# Performance Optimization

## HTTP Keep-Alive socket pool (`server/middleware/keepAlive.ts`)

Node's default `keepAliveTimeout` is 5 seconds. The load balancers in front of the prover (Render, Cloudflare) hold idle connections for about 60 seconds, so they routinely reuse a socket that the origin already closed. The client sees that as an intermittent `502`. Keeping origin sockets open longer than the balancer does removes the race, and it lets sequential REST calls and WebSocket upgrades reuse one TCP connection instead of paying a new handshake each time.

| Setting | Value | Why |
| --- | --- | --- |
| `keepAliveTimeout` | 65,000 ms | Must exceed the balancer's ~60 s idle timeout |
| `headersTimeout` | 66,000 ms | Must exceed `keepAliveTimeout`, or Node can reset a reused socket while it waits for the next request line |
| `maxRequestsPerSocket` | 0 (unlimited) | Optional cap; set to recycle long-lived sockets |

`applyKeepAliveTuning(server)` applies these to the `http.Server` in `server/index.js` (the Render runtime) and `server/index.ts`. `keepAliveMiddleware()` advertises `Connection: keep-alive` and `Keep-Alive: timeout=65` on HTTP/1.x responses. It emits nothing on HTTP/2, where connection-specific headers are forbidden.

### Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `KEEP_ALIVE_TIMEOUT_MS` | `65000` | Positive integer; invalid values fall back to the default |
| `HEADERS_TIMEOUT_MS` | `66000` | Automatically raised to `keepAliveTimeout + 1000` if set at or below it |
| `MAX_REQUESTS_PER_SOCKET` | `0` | Non-negative integer; `0` means unlimited |

Both timeouts are also set in `render.yaml`.

### HTTP/2

Express does not serve HTTP/2 directly. HTTP/2 is negotiated by the TLS-terminating edge, and it multiplexes requests over one connection there. The tuning above applies to the HTTP/1.1 hop from the edge to this origin, which is where socket reuse matters. Nothing in the middleware assumes HTTP/1.1 only.

### Verification

`test/keep-alive.test.js` starts a real server, sends three sequential requests through a keep-alive agent, and asserts that exactly one TCP connection was opened. It runs in CI with the other subsystem tests. The ~90% handshake-overhead reduction in the original issue is what this reuse yields for sequential calls (one handshake per session instead of one per request). It is not measured by the suite.

## OffscreenCanvas map overlay (`src/lib/offscreenCanvas.ts`, `src/workers/canvas-worker.js`)

Animated markers on the community map (pulsing rings for pending, en-route, resolved and responder states) are drawn on a `<canvas>` layered over the SVG map. Where the browser supports it, control of that canvas is handed to a Web Worker with `canvas.transferControlToOffscreen()`, so the animation runs on its own thread and is not starved by React renders or map interaction.

```
CommunityMap.jsx ── createOverlayRenderer(canvas) ─┬─ worker mode:      transferControlToOffscreen() ─> canvas-worker.js (rAF loop)
                                                   └─ main-thread mode: requestAnimationFrame loop, same drawOverlayFrame()
```

Both modes call the same `drawOverlayFrame()`, so the output is identical. Main-thread mode is used when `Worker`, `OffscreenCanvas` or `transferControlToOffscreen` is missing. If the worker fails after control was transferred, the canvas cannot be reused, so `CommunityMap` remounts a fresh canvas and forces main-thread mode.

React StrictMode replays effect setup and cleanup in development. Because a transferred canvas cannot be transferred again, `CommunityMap` retains the renderer across that synchronous replay and defers teardown by one microtask; a real unmount still destroys it, while a replacement canvas gets a new renderer.

Usage: pass `overlays` (an array of `{ id, x, y, kind }` in map viewBox units, `1140 x 540`) and optionally `onRenderStats`. With no `overlays` prop, no canvas is rendered and behaviour is unchanged.

### Frame rate

The loop is driven by `requestAnimationFrame`, so it runs at the display refresh rate (60 Hz on most screens). The rate is measured, not assumed: `FpsMeter` reports `{ fps, frames, windowMs }` once per second through `onRenderStats`. A device that cannot hold 60 FPS shows a lower number instead of a false claim. The unit tests verify the scheduling, the drawing and the message protocol with a fake clock. They do not measure real frame rates, which need a browser and a profile of the actual overlay count.

## Resource hints & module preloading (#542)

Goal: lower First Contentful Paint (FCP) on every route and make in-app
navigation feel instant, without spending bandwidth on code most sessions never run.

### Layers

| Layer | Where | What |
| --- | --- | --- |
| Static hints | `index.html` | `preconnect` to `fonts.googleapis.com` / `fonts.gstatic.com` (crossorigin), `dns-prefetch` to `api.mapbox.com` and `soroban-testnet.stellar.org`. Available before any JS runs. |
| Runtime hints | `src/lib/resourceHints.ts` → `initResourceHints()` | Deduplicated `<link rel="dns-prefetch|preconnect|modulepreload">` injection. Called once from `src/main.tsx`. `modulepreload` is restricted to same-origin URLs; other rels accept only `http(s)`. |
| Intent prefetch | `attachIntentPrefetch()` | Delegated `mouseover` (65 ms dwell), `focusin` and `touchstart` listeners. On an anchor whose path has a registered loader, the route's `import()` runs once (memoized), so Vite fetches the chunk and its `modulepreload` dependencies before the click. |
| Build | `vite.config.ts` `build.modulePreload.resolveDependencies` | Removes the heavy `mapbox-*` and `zk-*` chunks from the entry HTML's preload list, so the landing page does not compete with them for bandwidth. They load on intent or on navigation. |

### Guard rails

- No speculative fetch when `navigator.connection.saveData` is set or the
  effective connection type is `2g` / `slow-2g`.
- Only same-origin, non-`_blank`, non-`download` anchors are considered.
- A failed prefetch is forgotten so the next intent signal retries it, and
  never surfaces as an unhandled rejection.
- Hint injection is idempotent; calling it repeatedly (HMR, StrictMode) adds no tags.

### Adding a route

Register the same loader used by `lazy()` in `src/main.tsx`:

```ts
const loadThing = () => import("./pages/Thing");
const Thing = lazy(loadThing);
registerRouteLoaders({ "/thing": loadThing });
```

### Verifying

- Unit tests: `npx vitest run test/resource-hints.test.js`.
- In DevTools → Network, hover a nav link: the route chunk appears (Initiator:
  `resourceHints`) before the click; the landing page's initial requests no
  longer include the `mapbox` / `zk` chunks.
- Lighthouse (mobile, throttled): compare FCP before/after on `/`, `/help`, `/ranking`.

## HTTP/2 push & preload manifest (`server/middleware/http2Push.ts`)

Goal: get the entry page's compiled chunks into the browser's preload scanner
before the HTML has been parsed, using the asset hashes this release actually
shipped — with no hand-maintained list to drift.

### Layers

| Layer | Where | What |
| --- | --- | --- |
| Manifest emission | `vite.config.ts` → `build.manifest: true` | Every `vite build` writes `dist/.vite/manifest.json`: entry chunk, its static `imports`, and per-chunk `css`, all under fingerprinted names. |
| Manifest reader | `createManifestStore()` | Reads the manifest once at startup (not on first request), caches the parsed asset list, and re-checks the file's mtime/size on a throttled interval (`refreshIntervalMs`, default 5 s; `0` = every request). A changed manifest is re-parsed, so a new deploy's hashes replace the old ones without a restart. |
| Entry graph | `collectEntryAssets()` | Depth-first over `index.html` → `isEntry` chunks → `imports` → their `css`, deduplicated. `dynamicImports` are **not** walked: Mapbox / ZK / WASM chunks stay on-intent, matching the `modulePreload.resolveDependencies` filter in `vite.config.ts` (they are additionally dropped by `HEAVY_CHUNK_RE`). |
| Push header | `buildLinkHeader()` | `Link: </assets/index-Abc123.js>; rel=preload; as=script; type=module; crossorigin, </assets/index-XyZ987.css>; rel=preload; as=style; type=text/css` — capped at `maxAssets` (default 16) so the header stays under proxy header limits. |
| Middleware | `createHttp2PushMiddleware()` | Attached in `server/index.ts` before the static/HTML handlers. Applies to HTML document navigations only (never `/api`, `/zk`, `/metrics`, `/health`, assets with extensions, non-`GET`/`HEAD`, or `sec-fetch-dest` other than a document). Appends to any existing `Link` instead of overwriting it. |
| Early Hints | HTTP/1.1 | When the runtime exposes `res.writeEarlyHints`, the same list is sent as `103 Early Hints` before the document, then repeated in the final `Link` header. Best-effort: wrapped in `try/catch`, never fails a response. |
| Native push | HTTP/2 | If the origin really terminates HTTP/2 (`req.httpVersionMajor === 2` and `res.stream.pushStream` exists), each entry asset is pushed on its own stream from `dist/`, with `cache-control: public, max-age=31536000, immutable` (fingerprinted URLs). A missing file answers `404` on the pushed stream; a rejected push never throws. |

### Asset hash sync across releases

1. Startup load — the manifest is read when the middleware is constructed.
2. Throttled re-check — mtime/size comparison; only a *changed* manifest is re-parsed.
3. Forced re-read — `store.reload()` (deploy hook, tests) bypasses both caches and
   re-runs file verification.
4. Optional `verifyFiles` (`HTTP2_PUSH_VERIFY_FILES=true`) drops assets whose file
   is no longer on disk, so a header can never point at a pruned build.
5. Missing manifest = empty snapshot: API-only deploys and pre-build boots are
   a no-op, and the header starts working as soon as `vite build` lands.

### Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `HTTP2_PUSH_ENABLED` | `true` | Master switch. |
| `HTTP2_PUSH_EARLY_HINTS` | `true` | 103 hints on HTTP/1.1. |
| `HTTP2_PUSH_NATIVE` | `true` | `pushStream` on HTTP/2 (browsers have mostly withdrawn push support; harmless when unsupported). |
| `HTTP2_PUSH_VERIFY_FILES` | `false` | Drop assets missing on disk. |
| `HTTP2_PUSH_INCLUDE_HEAVY` | `false` | Set `true` to push the Mapbox/ZK chunks too (usually a pessimization). |
| `HTTP2_PUSH_REFRESH_MS` | `5000` | Manifest mtime re-check interval; `0` = every request. |
| `HTTP2_PUSH_MAX_ASSETS` | `16` | Cap on assets in one `Link` header. |
| `HTTP2_PUSH_DIST_DIR` | `dist` | Override the build output directory. |
| `HTTP2_PUSH_MANIFEST` | – | Explicit manifest path (wins over discovery of `.vite/manifest.json` then `manifest.json`). |

`render.yaml` sets `HTTP2_PUSH_ENABLED`, `HTTP2_PUSH_EARLY_HINTS`,
`HTTP2_PUSH_NATIVE` and `HTTP2_PUSH_VERIFY_FILES`.

### Guard rails

- No header on JSON/API responses, static asset requests, or unsafe methods —
  preload hints there would only cost bytes.
- Link parts never carry unquoted `;`: MIME parameters are stripped before the
  header is assembled (`type=text/css`, not `type="text/css; charset=utf-8"`).
- A half-written manifest (build in progress) is logged and ignored; the last
  good snapshot keeps serving.
- Push and hints are strictly best-effort: every failure path falls through to
  `next()` with the document served normally.

### Verifying

- Unit tests: `npm run test:http2-manifest` (36 cases: graph walking, header
  format/caps, hash re-reads, `verifyFiles`, document gating, early hints,
  HTTP/2 push incl. missing-asset 404, env parsing).
- `curl -I http://localhost:3001/` → `Link:` lists the current `assets/*.js` /
  `*.css` fingerprints from `dist/.vite/manifest.json`.
- Rebuild (`npm run build`) without restarting: the header picks up the new
  hashes on the next refresh window.
