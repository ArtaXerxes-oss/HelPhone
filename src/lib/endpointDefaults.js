/**
 * Client endpoint defaults without a loopback address in production (#927).
 *
 * A configured VITE_* value always wins. With nothing configured, development
 * keeps the local server default, while a production bundle resolves against
 * the page's own origin (the deployed host) instead of shipping localhost.
 * An empty origin yields a path-only URL, which the browser resolves itself.
 */

export const DEV_SERVER_BASE = "http://localhost:3001";

/**
 * @param {unknown} configured  the VITE_* value, if any
 * @param {string} path        path appended to the resolved base, e.g. "/events/stream"
 * @param {{ isProd?: boolean, origin?: string }} [env]
 * @returns {string}
 */
export function resolveEndpoint(configured, path = "", { isProd = false, origin = "" } = {}) {
  const value = typeof configured === "string" ? configured.trim() : "";
  if (value) return value;
  const base = isProd ? String(origin || "") : DEV_SERVER_BASE;
  return `${base.replace(/\/$/, "")}${path}`;
}

/** Page origin when running in a browser, otherwise "". */
export function currentOrigin() {
  try {
    return typeof globalThis.location !== "undefined" && globalThis.location?.origin ? globalThis.location.origin : "";
  } catch {
    return "";
  }
}
