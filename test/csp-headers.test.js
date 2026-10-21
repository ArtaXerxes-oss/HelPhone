import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CSP_HEADER,
  CSP_NONCE_PLACEHOLDER,
  CSP_REPORT_ONLY_HEADER,
  DEFAULT_CONNECT_SRC,
  buildCspHeader,
  createCspMiddleware,
  createHtmlHandler,
  generateNonce,
  injectNonce,
  isValidSource,
  optionsFromEnv,
  parseSourceList,
} from "../server/middleware/csp.js";

const directive = (header, name) =>
  header
    .split("; ")
    .find((d) => d === name || d.startsWith(`${name} `))
    ?.split(" ")
    .slice(1);

describe("generateNonce", () => {
  it("is 128 bits of base64", () => {
    expect(Buffer.from(generateNonce(), "base64")).toHaveLength(16);
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 1000 }, generateNonce));
    expect(seen.size).toBe(1000);
  });
});

describe("buildCspHeader", () => {
  const nonce = "abc123==";
  const header = buildCspHeader(nonce);

  it("allows scripts and styles only with the nonce, never 'unsafe-inline'", () => {
    expect(directive(header, "script-src")).toContain(`'nonce-${nonce}'`);
    expect(directive(header, "style-src")).toContain(`'nonce-${nonce}'`);
    expect(directive(header, "script-src")).not.toContain("'unsafe-inline'");
    expect(directive(header, "style-src")).not.toContain("'unsafe-inline'");
    expect(directive(header, "script-src")).not.toContain("'unsafe-eval'");
  });

  it("confines the inline-style relaxation to attributes", () => {
    expect(directive(header, "style-src-attr")).toEqual(["'unsafe-inline'"]);
  });

  it("denies by default and locks down plugins, framing and base tags", () => {
    expect(directive(header, "default-src")).toEqual(["'none'"]);
    expect(directive(header, "object-src")).toEqual(["'none'"]);
    expect(directive(header, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(header, "base-uri")).toEqual(["'self'"]);
    expect(directive(header, "form-action")).toEqual(["'self'"]);
  });

  it("restricts connect-src to self plus the explicit allowlist", () => {
    const connect = directive(header, "connect-src");
    expect(connect).toEqual(["'self'", ...DEFAULT_CONNECT_SRC]);
    expect(connect).not.toContain("*");
  });

  it("appends extra origins without duplicating defaults", () => {
    const h = buildCspHeader(nonce, {
      connectSrc: ["https://api.example.com", "https://api.mapbox.com"],
    });
    const connect = directive(h, "connect-src");
    expect(connect).toContain("https://api.example.com");
    expect(connect.filter((s) => s === "https://api.mapbox.com")).toHaveLength(1);
  });

  it("adds upgrade-insecure-requests and report-uri only when asked", () => {
    expect(header).not.toContain("upgrade-insecure-requests");
    expect(header).not.toContain("report-uri");
    const h = buildCspHeader(nonce, { upgradeInsecure: true, reportUri: "/csp-report" });
    expect(directive(h, "upgrade-insecure-requests")).toEqual([]);
    expect(directive(h, "report-uri")).toEqual(["/csp-report"]);
  });

  it("drops a report-uri that could break out of the directive", () => {
    const h = buildCspHeader(nonce, { reportUri: "/x; script-src *" });
    expect(h).not.toContain("report-uri");
    expect(directive(h, "script-src")).not.toContain("*");
  });
});

describe("source validation", () => {
  it.each(["https://api.example.com", "wss://rt.example.com:8443", "https://*.supabase.co", "http://localhost:3001"])(
    "accepts %s",
    (v) => expect(isValidSource(v)).toBe(true)
  );

  it.each([
    "*",
    "https:",
    "'unsafe-inline'",
    "https://a.com; script-src *",
    "https://a.com,https://b.com",
    "https://a.com\r\nX-Injected: 1",
    "https://",
    "ftp://a.com",
    "https://a b.com",
  ])("rejects %j", (v) => expect(isValidSource(v)).toBe(false));

  it("parseSourceList keeps valid entries and reports the rest", () => {
    const bad = [];
    const out = parseSourceList(" https://a.com , ,*, https://b.com ", (e) => bad.push(e));
    expect(out).toEqual(["https://a.com", "https://b.com"]);
    expect(bad).toEqual(["*"]);
  });

  it("parseSourceList of nothing is empty", () => {
    expect(parseSourceList(undefined)).toEqual([]);
    expect(parseSourceList("")).toEqual([]);
  });
});

describe("optionsFromEnv", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads and validates the environment, warning on bad entries", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const opts = optionsFromEnv({
      CSP_CONNECT_SRC: "https://ok.example.com,*",
      CSP_REPORT_ONLY: "true",
      CSP_REPORT_URI: "/r",
      NODE_ENV: "production",
    });
    expect(opts).toEqual({
      connectSrc: ["https://ok.example.com"],
      reportOnly: true,
      reportUri: "/r",
      upgradeInsecure: true,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("defaults to enforcing, no upgrade outside production", () => {
    const opts = optionsFromEnv({});
    expect(opts.reportOnly).toBe(false);
    expect(opts.upgradeInsecure).toBe(false);
    expect(opts.reportUri).toBeUndefined();
  });
});

describe("injectNonce", () => {
  const nonce = "N0nce+/==";

  it("stamps script and style tags, including module and inline ones", () => {
    const html = `<style>a{}</style><script type="module" src="/a.js"></script><script>1</script>`;
    const out = injectNonce(html, nonce);
    expect(out).toBe(
      `<style nonce="${nonce}">a{}</style><script nonce="${nonce}" type="module" src="/a.js"></script><script nonce="${nonce}">1</script>`
    );
  });

  it("leaves tags that already carry a nonce alone", () => {
    const html = `<script nonce="keep" src="/a.js"></script>`;
    expect(injectNonce(html, nonce)).toBe(html);
  });

  it("swaps the Vite placeholder everywhere", () => {
    const html = `<script nonce="${CSP_NONCE_PLACEHOLDER}"></script><meta nonce="${CSP_NONCE_PLACEHOLDER}">`;
    expect(injectNonce(html, nonce)).toBe(`<script nonce="${nonce}"></script><meta nonce="${nonce}">`);
  });

  it("is idempotent", () => {
    const once = injectNonce("<script>1</script>", nonce);
    expect(injectNonce(once, nonce)).toBe(once);
  });

  it("does not touch other tags", () => {
    const html = `<link rel="stylesheet" href="/a.css"><div id="root"></div>`;
    expect(injectNonce(html, nonce)).toBe(html);
  });
});

describe("HTTP integration", () => {
  const dirs = [];
  const servers = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  function htmlFile(content) {
    const dir = mkdtempSync(join(tmpdir(), "csp-"));
    dirs.push(dir);
    const path = join(dir, "index.html");
    writeFileSync(path, content);
    return path;
  }

  async function start(build) {
    const app = express();
    build(app);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }

  const nonceIn = (header) => /'nonce-([^']+)'/.exec(header)[1];

  it("serves HTML whose nonce matches the header, uncacheable", async () => {
    const path = htmlFile(`<html><script type="module" src="/a.js"></script></html>`);
    const url = await start((app) => {
      app.use(createCspMiddleware({}));
      app.get("/", createHtmlHandler({ htmlPath: path }));
    });

    const res = await fetch(url);
    const body = await res.text();
    const nonce = nonceIn(res.headers.get(CSP_HEADER));

    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(body).toContain(`<script nonce="${nonce}" type="module"`);
  });

  it("uses a different nonce on every response", async () => {
    const path = htmlFile("<script>1</script>");
    const url = await start((app) => {
      app.use(createCspMiddleware({}));
      app.get("/", createHtmlHandler({ htmlPath: path }));
    });

    const nonces = await Promise.all(
      Array.from({ length: 5 }, async () => nonceIn((await fetch(url)).headers.get(CSP_HEADER)))
    );
    expect(new Set(nonces).size).toBe(5);
  });

  it("sends the report-only header instead when configured", async () => {
    const url = await start((app) => {
      app.use(createCspMiddleware({ reportOnly: true }));
      app.get("/", (_req, res) => res.send("ok"));
    });
    const res = await fetch(url);
    expect(res.headers.get(CSP_REPORT_ONLY_HEADER)).toContain("script-src");
    expect(res.headers.get(CSP_HEADER)).toBeNull();
  });

  it("puts the policy on API responses too", async () => {
    const url = await start((app) => {
      app.use(createCspMiddleware({}));
      app.get("/health", (_req, res) => res.json({ ok: true }));
    });
    expect((await fetch(`${url}/health`)).headers.get(CSP_HEADER)).toContain("default-src 'none'");
  });

  it("falls through when the frontend has not been built", async () => {
    const url = await start((app) => {
      app.use(createCspMiddleware({}));
      app.get("/", createHtmlHandler({ htmlPath: join(tmpdir(), "does-not-exist", "index.html") }));
    });
    expect((await fetch(url)).status).toBe(404);
  });

  it("refuses to render without the middleware rather than serve un-nonced scripts", async () => {
    const path = htmlFile("<script>1</script>");
    const url = await start((app) => {
      app.get("/", createHtmlHandler({ htmlPath: path }));
      app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    });
    const res = await fetch(url);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/cspMiddleware must run before/);
  });

  it("re-reads the file each request when caching is off", async () => {
    const path = htmlFile("<script>one</script>");
    const url = await start((app) => {
      app.use(createCspMiddleware({}));
      app.get("/", createHtmlHandler({ htmlPath: path, cache: false }));
    });
    expect(await (await fetch(url)).text()).toContain("one");
    writeFileSync(path, "<script>two</script>");
    expect(await (await fetch(url)).text()).toContain("two");
  });
});
