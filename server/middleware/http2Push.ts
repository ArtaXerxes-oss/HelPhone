/**
 * server/middleware/http2Push.ts — HTTP/2 push & preload asset manifest builder
 *
 * Vite fingerprints every compiled chunk and records the mapping in
 * `dist/.vite/manifest.json` (`build.manifest: true` in `vite.config.ts`).
 * This module reads that manifest once at startup, walks the entry graph
 * (`index.html` → its static `imports` → their `css`), and stamps
 *
 *     Link: </assets/index-abc.js>; rel=preload; as=script; type=module; crossorigin
 *
 * onto HTML document responses, so the browser starts fetching the exact
 * hashes that were deployed before it has parsed the HTML.
 *
 * Three things keep the header honest across releases:
 *   1. the manifest's mtime/size is re-checked on a short interval and
 *      re-parsed whenever it changes, so a new build's hashes replace the old
 *      ones without a restart;
 *   2. entries whose files are no longer on disk are dropped (`verifyFiles`);
 *   3. only the entry graph is emitted — `dynamicImports` (Mapbox, the ZK/WASM
 *      prover) stay on-demand, matching the `modulePreload` filter in
 *      `vite.config.ts`.
 *
 * On HTTP/1.1 the same list is also sent as a 103 Early Hints `Link` when the
 * runtime supports it. When the origin itself terminates HTTP/2, each asset is
 * additionally pushed on the stream (`res.stream.pushStream`) straight from
 * disk — guarded, because browsers have largely withdrawn push support.
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { NextFunction, Request, RequestHandler, Response } from 'express'

/** How often the manifest's mtime is re-checked (ms). `0` = on every request. */
export const DEFAULT_REFRESH_MS = 5_000

/** Upper bound of assets in one `Link` header (protects header size limits). */
export const DEFAULT_MAX_ASSETS = 16

/**
 * Chunks the entry HTML never preloads (#542): Mapbox GL and the ZK/WASM
 * prover are fetched on intent, never on the landing page's critical path.
 */
export const HEAVY_CHUNK_RE = /(^|\/)(mapbox|zk)-[^/]*\.js$/

/** Manifest locations Vite writes, most specific first (Vite ≥5 uses `.vite/`). */
export const MANIFEST_CANDIDATES = ['.vite/manifest.json', 'manifest.json'] as const

export const LINK_HEADER = 'Link'

/** API/JSON prefixes — never HTML document responses. */
const NON_DOCUMENT_PATH_RE = /^\/(?:api|zk|admin|metrics|health)(?:\/|$)/

/** Any path with an extension is a static asset request, not a document. */
const ASSET_PATH_RE = /\.[a-z0-9]{2,5}$/i

export interface ViteManifestEntry {
  file: string
  src?: string
  name?: string
  isEntry?: boolean
  isDynamicEntry?: boolean
  css?: string[]
  imports?: string[]
  dynamicImports?: string[]
}

export type ViteManifest = Record<string, ViteManifestEntry>

export interface PushAsset {
  /** Origin-relative URL (`/assets/index-abc.js`). */
  url: string
  /** Path relative to the dist root — what is read from disk when pushing. */
  file: string
  /** Value for the `Link` `as=` parameter. */
  type: string
  /** ES module chunk → `type=module` instead of a MIME type. */
  module: boolean
  /** MIME type (Link `type=` for non-modules; `Content-Type` when pushing). */
  mime: string
  /** Fetch in CORS mode (`crossorigin`) — required for module scripts/fonts. */
  crossorigin: boolean
}

interface PreloadHint {
  as: string
  mime: string
  module?: boolean
  crossorigin?: boolean
}

const EXT_HINTS: Record<string, PreloadHint> = {
  '.js': { as: 'script', mime: 'text/javascript; charset=utf-8', module: true, crossorigin: true },
  '.mjs': { as: 'script', mime: 'text/javascript; charset=utf-8', module: true, crossorigin: true },
  '.cjs': { as: 'script', mime: 'text/javascript; charset=utf-8', crossorigin: true },
  '.css': { as: 'style', mime: 'text/css; charset=utf-8' },
  '.woff2': { as: 'font', mime: 'font/woff2', crossorigin: true },
  '.woff': { as: 'font', mime: 'font/woff', crossorigin: true },
  '.ttf': { as: 'font', mime: 'font/ttf', crossorigin: true },
  '.otf': { as: 'font', mime: 'font/otf', crossorigin: true },
  '.eot': { as: 'font', mime: 'application/vnd.ms-fontobject', crossorigin: true },
  '.png': { as: 'image', mime: 'image/png' },
  '.jpg': { as: 'image', mime: 'image/jpeg' },
  '.jpeg': { as: 'image', mime: 'image/jpeg' },
  '.webp': { as: 'image', mime: 'image/webp' },
  '.avif': { as: 'image', mime: 'image/avif' },
  '.gif': { as: 'image', mime: 'image/gif' },
  '.svg': { as: 'image', mime: 'image/svg+xml' },
  '.ico': { as: 'image', mime: 'image/x-icon' },
}

const DEFAULT_HINT: PreloadHint = { as: 'fetch', mime: 'application/octet-stream' }

export function hintFor(file: string): PreloadHint {
  return EXT_HINTS[extname(file).toLowerCase()] ?? DEFAULT_HINT
}

/** `assets/x.js` → `assets/x.js`; `/assets/x.js` → `assets/x.js`. */
export function normalizeAssetPath(file: string): string {
  return file.replace(/^[/\\]+/, '').replace(/\\/g, '/')
}

export function parseManifest(raw: string): ViteManifest {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Vite manifest must be a JSON object')
  }
  return parsed as ViteManifest
}

export interface CollectOptions {
  /**
   * Files matching this are dropped from the push list. `undefined` keeps the
   * default heavy-chunk exclusion; `null` keeps everything.
   */
  exclude?: RegExp | null
}

/**
 * Flatten the entry graph into an ordered preload list: for each entry, its
 * CSS first, then the entry chunk, then its static imports depth-first.
 * Dynamic imports are deliberately not walked.
 */
export function collectEntryAssets(manifest: ViteManifest, opts: CollectOptions = {}): PushAsset[] {
  const exclude = opts.exclude === undefined ? HEAVY_CHUNK_RE : opts.exclude

  const entryKeys = Object.keys(manifest).filter((key) => manifest[key]?.isEntry)
  const ordered = entryKeys.includes('index.html')
    ? ['index.html', ...entryKeys.filter((key) => key !== 'index.html')]
    : entryKeys

  const assets: PushAsset[] = []
  const seenFiles = new Set<string>()
  const seenKeys = new Set<string>()

  const addFile = (rawFile: string | undefined) => {
    if (!rawFile) return
    const file = normalizeAssetPath(rawFile)
    if (!file || seenFiles.has(file)) return
    seenFiles.add(file)
    if (/\.html?$/i.test(file)) return
    if (exclude && exclude.test(file)) return
    const hint = hintFor(file)
    assets.push({
      url: `/${file}`,
      file,
      type: hint.as,
      module: Boolean(hint.module),
      mime: hint.mime,
      crossorigin: Boolean(hint.crossorigin),
    })
  }

  const visit = (key: string) => {
    if (seenKeys.has(key)) return
    const entry = manifest[key]
    if (!entry) return
    seenKeys.add(key)
    for (const css of entry.css ?? []) addFile(css)
    addFile(entry.file)
    for (const imported of entry.imports ?? []) visit(imported)
  }

  for (const key of ordered) visit(key)
  return assets
}

/** One `</path>; rel=preload; …` element. */
export function buildLinkPart(asset: PushAsset): string {
  let part = `<${asset.url}>; rel=preload; as=${asset.type}`
  if (asset.module) part += '; type=module'
  else {
    // Parameters may not carry `;` unquoted — strip any MIME parameters.
    const mime = asset.mime.split(';')[0].trim()
    if (mime) part += `; type=${mime}`
  }
  if (asset.crossorigin) part += '; crossorigin'
  return part
}

/** Comma-separated `Link` header value for the first `max` assets. */
export function buildLinkHeader(assets: readonly PushAsset[], opts: { max?: number } = {}): string {
  const max = opts.max ?? DEFAULT_MAX_ASSETS
  return assets
    .slice(0, Math.max(0, max))
    .map(buildLinkPart)
    .join(', ')
}

/** First existing manifest under `distDir`, or `null` (not built yet). */
export function resolveManifestPath(distDir: string): string | null {
  for (const candidate of MANIFEST_CANDIDATES) {
    const path = join(distDir, candidate)
    if (existsSync(path)) return path
  }
  return null
}

/** The dist root for a manifest — `.vite/manifest.json` sits one level below it. */
export function distDirForManifest(manifestPath: string): string {
  const dir = dirname(manifestPath)
  return dir.endsWith('.vite') ? dirname(dir) : dir
}

export interface PushManifestSnapshot {
  /** Absolute path of the manifest that produced this snapshot. */
  manifestPath: string | null
  /** mtime of that manifest (0 when nothing was loaded). */
  mtimeMs: number
  assets: readonly PushAsset[]
  linkHeader: string
  /** True when a manifest was found and parsed. */
  loaded: boolean
}

export const EMPTY_SNAPSHOT: PushManifestSnapshot = Object.freeze({
  manifestPath: null,
  mtimeMs: 0,
  assets: Object.freeze([]) as readonly PushAsset[],
  linkHeader: '',
  loaded: false,
})

export interface ManifestStoreOptions {
  /** Dist output directory (default `<cwd>/dist`). */
  distDir?: string
  /** Explicit manifest path; wins over `distDir` discovery. */
  manifestPath?: string
  /** See `CollectOptions.exclude`. */
  exclude?: RegExp | null
  /** Drop the default Mapbox/ZK exclusion (see `HEAVY_CHUNK_RE`). */
  excludeHeavy?: boolean
  /** mtime re-check interval in ms; `0` re-checks on every read. */
  refreshIntervalMs?: number
  /** Drop assets whose file is missing on disk. */
  verifyFiles?: boolean
  /** Cap for the `Link` header. */
  maxAssets?: number
}

export interface ManifestStore {
  readonly distDir: string
  readonly manifestPath: string | null
  /** Throttled read: re-parses only when the manifest changed. */
  snapshot(): PushManifestSnapshot
  /** Forces a re-read (deploy hook / tests). */
  reload(): PushManifestSnapshot
}

/**
 * Reads and caches the build manifest. Constructed eagerly at startup so the
 * first response already carries a header; missing builds (API-only deploys)
 * are a no-op and get picked up once `vite build` lands.
 */
export function createManifestStore(options: ManifestStoreOptions = {}): ManifestStore {
  const distDir =
    options.distDir ?? (options.manifestPath ? distDirForManifest(options.manifestPath) : join(process.cwd(), 'dist'))
  const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS
  const verifyFiles = options.verifyFiles ?? false
  const maxAssets = options.maxAssets ?? DEFAULT_MAX_ASSETS
  const collectOptions: CollectOptions =
    options.exclude !== undefined ? { exclude: options.exclude } : options.excludeHeavy === false ? { exclude: null } : {}

  let snapshot: PushManifestSnapshot = EMPTY_SNAPSHOT
  let lastCheckAt = 0
  let statKey = ''

  function read(path: string, force = false): PushManifestSnapshot {
    let stat
    let raw: string
    try {
      stat = statSync(path)
      raw = readFileSync(path, 'utf8')
    } catch {
      statKey = ''
      snapshot = EMPTY_SNAPSHOT
      return snapshot
    }

    const key = `${path}|${stat.mtimeMs}|${stat.size}`
    if (!force && key === statKey) return snapshot

    let assets: PushAsset[]
    try {
      assets = collectEntryAssets(parseManifest(raw), collectOptions)
    } catch (err) {
      // A half-written manifest during a build must never break responses.
      console.warn(`[http2push] ignoring unreadable manifest ${path}: ${(err as Error).message}`)
      return snapshot
    }
    if (verifyFiles) assets = assets.filter((asset) => existsSync(join(distDir, asset.file)))

    statKey = key
    snapshot = {
      manifestPath: path,
      mtimeMs: stat.mtimeMs,
      assets,
      linkHeader: buildLinkHeader(assets, { max: maxAssets }),
      loaded: true,
    }
    return snapshot
  }

  function locate(): string | null {
    return options.manifestPath ?? resolveManifestPath(distDir)
  }

  function dropToEmpty(): PushManifestSnapshot {
    statKey = ''
    snapshot = EMPTY_SNAPSHOT
    return snapshot
  }

  /** Cheap re-check: stat the manifest, re-parse only when it actually changed. */
  function check(): PushManifestSnapshot {
    lastCheckAt = Date.now()
    const path = locate()
    if (!path || !existsSync(path)) return dropToEmpty()
    return read(path)
  }

  /** Forced re-read (deploy hook, tests): re-parses even if the stat is unchanged. */
  function reload(): PushManifestSnapshot {
    lastCheckAt = Date.now()
    const path = locate()
    if (!path || !existsSync(path)) return dropToEmpty()
    return read(path, true)
  }

  function current(): PushManifestSnapshot {
    const now = Date.now()
    if (refreshIntervalMs <= 0 || now - lastCheckAt >= refreshIntervalMs) return check()
    return snapshot
  }

  reload()

  return {
    get distDir() {
      return distDir
    },
    get manifestPath() {
      return snapshot.manifestPath
    },
    snapshot: current,
    reload,
  }
}

export interface Http2PushEnvOptions {
  enabled?: boolean
  earlyHints?: boolean
  nativePush?: boolean
  verifyFiles?: boolean
  excludeHeavy?: boolean
  refreshIntervalMs?: number
  maxAssets?: number
  manifestPath?: string
  distDir?: string
}

const truthy = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && /^(1|true|yes|on)$/i.test(value)

function readInt(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** `HTTP2_PUSH_*` environment configuration (all optional). */
export function optionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  defaults: { distDir?: string } = {}
): Http2PushEnvOptions {
  const includeHeavy = truthy(env.HTTP2_PUSH_INCLUDE_HEAVY)
  const options: Http2PushEnvOptions = {
    enabled: env.HTTP2_PUSH_ENABLED === undefined || env.HTTP2_PUSH_ENABLED === '' ? true : truthy(env.HTTP2_PUSH_ENABLED),
    earlyHints: env.HTTP2_PUSH_EARLY_HINTS === undefined || env.HTTP2_PUSH_EARLY_HINTS === '' ? true : truthy(env.HTTP2_PUSH_EARLY_HINTS),
    nativePush: env.HTTP2_PUSH_NATIVE === undefined || env.HTTP2_PUSH_NATIVE === '' ? true : truthy(env.HTTP2_PUSH_NATIVE),
    verifyFiles: truthy(env.HTTP2_PUSH_VERIFY_FILES),
    excludeHeavy: !includeHeavy,
  }
  const refreshIntervalMs = readInt(env.HTTP2_PUSH_REFRESH_MS)
  const maxAssets = readInt(env.HTTP2_PUSH_MAX_ASSETS)
  if (refreshIntervalMs !== undefined) options.refreshIntervalMs = refreshIntervalMs
  if (maxAssets !== undefined) options.maxAssets = maxAssets
  if (env.HTTP2_PUSH_MANIFEST) options.manifestPath = env.HTTP2_PUSH_MANIFEST
  if (env.HTTP2_PUSH_DIST_DIR) options.distDir = env.HTTP2_PUSH_DIST_DIR
  else if (defaults.distDir) options.distDir = defaults.distDir
  return options
}

/** Document navigations only: skip the JSON API, static assets and no-store APIs. */
export function isDocumentRequest(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const path = req.path || (req.url || '/').split('?')[0]
  if (NON_DOCUMENT_PATH_RE.test(path)) return false
  if (ASSET_PATH_RE.test(path)) return false

  const dest = String(req.headers['sec-fetch-dest'] || '')
  if (dest && dest !== 'document' && dest !== 'iframe' && dest !== 'frame') return false

  const accept = String(req.headers.accept || '').toLowerCase()
  if (accept.includes('text/html')) return true
  if (accept.includes('application/json')) return false
  return true
}

function readExistingLink(res: Response): string {
  const value = res.getHeader(LINK_HEADER) as string | string[] | number | undefined
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

interface PushStreamLike {
  respond(headers: Record<string, unknown>): void
  end(chunk?: unknown): void
  on?: (event: string, listener: (...args: never[]) => void) => unknown
}

interface Http2PushableResponse {
  stream?: {
    pushStream?: (
      headers: Record<string, unknown>,
      options: Record<string, unknown>,
      callback: (err: Error | null, pushStream?: PushStreamLike) => void
    ) => unknown
  }
  writeEarlyHints?: (hints: Record<string, string | string[]>) => void
}

function sendPushedAsset(pushStream: PushStreamLike, filePath: string, asset: PushAsset): void {
  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    try {
      pushStream.respond({ ':status': 404, 'content-type': 'text/plain; charset=utf-8' })
      pushStream.end('Not Found')
    } catch {
      /* stream already closed */
    }
    return
  }

  try {
    pushStream.respond({
      ':status': 200,
      'content-type': asset.mime,
      'content-length': size,
      // Fingerprinted filenames are immutable.
      'cache-control': 'public, max-age=31536000, immutable',
    })
  } catch {
    return
  }

  const file = createReadStream(filePath)
  file.on('error', () => {
    try {
      pushStream.end()
    } catch {
      /* stream already closed */
    }
  })
  file.pipe(pushStream as unknown as NodeJS.WritableStream)
}

/**
 * Push each entry asset on the HTTP/2 stream. Returns how many push streams
 * were opened; never throws — a rejected push must not fail the document.
 */
export function pushAssetsOverHttp2(
  req: Request,
  res: Response,
  assets: readonly PushAsset[],
  distDir: string
): number {
  const stream = (res as unknown as Http2PushableResponse).stream
  if (!stream || typeof stream.pushStream !== 'function') return 0

  const scheme = (req as unknown as { protocol?: string }).protocol === 'http' ? 'http' : 'https'
  let attempted = 0

  for (const asset of assets) {
    const headers = {
      ':method': 'GET',
      ':path': asset.url,
      ':scheme': scheme,
      'content-type': asset.mime,
    }
    try {
      stream.pushStream!(headers, {}, (err, pushStream) => {
        if (err || !pushStream) return
        pushStream.on?.('error', () => undefined)
        sendPushedAsset(pushStream, join(distDir, asset.file), asset)
      })
      attempted += 1
    } catch {
      // Session closing or duplicate :path — HTTP/2 allows the push to fail.
    }
  }
  return attempted
}

export interface Http2PushOptions extends ManifestStoreOptions {
  /** Master switch (`HTTP2_PUSH_ENABLED`). Default true. */
  enabled?: boolean
  /** Emit a 103 Early Hints `Link` on HTTP/1.1 (`HTTP2_PUSH_EARLY_HINTS`). Default true. */
  earlyHints?: boolean
  /** Native `pushStream` on HTTP/2 (`HTTP2_PUSH_NATIVE`). Default true. */
  nativePush?: boolean
  /** Inject a store (tests). */
  store?: ManifestStore
}

/**
 * Express middleware: attaches the manifest-derived preload list to HTML
 * document responses as `Link`, optionally as 103 Early Hints and/or a native
 * HTTP/2 push.
 */
export function createHttp2PushMiddleware(options: Http2PushOptions = {}): RequestHandler {
  const enabled = options.enabled ?? true
  const earlyHints = options.earlyHints ?? true
  const nativePush = options.nativePush ?? true

  const storeOptions: ManifestStoreOptions = { ...options }
  if (storeOptions.exclude === undefined && options.excludeHeavy === false) storeOptions.exclude = null
  // Created eagerly so the manifest is read at startup, not on first request.
  const store = options.store ?? (enabled ? createManifestStore(storeOptions) : undefined)

  return function http2PushMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!enabled || !store || !isDocumentRequest(req)) return next()

    const snapshot = store.snapshot()
    if (!snapshot.linkHeader) return next()

    // 103 Early Hints travel ahead of the document; Node only implements them
    // on HTTP/1.1 and refuses once headers are on the wire.
    if (earlyHints && !res.headersSent && req.httpVersionMajor === 1) {
      const writeEarlyHints = (res as unknown as Http2PushableResponse).writeEarlyHints
      if (typeof writeEarlyHints === 'function') {
        try {
          writeEarlyHints.call(res, { Link: snapshot.linkHeader })
        } catch {
          /* hinting is best-effort */
        }
      }
    }

    const existing = readExistingLink(res)
    res.setHeader(LINK_HEADER, existing ? `${existing}, ${snapshot.linkHeader}` : snapshot.linkHeader)

    if (nativePush && req.httpVersionMajor === 2) {
      pushAssetsOverHttp2(req, res, snapshot.assets, store.distDir)
    }

    next()
  }
}

export default createHttp2PushMiddleware
