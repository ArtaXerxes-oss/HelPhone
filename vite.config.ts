/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { visualizer } from "rollup-plugin-visualizer";
import { envFirewallVitePlugin } from "./scripts/security/env_firewall.js";
import deadcodePruner from "./plugins/vite-plugin-deadcode-pruner.js";
import { workerSandboxVitePlugin } from "./plugins/vite-plugin-worker-sandbox.js";

export default defineConfig(({ mode }) => ({
  html: {
    // #530: built tags carry this placeholder; server/middleware/csp.ts swaps
    // in a fresh nonce on every response.
    cspNonce: "__CSP_NONCE__",
  },
  css: {
    modules: {
      generateScopedName: mode === "production"
        ? "[name]__[local]___[hash:base64:5]"
        : "[name]__[local]",
    },
  },
  plugins: [
    react(),
    // #626: fails the build if static output contains leaked secrets.
    envFirewallVitePlugin(),
    deadcodePruner(),
    // #worker-sandbox: launch every Web Worker from a sandboxed (null-origin)
    // blob URL; runs after vite:worker-import-meta-url (enforce: 'post').
    workerSandboxVitePlugin(),
    visualizer({
      open: false,
      filename: 'dist/stats.html',
      template: 'sunburst',
    }),
    VitePWA({
      registerType: "autoUpdate",
      strategies: "injectManifest",
      srcDir: "src",
      filename: "service-worker.js",
      injectManifest: {
        // Raise limit to 10MB to accommodate Barretenberg WASM/JS bundles
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      },
      manifest: {
        name: "HelPhone - Emergency Response Network",
        short_name: "HelPhone",
        description:
          "Decentralized emergency response network powered by Stellar blockchain",
        theme_color: "#234B4E",
        background_color: "#ECE0CC",
        display: "standalone",
        // Broad scope intentionally kept for the main PWA install.
        // The kiosk PWA is a separate install from /kiosk?shelter=… with its
        // own start_url, scope "/kiosk", and display "standalone" enforced by
        // the device MDM / Guided Access / Lock Task profile — see field guide.
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/assets/helphone-icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/assets/helphone-icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
        screenshots: [
          {
            src: "/assets/screenshot-1.png",
            sizes: "540x720",
            type: "image/png",
            form_factor: "narrow",
          },
          {
            src: "/assets/screenshot-2.png",
            sizes: "1280x720",
            type: "image/png",
            form_factor: "wide",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,wav,mp4,wasm,json}"],
        globIgnores: ["**/node_modules/**/*", "dist/stats.html", "**/security-surface-report.json"],
        // Raise limit to 10MB to accommodate Barretenberg WASM/JS bundles
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/data\/road-network\.(json|bin)$/,
            handler: "CacheFirst",
            options: { cacheName: "road-network-v1" },
          },
          {
            urlPattern: /^https:\/\/api\.mapbox\.com\/.*/i,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "mapbox-api-v1",
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 7,
              },
              cacheableResponse: {
                statuses: [200],
              },
            },
          },
          {
            urlPattern: /^https:\/\/(?:api|tiles|[a-d]\.tiles)\.mapbox\.com\/v4\/.*/i,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "tiles-v1",
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 60 * 60 * 24 * 7,
              },
              cacheableResponse: {
                statuses: [200],
              },
            },
          },
          {
            urlPattern: /.*\.(wasm|json)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "wasm-json-cache",
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
            },
          },
        ],
      },
    }),
  ],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.js"],
    include: ["test/**/*.test.js", "test/**/*.test.jsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.{js,jsx}"],
      exclude: [
        "node_modules/",
        "test/",
        "tests/",
        "dist/",
        "**/*.config.js",
        "**/*.config.mjs",
        "**/setup.js",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
  build: {
    // Emit `dist/.vite/manifest.json` (entry chunk + hashed static imports) so
    // server/middleware/http2Push.ts can build `Link: …; rel=preload` headers
    // from the assets this release actually shipped.
    manifest: true,
    chunkSizeWarningLimit: 500,
    // #542 FCP: keep heavy, route-specific chunks (Mapbox GL, ZK/WASM prover)
    // out of the entry HTML's modulepreload list; they are fetched on intent
    // (see src/lib/resourceHints.ts) or on navigation instead.
    modulePreload: {
      resolveDependencies: (_file, deps, { hostType }) =>
        hostType === "html"
          ? deps.filter((d) => !/(^|\/)(mapbox|zk)-[^/]*\.js$/.test(d))
          : deps,
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;

          // WASM binaries - isolate for lazy loading
          if (id.includes(".wasm") || id.includes("barretenberg") || id.includes("acvm"))
            return "zk-wasm";

          // ZK/Noir libraries - heavy, lazy-loaded
          if (id.includes("@noir-lang") || id.includes("@aztec/bb.js"))
            return "zk";

          // Mapbox GL - heavy map rendering
          if (id.includes("mapbox-gl") || id.includes("react-map-gl"))
            return "mapbox";

          // #795: Yjs and OpenTelemetry were competing inside one vendor blob;
          // split so the perf-budget harness can cap and blame them separately.
          if (/[\\/]node_modules[\\/](yjs|y-[\w-]+|lib0)[\\/]/.test(id)) return "yjs";
          if (id.includes("@opentelemetry")) return "otel";

          // Stellar SDK - blockchain interactions
          if (
            id.includes("@stellar/stellar-sdk") ||
            id.includes("stellar-wallets-kit") ||
            id.includes("soroban-client")
          )
            return "stellar";

          // React core - critical path
          if (
            id.includes("react-dom") ||
            id.includes("react-router") ||
            id.includes("scheduler")
          )
            return "react-core";

          // i18n - can be deferred
          if (id.includes("react-i18next") || id.includes("i18next"))
            return "i18n";

          // Supabase - backend client
          if (id.includes("@supabase"))
            return "supabase";

          // Buffer polyfill
          if (id.includes("buffer"))
            return "buffer";

          // Everything else
          return "vendor";
        },
      },
    },
  },
  server: {
    port: 3000,
    open: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    hmr: {
      // #742: Explicit HMR config prevents stale-cache issues with service worker
      protocol: "ws",
      host: "localhost",
      port: 3000,
      timeout: 5000,
    },
    proxy: {
      "/zk": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  optimizeDeps: {
    exclude: [
      "@noir-lang/noir_js",
      "@noir-lang/backend_barretenberg",
      "@noir-lang/acvm_js",
      "@noir-lang/noirc_abi",
      "@aztec/bb.js",
    ],
    include: ["buffer", "fuse.js"],
  },
  worker: {
    format: "es",
  },
  define: {
    "import.meta.env.VITE_WASM_MAX_MEMORY_MB": JSON.stringify(512),
  },
}));
