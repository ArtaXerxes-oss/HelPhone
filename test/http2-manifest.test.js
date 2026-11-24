import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_ASSETS,
  DEFAULT_REFRESH_MS,
  HEAVY_CHUNK_RE,
  MANIFEST_CANDIDATES,
  buildLinkHeader,
  buildLinkPart,
  collectEntryAssets,
  createHttp2PushMiddleware,
  createManifestStore,
  distDirForManifest,
  hintFor,
  isDocumentRequest,
  optionsFromEnv,
  parseManifest,
  pushAssetsOverHttp2,
  resolveManifestPath,
} from '../server/middleware/http2Push.js';

const FIXTURE_MANIFEST = {
  'index.html': {
    file: 'assets/index-Abc123.js',
    name: 'index',
    src: 'index.html',
    isEntry: true,
    css: ['assets/index-XyZ987.css'],
    imports: ['_vendor-Vendor01.js', '_react-core-Reac111.js', '_mapbox-Mapb222.js'],
    dynamicImports: ['src/pages/Help-Load99.js'],
  },
  '_vendor-Vendor01.js': {
    file: 'assets/vendor-Vendor01.js',
    imports: ['_shared-Share33.js'],
    css: ['assets/vendor-Vendor01.css'],
  },
  '_react-core-Reac111.js': {
    file: 'assets/react-core-Reac111.js',
    imports: ['_shared-Share33.js'],
  },
  '_shared-Share33.js': { file: 'assets/shared-Share33.js' },
  '_mapbox-Mapb222.js': { file: 'assets/mapbox-Mapb222.js' },
  'src/pages/Help-Load99.js': {
    file: 'assets/help-Lazy888.js',
    src: 'src/pages/Help.tsx',
    isDynamicEntry: true,
  },
};

const FIXTURE_FILES = [
  '/assets/index-XyZ987.css',
  '/assets/index-Abc123.js',
  '/assets/vendor-Vendor01.css',
  '/assets/vendor-Vendor01.js',
  '/assets/shared-Share33.js',
  '/assets/react-core-Reac111.js',
];

function mockReq(overrides = {}) {
  const { headers, ...rest } = overrides;
  return {
    method: 'GET',
    url: '/',
    path: '/',
    originalUrl: '/',
    httpVersion: '1.1',
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    protocol: 'https',
    headers: { accept: 'text/html', ...headers },
    ...rest,
  };
}

function mockRes(overrides = {}) {
  const headers = {};
  const calls = { earlyHints: [] };
  return {
    headersSent: false,
    statusCode: 200,
    getHeader(name) {
      return headers[name.toLowerCase()];
    },
    setHeader(name, val) {
      headers[name.toLowerCase()] = val;
    },
    writeEarlyHints(hints) {
      calls.earlyHints.push(hints);
    },
    headers,
    calls,
    ...overrides,
  };
}

function runMiddleware(mw, req, res = mockRes()) {
  let called = false;
  mw(req, res, () => {
    called = true;
  });
  return { res, called };
}

describe('manifest parsing', () => {
  it('accepts a Vite manifest object and rejects anything else', () => {
    expect(parseManifest(JSON.stringify(FIXTURE_MANIFEST))['index.html'].isEntry).toBe(true);
    expect(() => parseManifest('[]')).toThrow(/JSON object/);
    expect(() => parseManifest('"nope"')).toThrow(/JSON object/);
    expect(() => parseManifest('{')).toThrow();
  });

  it('maps extensions to preload hints', () => {
    expect(hintFor('assets/index.js')).toMatchObject({ as: 'script', module: true, crossorigin: true });
    expect(hintFor('assets/index.css')).toMatchObject({ as: 'style' });
    expect(hintFor('assets/font.woff2')).toMatchObject({ as: 'font', crossorigin: true });
    expect(hintFor('assets/icon.png')).toMatchObject({ as: 'image' });
    expect(hintFor('assets/data.bin')).toMatchObject({ as: 'fetch' });
  });
});

describe('entry graph collection', () => {
  const manifest = FIXTURE_MANIFEST;

  it('walks the entry graph depth-first: entry CSS, entry chunk, then static imports', () => {
    const files = collectEntryAssets(manifest).map((asset) => asset.url);
    expect(files).toEqual(FIXTURE_FILES);
  });

  it('deduplicates shared imports reached from several chunks', () => {
    const files = collectEntryAssets(manifest).map((asset) => asset.file);
    expect(files.filter((file) => file === 'assets/shared-Share33.js')).toHaveLength(1);
  });

  it('never walks dynamicImports (on-intent chunks stay out of the critical path)', () => {
    const files = collectEntryAssets(manifest).map((asset) => asset.file);
    expect(files).not.toContain('assets/help-Lazy888.js');
    expect(files.some((file) => file.includes('Lazy'))).toBe(false);
  });

  it('drops the heavy Mapbox/ZK chunks by default, matching the modulePreload filter', () => {
    const files = collectEntryAssets(manifest).map((asset) => asset.file);
    expect(files).not.toContain('assets/mapbox-Mapb222.js');
    expect(HEAVY_CHUNK_RE.test('assets/mapbox-Mapb222.js')).toBe(true);
    expect(HEAVY_CHUNK_RE.test('assets/zk-prover-Dead99.js')).toBe(true);

    const kept = collectEntryAssets(manifest, { exclude: null }).map((asset) => asset.file);
    expect(kept).toContain('assets/mapbox-Mapb222.js');
  });

  it('tags module chunks so the header carries type=module + crossorigin', () => {
    const js = collectEntryAssets(manifest).find((asset) => asset.file.endsWith('index-Abc123.js'));
    expect(js).toMatchObject({ url: '/assets/index-Abc123.js', type: 'script', module: true, crossorigin: true });
    const css = collectEntryAssets(manifest).find((asset) => asset.file.endsWith('.css'));
    expect(css).toMatchObject({ type: 'style', module: false, crossorigin: false });
  });
});

describe('Link header generation', () => {
  it('formats a preload link for scripts, styles and fonts', () => {
    const js = collectEntryAssets(FIXTURE_MANIFEST).find((a) => a.file.endsWith('index-Abc123.js'));
    expect(buildLinkPart(js)).toBe(
      '</assets/index-Abc123.js>; rel=preload; as=script; type=module; crossorigin'
    );

    const css = collectEntryAssets(FIXTURE_MANIFEST).find((a) => a.file.endsWith('.css'));
    expect(buildLinkPart(css)).toBe('</assets/index-XyZ987.css>; rel=preload; as=style; type=text/css');

    const font = hintFor('assets/font.woff2');
    expect(
      buildLinkPart({
        url: '/assets/font.woff2',
        file: 'assets/font.woff2',
        type: font.as,
        module: false,
        mime: font.mime,
        crossorigin: true,
      })
    ).toBe('</assets/font.woff2>; rel=preload; as=font; type=font/woff2; crossorigin');
  });

  it('joins every asset into one comma-separated header value', () => {
    const header = buildLinkHeader(collectEntryAssets(FIXTURE_MANIFEST));
    expect(header.split(', ').map((part) => part.slice(1, part.indexOf('>')))).toEqual(FIXTURE_FILES);
  });

  it('caps the header at the configured asset budget', () => {
    const header = buildLinkHeader(collectEntryAssets(FIXTURE_MANIFEST), { max: 2 });
    expect(header.split(', ')).toHaveLength(2);
    expect(DEFAULT_MAX_ASSETS).toBeGreaterThan(2);
  });

  it('emits an empty header when there is nothing to push', () => {
    expect(buildLinkHeader([])).toBe('');
  });
});

describe('manifest store (asset hash sync)', () => {
  let distDir;

  beforeEach(() => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helphone-http2-'));
    fs.mkdirSync(path.join(distDir, '.vite'), { recursive: true });
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(distDir, '.vite', 'manifest.json'),
      JSON.stringify(FIXTURE_MANIFEST)
    );
    for (const file of FIXTURE_FILES) {
      fs.mkdirSync(path.dirname(path.join(distDir, file)), { recursive: true });
      fs.writeFileSync(path.join(distDir, file), `/* ${file} */`);
    }
  });

  afterEach(() => {
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it('reads the manifest at construction (startup), not on first request', () => {
    const store = createManifestStore({ distDir });
    expect(store.manifestPath).toBe(path.join(distDir, '.vite', 'manifest.json'));
    expect(store.snapshot().loaded).toBe(true);
    expect(store.snapshot().linkHeader).toContain('/assets/index-Abc123.js');
  });

  it('finds the manifest in either Vite location and derives the dist root', () => {
    expect(resolveManifestPath(distDir)).toBe(path.join(distDir, '.vite', 'manifest.json'));
    expect(distDirForManifest(path.join(distDir, '.vite', 'manifest.json'))).toBe(distDir);

    fs.rmSync(path.join(distDir, '.vite', 'manifest.json'));
    fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify(FIXTURE_MANIFEST));
    expect(resolveManifestPath(distDir)).toBe(path.join(distDir, 'manifest.json'));
    expect(distDirForManifest(path.join(distDir, 'manifest.json'))).toBe(distDir);
  });

  it('re-reads the manifest after a rebuild so hashes track the deployment', () => {
    const store = createManifestStore({ distDir, refreshIntervalMs: 0 });
    expect(store.snapshot().linkHeader).toContain('index-Abc123');

    const rebuilt = JSON.parse(JSON.stringify(FIXTURE_MANIFEST));
    rebuilt['index.html'].file = 'assets/index-Zzz999.js';
    rebuilt['index.html'].css = ['assets/index-Qqq888.css'];
    const target = path.join(distDir, '.vite', 'manifest.json');
    fs.writeFileSync(target, JSON.stringify(rebuilt));
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(target, future, future);

    const next = store.snapshot();
    expect(next.linkHeader).toContain('/assets/index-Zzz999.js');
    expect(next.linkHeader).toContain('/assets/index-Qqq888.css');
    expect(next.linkHeader).not.toContain('index-Abc123');
  });

  it('throttles re-reads to the refresh interval', () => {
    const store = createManifestStore({ distDir, refreshIntervalMs: 60_000 });
    const rebuilt = JSON.parse(JSON.stringify(FIXTURE_MANIFEST));
    rebuilt['index.html'].file = 'assets/index-New111.js';
    fs.writeFileSync(path.join(distDir, '.vite', 'manifest.json'), JSON.stringify(rebuilt));

    // Inside the window the cached snapshot (old hashes) is served.
    expect(store.snapshot().linkHeader).toContain('index-Abc123');
    // An explicit reload — e.g. a deploy hook — bypasses the window.
    expect(store.reload().linkHeader).toContain('index-New111');
  });

  it('returns an empty snapshot when no build exists (API-only deploys)', () => {
    fs.rmSync(path.join(distDir, '.vite', 'manifest.json'));
    const store = createManifestStore({ distDir, refreshIntervalMs: 0 });
    const snapshot = store.snapshot();
    expect(snapshot.loaded).toBe(false);
    expect(snapshot.linkHeader).toBe('');
    expect(snapshot.assets).toEqual([]);
    expect(store.manifestPath).toBeNull();
  });

  it('drops entries whose file is gone when verifyFiles is on', () => {
    const store = createManifestStore({ distDir, refreshIntervalMs: 0, verifyFiles: true });
    expect(store.snapshot().assets).toHaveLength(FIXTURE_FILES.length);

    fs.rmSync(path.join(distDir, 'assets', 'index-Abc123.js'));
    const after = store.reload();
    expect(after.linkHeader).not.toContain('index-Abc123');
    expect(after.assets.map((a) => a.file)).not.toContain('assets/index-Abc123.js');
    expect(after.assets.map((a) => a.file)).toContain('assets/index-XyZ987.css');
  });

  it('ignores a half-written manifest instead of failing requests', () => {
    const target = path.join(distDir, '.vite', 'manifest.json');
    fs.writeFileSync(target, JSON.stringify(FIXTURE_MANIFEST));
    const store = createManifestStore({ distDir, refreshIntervalMs: 0 });
    expect(store.snapshot().loaded).toBe(true);

    fs.writeFileSync(target, '{"index.html": {"file": "assets/partial');
    const snapshot = store.reload();
    // Previous good snapshot is retained; nothing throws.
    expect(snapshot.loaded).toBe(true);
    expect(snapshot.linkHeader).toContain('index-Abc123');
  });

  it('exposes a constant refresh default', () => {
    expect(DEFAULT_REFRESH_MS).toBeGreaterThan(0);
    expect(MANIFEST_CANDIDATES[0]).toBe('.vite/manifest.json');
  });
});

describe('document request detection', () => {
  it('targets HTML navigations only', () => {
    expect(isDocumentRequest(mockReq())).toBe(true);
    expect(isDocumentRequest(mockReq({ headers: { accept: 'text/html,application/xhtml+xml' } }))).toBe(true);
    expect(isDocumentRequest(mockReq({ headers: { accept: '*/*' } }))).toBe(true);
    expect(isDocumentRequest(mockReq({ headers: { accept: 'application/json' } }))).toBe(false);
    expect(isDocumentRequest(mockReq({ headers: { 'sec-fetch-dest': 'script' } }))).toBe(false);
    expect(isDocumentRequest(mockReq({ headers: { 'sec-fetch-dest': 'document' } }))).toBe(true);
  });

  it('skips the JSON API, metrics and static assets', () => {
    expect(isDocumentRequest(mockReq({ path: '/api/state/export', url: '/api/state/export' }))).toBe(false);
    expect(isDocumentRequest(mockReq({ path: '/health', url: '/health' }))).toBe(false);
    expect(isDocumentRequest(mockReq({ path: '/metrics', url: '/metrics' }))).toBe(false);
    expect(isDocumentRequest(mockReq({ path: '/zk/health', url: '/zk/health' }))).toBe(false);
    expect(isDocumentRequest(mockReq({ path: '/assets/index-Abc123.js', url: '/assets/index-Abc123.js' }))).toBe(false);
  });

  it('skips non-idempotent methods', () => {
    expect(isDocumentRequest(mockReq({ method: 'POST', path: '/help', url: '/help' }))).toBe(false);
    expect(isDocumentRequest(mockReq({ method: 'HEAD', path: '/help', url: '/help' }))).toBe(true);
  });
});

describe('http2 push middleware', () => {
  let distDir;

  beforeEach(() => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helphone-http2-mw-'));
    fs.mkdirSync(path.join(distDir, '.vite'), { recursive: true });
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distDir, '.vite', 'manifest.json'), JSON.stringify(FIXTURE_MANIFEST));
    for (const file of FIXTURE_FILES) {
      fs.mkdirSync(path.dirname(path.join(distDir, file)), { recursive: true });
      fs.writeFileSync(path.join(distDir, file), `/* ${file} */`);
    }
  });

  afterEach(() => {
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it('stamps the manifest-derived Link header on document responses', () => {
    const mw = createHttp2PushMiddleware({ distDir, refreshIntervalMs: 0 });
    const { res, called } = runMiddleware(mw, mockReq());
    expect(called).toBe(true);
    const link = res.getHeader('Link');
    expect(link).toContain('</assets/index-Abc123.js>; rel=preload; as=script; type=module; crossorigin');
    expect(link).toContain('</assets/index-XyZ987.css>; rel=preload; as=style; type=text/css');
    expect(link).toContain('/assets/react-core-Reac111.js');
    expect(link).not.toContain('mapbox');
    expect(link).not.toContain('help-Lazy888');
  });

  it('appends to an existing Link header instead of overwriting it', () => {
    const mw = createHttp2PushMiddleware({ distDir, refreshIntervalMs: 0 });
    const res = mockRes();
    res.setHeader('Link', '</fonts/inter.woff2>; rel=preload; as=font');
    runMiddleware(mw, mockReq(), res);
    const link = res.getHeader('Link');
    expect(link.startsWith('</fonts/inter.woff2>; rel=preload; as=font, ')).toBe(true);
    expect(link).toContain('index-Abc123.js');
  });

  it('sends 103 Early Hints with the same list on HTTP/1.1', () => {
    const mw = createHttp2PushMiddleware({ distDir, refreshIntervalMs: 0 });
    const { res } = runMiddleware(mw, mockReq());
    expect(res.calls.earlyHints).toHaveLength(1);
    expect(res.calls.earlyHints[0].Link).toBe(res.getHeader('Link'));
  });

  it('leaves API, asset and non-document responses untouched', () => {
    const mw = createHttp2PushMiddleware({ distDir, refreshIntervalMs: 0 });
    for (const req of [
      mockReq({ path: '/api/state/export', url: '/api/state/export' }),
      mockReq({ path: '/assets/index-Abc123.js', url: '/assets/index-Abc123.js' }),
      mockReq({ method: 'POST', path: '/help', url: '/help' }),
      mockReq({ headers: { accept: 'application/json' } }),
    ]) {
      const { res } = runMiddleware(mw, req);
      expect(res.getHeader('Link')).toBeUndefined();
      expect(res.calls.earlyHints).toHaveLength(0);
    }
  });

  it('is a no-op when disabled or when no build exists', () => {
    const disabled = createHttp2PushMiddleware({ distDir, refreshIntervalMs: 0, enabled: false });
    expect(runMiddleware(disabled, mockReq()).res.getHeader('Link')).toBeUndefined();

    fs.rmSync(path.join(distDir, '.vite', 'manifest.json'));
    const unbuilt = createHttp2PushMiddleware({ distDir, refreshIntervalMs: 0 });
    expect(runMiddleware(unbuilt, mockReq()).res.getHeader('Link')).toBeUndefined();
  });

  it('can run with an injected store', () => {
    const store = createManifestStore({ distDir, refreshIntervalMs: 0 });
    const mw = createHttp2PushMiddleware({ store });
    expect(runMiddleware(mw, mockReq()).res.getHeader('Link')).toContain('index-Abc123.js');
  });

  it('pushes the entry assets on a real HTTP/2 stream', async () => {
    const mw = createHttp2PushMiddleware({ distDir, refreshIntervalMs: 0 });
    const pushes = [];
    const res = mockRes({
      stream: {
        pushStream(headers, _options, callback) {
          const stream = {
            requestHeaders: headers,
            responded: null,
            chunks: [],
            respond(responseHeaders) {
              this.responded = responseHeaders;
            },
            on() {},
            destroy() {},
            end(chunk) {
              if (chunk) this.chunks.push(chunk);
            },
            write(chunk) {
              this.chunks.push(chunk);
              return true;
            },
          };
          pushes.push(stream);
          callback(null, stream);
        },
      },
    });

    const { res: result } = runMiddleware(mw, mockReq({ httpVersion: '2.0', httpVersionMajor: 2 }), res);
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes.map((push) => push.requestHeaders[':path'])).toEqual(FIXTURE_FILES);
    expect(pushes.every((push) => push.requestHeaders[':method'] === 'GET')).toBe(true);
    expect(pushes.every((push) => push.requestHeaders[':scheme'] === 'https')).toBe(true);
    expect(result.getHeader('Link')).toContain('index-Abc123.js');

    // Each pushed stream serves the deployed file from dist.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cssPush = pushes.find((push) => push.requestHeaders[':path'].endsWith('.css'));
    expect(cssPush.responded[':status']).toBe(200);
    expect(cssPush.responded['content-type']).toBe('text/css; charset=utf-8');
    expect(cssPush.responded['cache-control']).toContain('immutable');
    expect(Buffer.concat(cssPush.chunks).toString()).toContain('/assets/index-XyZ987.css');
  });

  it('never throws when the origin does not terminate HTTP/2', () => {
    const res = mockRes();
    expect(pushAssetsOverHttp2(mockReq(), res, collectEntryAssets(FIXTURE_MANIFEST), distDir)).toBe(0);
    const mw = createHttp2PushMiddleware({ distDir, refreshIntervalMs: 0 });
    expect(() => runMiddleware(mw, mockReq({ httpVersion: '2.0', httpVersionMajor: 2 }), res)).not.toThrow();
  });

  it('survives a rejected push without failing the response', () => {
    const res = mockRes({
      stream: {
        pushStream() {
          throw new Error('ERR_HTTP2_PUSH_DISABLED');
        },
      },
    });
    const attempted = pushAssetsOverHttp2(
      mockReq({ httpVersion: '2.0', httpVersionMajor: 2 }),
      res,
      collectEntryAssets(FIXTURE_MANIFEST),
      distDir
    );
    expect(attempted).toBe(0);
  });

  it('answers 404 on the pushed stream when the asset vanished mid-release', async () => {
    fs.rmSync(path.join(distDir, 'assets', 'vendor-Vendor01.css'));
    const mw = createHttp2PushMiddleware({ distDir, refreshIntervalMs: 0 });
    const streams = [];
    const res = mockRes({
      stream: {
        pushStream(_headers, _options, callback) {
          const stream = {
            responded: null,
            respond(headers) {
              this.responded = headers;
            },
            on() {},
            destroy() {},
            end() {},
          };
          streams.push(stream);
          callback(null, stream);
        },
      },
    });
    runMiddleware(mw, mockReq({ httpVersion: '2.0', httpVersionMajor: 2 }), res);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const missing = streams.find((stream) => stream.responded && stream.responded[':status'] === 404);
    expect(missing).toBeTruthy();
  });
});

describe('environment configuration', () => {
  it('defaults to enabled with early hints and native push on', () => {
    expect(optionsFromEnv({})).toEqual({
      enabled: true,
      earlyHints: true,
      nativePush: true,
      verifyFiles: false,
      excludeHeavy: true,
    });
  });

  it('parses feature switches', () => {
    expect(optionsFromEnv({ HTTP2_PUSH_ENABLED: 'false' }).enabled).toBe(false);
    expect(optionsFromEnv({ HTTP2_PUSH_EARLY_HINTS: '0' }).earlyHints).toBe(false);
    expect(optionsFromEnv({ HTTP2_PUSH_NATIVE: 'off' }).nativePush).toBe(false);
    expect(optionsFromEnv({ HTTP2_PUSH_VERIFY_FILES: 'true' }).verifyFiles).toBe(true);
    expect(optionsFromEnv({ HTTP2_PUSH_INCLUDE_HEAVY: 'true' }).excludeHeavy).toBe(false);
    expect(optionsFromEnv({ HTTP2_PUSH_ENABLED: '' }).enabled).toBe(true);
  });

  it('parses numeric and path overrides, ignoring invalid numbers', () => {
    expect(optionsFromEnv({ HTTP2_PUSH_REFRESH_MS: '250' })).toMatchObject({ refreshIntervalMs: 250 });
    expect(optionsFromEnv({ HTTP2_PUSH_MAX_ASSETS: '4' })).toMatchObject({ maxAssets: 4 });
    expect(optionsFromEnv({ HTTP2_PUSH_MAX_ASSETS: 'lots' })).not.toHaveProperty('maxAssets');
    expect(optionsFromEnv({ HTTP2_PUSH_REFRESH_MS: '-5' })).not.toHaveProperty('refreshIntervalMs');
    expect(optionsFromEnv({ HTTP2_PUSH_MANIFEST: '/srv/app/dist/.vite/manifest.json' })).toMatchObject({
      manifestPath: '/srv/app/dist/.vite/manifest.json',
    });
    expect(optionsFromEnv({ HTTP2_PUSH_DIST_DIR: '/srv/app/dist' })).toMatchObject({ distDir: '/srv/app/dist' });
  });

  it('falls back to the caller-supplied dist directory', () => {
    expect(optionsFromEnv({}, { distDir: '/srv/app/dist' })).toMatchObject({ distDir: '/srv/app/dist' });
    expect(optionsFromEnv({ HTTP2_PUSH_DIST_DIR: '/tmp/dist' }, { distDir: '/srv/app/dist' })).toMatchObject({
      distDir: '/tmp/dist',
    });
  });
});
