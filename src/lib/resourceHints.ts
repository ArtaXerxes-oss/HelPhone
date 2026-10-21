/**
 * Dynamic resource hint injector & intent-based module preloading (#542).
 *
 * - `injectHint` adds deduplicated `<link rel="dns-prefetch|preconnect|modulepreload">`
 *   tags to <head> at runtime.
 * - `attachIntentPrefetch` warms a route's code-split chunk when the user shows
 *   intent to navigate (hover / focus / touch on an anchor), so the click lands
 *   on an already-downloaded module.
 */

export type HintRel = "dns-prefetch" | "preconnect" | "modulepreload";

export interface HintOptions {
  /** Emit `crossorigin` (required for preconnect to CORS resources such as fonts). */
  crossOrigin?: boolean;
  /** Document to inject into (defaults to the global one). */
  doc?: Document;
}

/** Third-party origins the app talks to on most sessions. */
export const DEFAULT_ORIGINS: ReadonlyArray<{
  origin: string;
  preconnect: boolean;
  crossOrigin?: boolean;
}> = [
  { origin: "https://fonts.gstatic.com", preconnect: true, crossOrigin: true },
  { origin: "https://api.mapbox.com", preconnect: false },
  { origin: "https://soroban-testnet.stellar.org", preconnect: false },
];

export type RouteLoader = () => Promise<unknown>;

const routeLoaders = new Map<string, RouteLoader>();
const warmed = new Map<string, Promise<unknown>>();

/** Returns a normalized origin/URL string, or null when the URL is not allowed for `rel`. */
export function normalizeHref(
  rel: HintRel,
  href: string,
  base: string = typeof location !== "undefined" ? location.href : "http://localhost/",
): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (rel === "modulepreload") {
    // Module preloads must stay same-origin: never fetch remote code eagerly.
    return url.origin === new URL(base).origin ? url.pathname + url.search : null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin;
}

/** Injects a hint; returns the (possibly pre-existing) element, or null if rejected. */
export function injectHint(
  rel: HintRel,
  href: string,
  { crossOrigin = false, doc = document }: HintOptions = {},
): HTMLLinkElement | null {
  const value = normalizeHref(rel, href, doc.baseURI);
  if (!value) return null;
  const existing = Array.from(
    doc.head.querySelectorAll<HTMLLinkElement>(`link[rel="${rel}"]`),
  ).find((l) => l.getAttribute("href") === value);
  if (existing) return existing;
  const link = doc.createElement("link");
  link.rel = rel;
  link.href = value;
  if (crossOrigin || rel === "modulepreload") link.crossOrigin = "";
  doc.head.appendChild(link);
  return link;
}

export const injectDnsPrefetch = (origin: string, opts?: HintOptions) =>
  injectHint("dns-prefetch", origin, opts);
export const injectPreconnect = (origin: string, opts?: HintOptions) =>
  injectHint("preconnect", origin, opts);
export const injectModulePreload = (href: string, opts?: HintOptions) =>
  injectHint("modulepreload", href, opts);

/** Adds dns-prefetch for every default origin (and preconnect where flagged). */
export function initResourceHints(doc: Document = document): HTMLLinkElement[] {
  const added: HTMLLinkElement[] = [];
  for (const { origin, preconnect, crossOrigin } of DEFAULT_ORIGINS) {
    const dns = injectDnsPrefetch(origin, { doc });
    if (dns) added.push(dns);
    if (preconnect) {
      const pc = injectPreconnect(origin, { doc, crossOrigin });
      if (pc) added.push(pc);
    }
  }
  return added;
}

export function registerRouteLoaders(loaders: Record<string, RouteLoader>): void {
  for (const [path, loader] of Object.entries(loaders)) routeLoaders.set(path, loader);
}

export function resetRouteLoaders(): void {
  routeLoaders.clear();
  warmed.clear();
}

/** True when the connection should not spend bytes on speculative fetches. */
export function shouldSkipPrefetch(
  nav: { connection?: { saveData?: boolean; effectiveType?: string } } | undefined =
    typeof navigator !== "undefined" ? (navigator as never) : undefined,
): boolean {
  const c = nav?.connection;
  return Boolean(c?.saveData || (c?.effectiveType && /(^|-)2g$/.test(c.effectiveType)));
}

/** Loads a route's chunk once; later calls reuse the same promise. */
export function prefetchRoute(path: string): Promise<unknown> | null {
  const loader = routeLoaders.get(path);
  if (!loader || shouldSkipPrefetch()) return null;
  let p = warmed.get(path);
  if (!p) {
    p = loader().catch((err) => {
      warmed.delete(path); // allow a retry on the next intent signal
      throw err;
    });
    warmed.set(path, p);
  }
  return p;
}

export interface IntentOptions {
  root?: Document | HTMLElement;
  /** Hover dwell before prefetching, filters out cursor fly-bys. */
  delayMs?: number;
}

function anchorPath(target: EventTarget | null, origin: string): string | null {
  const a = (target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a || a.target === "_blank" || a.hasAttribute("download")) return null;
  let url: URL;
  try {
    url = new URL(a.getAttribute("href") as string, origin + "/");
  } catch {
    return null;
  }
  return url.origin === origin ? url.pathname : null;
}

/**
 * Delegated intent listeners: mouseover (after `delayMs` dwell), focusin and
 * touchstart trigger `prefetchRoute` for the anchor's path. Returns a disposer.
 */
export function attachIntentPrefetch({
  root = document,
  delayMs = 65,
}: IntentOptions = {}): () => void {
  const origin = location.origin;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const warm = (target: EventTarget | null) => {
    const path = anchorPath(target, origin);
    if (path) prefetchRoute(path)?.catch(() => {});
  };
  const onOver = (e: Event) => {
    clearTimeout(timer);
    timer = setTimeout(() => warm(e.target), delayMs);
  };
  const onOut = () => clearTimeout(timer);
  const onImmediate = (e: Event) => warm(e.target);

  root.addEventListener("mouseover", onOver);
  root.addEventListener("mouseout", onOut);
  root.addEventListener("focusin", onImmediate);
  root.addEventListener("touchstart", onImmediate, { passive: true });
  return () => {
    clearTimeout(timer);
    root.removeEventListener("mouseover", onOver);
    root.removeEventListener("mouseout", onOut);
    root.removeEventListener("focusin", onImmediate);
    root.removeEventListener("touchstart", onImmediate);
  };
}
