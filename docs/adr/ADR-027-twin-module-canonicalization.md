# ADR-027 — One canonical module per name (`.js`/`.ts` twins)

**Date:** 2026-11-23
**Status:** Accepted
**ISP / Spike:** #901
**Decision owner:** @helphone-maintainers
**Review required:** @helphone-maintainers (see `.github/CODEOWNERS`)

---

## Context

Eleven modules existed twice, as `.js`/`.jsx` and `.ts`/`.tsx`. That is not
only duplication. The two tools in the build read different files:

- **Vite** resolves an extensionless import with its default order
  (`.mjs`, `.js`, `.mts`, `.ts`, `.jsx`, `.tsx`). So the `.js`/`.jsx` twin
  is what runs.
- **TypeScript** (`moduleResolution: bundler`) resolves the `.ts` twin, so
  that is what gets type-checked.

Where the twins had drifted apart, the code that ran was not the code that
was checked. This broke the kiosk page in three ways:

- **`useGeofencing`:** the `.js` file was a one-line stub with no export.
- **`useFocusTrap`:** the `.ts` file was empty, and `Kiosk.tsx` called the
  `.js` hook with its arguments the wrong way round.
- **`useEscapeKey` and `useNetworkQuality`:** `Kiosk.tsx` used the `.ts`
  APIs, but received the `.js` modules.

## Options considered

### Option A — Always keep the TypeScript twin

Simple to state, but it would delete the live implementation in several cases:

- `Help.jsx` is the 5 300-line page every route and test uses. `Help.tsx` is
  a 500-line prototype that never ran.
- The server runs `server/index.js` with plain Node, which imports
  `./base64Utils.js` and `./routes/health.js` by explicit extension.

### Option B — Decide per pair, on evidence (chosen)

For each pair, the evidence was: which file actually runs, who imports it,
and which is the superset. The kept file absorbs anything only the other
had. Callers move to the kept API, and the other twin is deleted.

## Decision

| Module | Canonical | Removed | Why |
|---|---|---|---|
| `src/pages/Help` | `Help.jsx` | `Help.tsx` | `Help.jsx` is the live page (loaded by `main.tsx`, imported by every Help test). `Help.tsx` was an unreachable encrypted-payload prototype; it stays in history. |
| `src/components/MapboxWrapper` | `MapboxWrapper.tsx` | `MapboxWrapper.jsx` | Typed. Merged the `.jsx` ref forwarding and #961 map leak-guard registration into it, kept the `.tsx` `onIsolationChange` and road-network preload, and fixed its typing (pass-through props are react-map-gl `MapProps`). |
| `src/hooks/useEscapeKey` | `useEscapeKey.ts` | `useEscapeKey.js` | One options API: `useEscapeKey(onEscape, { enabled, kioskMode, restoreFocus })`. The `.js` positional API is `{ enabled: active, restoreFocus: true }`; `SosSheet` migrated. |
| `src/hooks/useFocusTrap` | `useFocusTrap.ts` | `useFocusTrap.js` | The `.ts` was empty. The `.js` implementation moved into it, typed. `Kiosk` now calls `useFocusTrap(active, ref)` like every other caller. |
| `src/hooks/useGeofencing` | `useGeofencing.ts` | `useGeofencing.js` | The `.js` was a stub with no export, so `Kiosk` failed to load. |
| `src/hooks/useNetworkQuality` | `useNetworkQuality.js` | `useNetworkQuality.ts` → renamed `useKioskActivity.ts` | Two unrelated hooks shared one name: RPC health (#539, `.js`, used by `NetworkStatusIndicator` and tests) and the kiosk idle/auto-lock tracker (`.ts`, used by `Kiosk`). Both are needed, so the kiosk hook took its own name. |
| `src/lib/useDocumentTitle` | `useDocumentTitle.ts` | `useDocumentTitle.js` | Identical apart from types. |
| `src/lib/wasmMemory` | `wasmMemory.ts` | `wasmMemory.js` | Same API; the `.ts` is the typed, documented version. Explicit `./wasmMemory.js` imports now name the module without an extension. |
| `src/lib/zk` | `zk.ts` | `zk.js` | Superset: browser-proving feasibility limits, plus the integrity-checked sharded circuit loading that `npm run zk:shard` (pre-dev / pre-build) produces. `zk.js` loaded the raw circuit JSON. |
| `server/base64Utils` | `base64Utils.js` | `base64Utils.ts` | Node runs it directly (`server/index.js`, and `../base64Utils.js` from `routes/zk.ts`). The `.ts` robustness fixes (non-`Error` throws, empty-capture and missing-part guards) were merged into the `.js`. |
| `server/routes/health` | `health.js` | `health.ts` | `server/index.js` is its only caller and uses the `{ readiness }` option form; the `.ts` (positional) was unused. |

**Guard against regressions:** `eslint.config.js` has a `no-restricted-imports`
rule that names each removed twin. An import of one by explicit extension
fails lint, with a message pointing to the canonical module.

## Consequences

- The kiosk page loads, and gets the geofencing, focus-trap, escape and idle
  hooks it was written for.
- Type-checking now covers the modules that run for every pair above.
- Other twins in the tree (for example `server/index`, `server/db/*` and
  `src/lib/imageProcessor`) were not part of #901. They should follow the same
  rule in later batches: add each to this ADR and to the lint rule.
