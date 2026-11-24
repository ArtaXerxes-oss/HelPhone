// plugins/vite-plugin-worker-sandbox.js
//
// Browser sandbox isolation for untrusted Web Worker scripts (see
// src/lib/workerSandbox.ts and docs/security-architecture.md).
//
// - transform (enforce: 'post', i.e. after vite:worker-import-meta-url has
//   rewritten `new URL('../workers/x.js', import.meta.url)` into a worker
//   chunk URL): swaps `new Worker(` for `createSandboxedWorker(` and injects
//   the launcher import, so every worker starts from a blob URL created inside
//   a sandboxed (null-origin) iframe.
// - configureServer / configurePreviewServer: a worker running in an opaque
//   origin fetches its module graph with `Origin: null`; without
//   `Access-Control-Allow-Origin` the sandbox logs the failure and degrades to
//   a same-origin blob worker. Scoped to non-API GETs so the API is unaffected.

import path from "node:path";
import { rewriteWorkerConstructors } from "../src/lib/workerSandbox.ts";

/** App source that owns worker launch sites (never the workers themselves). */
function isAppModule(file) {
  if (file.includes("node_modules")) return false;
  return /\.(js|jsx|ts|tsx)$/.test(file);
}

export function workerSandboxVitePlugin() {
  let root = process.cwd();

  const allowOpaqueOrigin = (req, res, next) => {
    const url = req.url || "";
    if (req.headers.origin === "null" && req.method === "GET" && !url.startsWith("/api")) {
      res.setHeader("Access-Control-Allow-Origin", "null");
      res.setHeader("Vary", "Origin");
    }
    next();
  };

  return {
    name: "helphone:worker-sandbox",
    enforce: "post",

    configResolved(config) {
      root = config.root;
    },

    transform(code, id) {
      // Vitest supplies its own Worker doubles at the launch sites; never
      // rewrite modules while the test suite is running.
      if (process.env.VITEST) return null;
      const file = String(id).split("?")[0];
      if (!isAppModule(file)) return null;
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (!rel.startsWith("src/") || rel.startsWith("src/workers/")) return null;
      const rewritten = rewriteWorkerConstructors(code, file);
      return rewritten ? { code: rewritten, map: null } : null;
    },

    configureServer(server) {
      server.middlewares.use(allowOpaqueOrigin);
    },

    configurePreviewServer(server) {
      server.middlewares.use(allowOpaqueOrigin);
    },
  };
}
