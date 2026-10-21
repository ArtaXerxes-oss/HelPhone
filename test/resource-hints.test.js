import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  normalizeHref,
  injectHint,
  injectDnsPrefetch,
  injectPreconnect,
  injectModulePreload,
  initResourceHints,
  DEFAULT_ORIGINS,
  registerRouteLoaders,
  resetRouteLoaders,
  shouldSkipPrefetch,
  prefetchRoute,
  attachIntentPrefetch,
} from "../src/lib/resourceHints.ts";

// #542 — Dynamic resource hint injector & intent-based module preloading.

const links = (rel) => Array.from(document.head.querySelectorAll(`link[rel="${rel}"]`));

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  resetRouteLoaders();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("normalizeHref", () => {
  it("reduces dns-prefetch/preconnect hrefs to their origin", () => {
    expect(normalizeHref("dns-prefetch", "https://api.mapbox.com/styles/v1?x=1")).toBe(
      "https://api.mapbox.com",
    );
    expect(normalizeHref("preconnect", "http://localhost:3000/a")).toBe("http://localhost:3000");
  });
  it("rejects non-http(s) and unparsable URLs", () => {
    expect(normalizeHref("preconnect", "javascript:alert(1)")).toBeNull();
    expect(normalizeHref("dns-prefetch", "data:text/plain,hi")).toBeNull();
    expect(normalizeHref("preconnect", "http://[bad")).toBeNull();
  });
  it("keeps modulepreload same-origin only", () => {
    expect(normalizeHref("modulepreload", "/assets/a.js?v=1", "http://localhost/")).toBe(
      "/assets/a.js?v=1",
    );
    expect(normalizeHref("modulepreload", "https://evil.example/a.js", "http://localhost/")).toBeNull();
  });
  it("falls back to a default base when location is unavailable", () => {
    vi.stubGlobal("location", undefined);
    expect(normalizeHref("modulepreload", "/a.js")).toBe("/a.js");
  });
});

describe("injectHint", () => {
  it("adds a link tag to head", () => {
    const el = injectDnsPrefetch("https://api.mapbox.com");
    expect(el.rel).toBe("dns-prefetch");
    expect(el.getAttribute("href")).toBe("https://api.mapbox.com");
    expect(links("dns-prefetch")).toHaveLength(1);
  });
  it("deduplicates identical hints and returns the existing element", () => {
    const a = injectPreconnect("https://fonts.gstatic.com", { crossOrigin: true });
    const b = injectPreconnect("https://fonts.gstatic.com/other/path");
    expect(b).toBe(a);
    expect(links("preconnect")).toHaveLength(1);
  });
  it("allows the same href under different rels", () => {
    injectDnsPrefetch("https://a.example");
    injectPreconnect("https://a.example");
    expect(document.head.querySelectorAll("link")).toHaveLength(2);
  });
  it("sets crossorigin only when requested (always for modulepreload)", () => {
    expect(injectPreconnect("https://a.example").hasAttribute("crossorigin")).toBe(false);
    expect(injectPreconnect("https://b.example", { crossOrigin: true }).hasAttribute("crossorigin")).toBe(true);
    expect(injectModulePreload("/assets/x.js").hasAttribute("crossorigin")).toBe(true);
  });
  it("returns null for rejected hrefs and adds nothing", () => {
    expect(injectHint("modulepreload", "https://evil.example/x.js")).toBeNull();
    expect(injectHint("preconnect", "ftp://x")).toBeNull();
    expect(document.head.children).toHaveLength(0);
  });
  it("honors a custom document", () => {
    const other = document.implementation.createHTMLDocument("x");
    injectDnsPrefetch("https://a.example", { doc: other });
    expect(other.head.querySelectorAll("link")).toHaveLength(1);
    expect(document.head.children).toHaveLength(0);
  });
});

describe("initResourceHints", () => {
  it("injects dns-prefetch for every default origin and preconnect where flagged", () => {
    const added = initResourceHints();
    const preconnects = DEFAULT_ORIGINS.filter((o) => o.preconnect).length;
    expect(links("dns-prefetch")).toHaveLength(DEFAULT_ORIGINS.length);
    expect(links("preconnect")).toHaveLength(preconnects);
    expect(added).toHaveLength(DEFAULT_ORIGINS.length + preconnects);
  });
  it("is idempotent", () => {
    initResourceHints();
    initResourceHints();
    expect(links("dns-prefetch")).toHaveLength(DEFAULT_ORIGINS.length);
  });
});

describe("shouldSkipPrefetch", () => {
  it("skips on save-data and 2g connections only", () => {
    expect(shouldSkipPrefetch({ connection: { saveData: true } })).toBe(true);
    expect(shouldSkipPrefetch({ connection: { effectiveType: "2g" } })).toBe(true);
    expect(shouldSkipPrefetch({ connection: { effectiveType: "slow-2g" } })).toBe(true);
    expect(shouldSkipPrefetch({ connection: { effectiveType: "4g" } })).toBe(false);
    expect(shouldSkipPrefetch({})).toBe(false);
    expect(shouldSkipPrefetch(undefined)).toBe(false);
  });
});

describe("prefetchRoute", () => {
  it("returns null for unknown routes", () => {
    expect(prefetchRoute("/nope")).toBeNull();
  });
  it("loads a route once and memoizes the promise", async () => {
    const loader = vi.fn().mockResolvedValue({});
    registerRouteLoaders({ "/help": loader });
    const a = prefetchRoute("/help");
    const b = prefetchRoute("/help");
    await a;
    expect(b).toBe(a);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it("allows a retry after a failed load", async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValue({});
    registerRouteLoaders({ "/help": loader });
    await expect(prefetchRoute("/help")).rejects.toThrow("net");
    await prefetchRoute("/help");
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it("does nothing on data-saver connections", () => {
    const loader = vi.fn();
    registerRouteLoaders({ "/help": loader });
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    expect(prefetchRoute("/help")).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("attachIntentPrefetch", () => {
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  let loader;
  beforeEach(() => {
    loader = vi.fn().mockResolvedValue({});
    registerRouteLoaders({ "/help": loader });
    document.body.innerHTML = `
      <a id="help" href="/help"><span id="inner">Help</span></a>
      <a id="ext" href="https://other.example/help">ext</a>
      <a id="blank" href="/help" target="_blank">blank</a>
      <a id="dl" href="/help" download>dl</a>
      <a id="bad" href="http://[bad">bad</a>
      <a id="unknown" href="/unknown">unknown</a>
      <p id="text">no link</p>`;
  });

  it("prefetches after a hover dwell, including from nested children", () => {
    vi.useFakeTimers();
    const off = attachIntentPrefetch({ delayMs: 50 });
    fire(document.getElementById("inner"), "mouseover");
    vi.advanceTimersByTime(49);
    expect(loader).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(loader).toHaveBeenCalledTimes(1);
    off();
  });

  it("cancels the prefetch when the pointer leaves before the dwell", () => {
    vi.useFakeTimers();
    const off = attachIntentPrefetch({ delayMs: 50 });
    fire(document.getElementById("help"), "mouseover");
    fire(document.getElementById("help"), "mouseout");
    vi.advanceTimersByTime(200);
    expect(loader).not.toHaveBeenCalled();
    off();
  });

  it("prefetches immediately on focus and touch", () => {
    const off = attachIntentPrefetch();
    fire(document.getElementById("help"), "focusin");
    fire(document.getElementById("help"), "touchstart");
    expect(loader).toHaveBeenCalledTimes(1); // memoized across signals
    off();
  });

  it("ignores external, _blank, download, invalid, unknown and non-link targets", () => {
    const off = attachIntentPrefetch();
    for (const id of ["ext", "blank", "dl", "bad", "unknown", "text"])
      fire(document.getElementById(id), "focusin");
    expect(loader).not.toHaveBeenCalled();
    off();
  });

  it("swallows loader failures instead of throwing", async () => {
    loader.mockRejectedValue(new Error("offline"));
    const off = attachIntentPrefetch();
    fire(document.getElementById("help"), "focusin");
    await Promise.resolve();
    off();
  });

  it("stops listening after dispose", () => {
    const off = attachIntentPrefetch();
    off();
    fire(document.getElementById("help"), "focusin");
    expect(loader).not.toHaveBeenCalled();
  });
});
