# HelPhone

HelPhone is a React + Vite community emergency response application built on Stellar. It combines wallet-gated help requests, Soroban smart contracts, local ZK privacy proofs, WebAuthn Passkeys, and automated contract storage state backups.

## The 3-minute story

Someone is in trouble and needs help from nearby people — but broadcasting "I'm hurt, here is my exact address and my name" to a public blockchain is dangerous. HelPhone fixes that:

1. **Emergency.** A person taps _Get help_ and picks what happened (lost, fallen, medical, danger…).
2. **Identity protected.** Their name and contact never leave the browser. Only a pseudonymous `Private request #N` is written on-chain.
3. **Location proven, not revealed.** The exact GPS coordinate is used as a _private witness_. A Noir ZK proof is generated **locally** to prove "I am inside this zone" without disclosing where. Only a coarse ~1 km point and a 3 km proof box go on-chain.
4. **Stellar verifies.** The proof fingerprint (nullifier) and transaction hash are recorded on Soroban testnet, visible in the live `ZK PRIVACY CHECKPOINT` panel.
5. **Double-claim blocked.** The nullifier is `Poseidon2(secret_id, campaign_id)` — one claim per user per campaign, so the same proof can't be replayed.

Privacy here is real, not theater: see [`anonymizeLocation`](src/pages/Help.jsx) (coarsens coordinates) and `createRequest(..., '', '', ...)` in [`handleSubmit`](src/pages/Help.jsx) (empty name/contact on-chain).

---

## Technical Subsystems & Architecture

### 1. Soroban Storage Inspection & State Snapshot Dumps
- **CLI Exporter**: `scripts/export-contract-state.sh` extracts complete contract storage dumps using `stellar contract inspect` or JSON-RPC queries.
- **Node.js/TypeScript Exporter**: `server/indexer/exporter.ts` indexes storage entries into versioned JSON snapshots (`./snapshots/snapshot-<ledgerSeq>.json`).
- **Automated Backup Cron**: `server/index.ts` automatically runs daily state export tasks to back up contract storage.
- **Disaster Recovery Runbook**: See [`docs/disaster-recovery.md`](docs/disaster-recovery.md) for state restoration procedures.

### 2. Automated Pre-Commit Code Quality Pipeline
- **Husky & lint-staged**: Intercepts `git commit` via `.husky/pre-commit` to automatically run linters and type-checkers on staged files.
- **Quality Verification**:
  - `npm run lint` (`eslint .`) - Code style & quality checks.
  - `npm run typecheck` (`tsc --noEmit`) - Strict TypeScript validation without building output.
  - `npm test` - Vitest test suite execution.
- **GitHub Actions CI**: `.github/workflows/ci.yml` enforces quality, linting, type-checking, state export verification, crypto matrix tests, and the multi-resolution layout matrix on pull requests.

### 3. Dynamic Feature Canary Rollouts & State Evaluation
- **Feature Flag Engine**: `src/lib/featureFlags.ts` evaluates feature flag toggles dynamically.
- **Remote Config**: Fetches rulesets from `/config.json` without requiring application rebuilds.
- **Percentage Hashing**: Deterministically hashes user IDs / device IDs for 0-100% canary rollouts.
- **React Hook Integration**: Components use `useFeatureFlag('flag_name')` for conditional rendering.

### 4. Cross-Layer Signature Verification Testing Suite
- **Cryptographic Suite**: `src/lib/crypto.ts` provides Ed25519 signature verification, WebAuthn P-256 (ECDSA SHA-256) parsing, and AES-256-GCM encryption/decryption.
- **Passkey Manager**: `src/lib/passkey.ts` handles browser WebAuthn credential registration and authentication.
- **Auth Middleware**: `server/middleware/auth.ts` enforces anti-replay timestamp freshness and cryptographic header verification.
- **Test Matrix**: `test/crypto-verification.test.js` covers positive & negative boundary tests (tampered payload, invalid key, expired signature).

### 5. Performance, Storage Security & Network Resilience
- **HTTP Keep-Alive**: `server/middleware/keepAlive.ts` holds sockets open for 65 s (above the balancer's 60 s idle timeout) so sequential API and WebSocket traffic reuses one TCP connection. See [`docs/performance-optimization.md`](docs/performance-optimization.md).
- **HTTP/2 Push / Preload Manifest**: `server/middleware/http2Push.ts` reads Vite's `dist/.vite/manifest.json` at startup, walks the entry chunk graph and stamps `Link: </assets/index-Abc123.js>; rel=preload; as=script; type=module; crossorigin` on HTML responses (plus 103 Early Hints and, on HTTP/2, `pushStream`). The manifest is re-read when a release changes the asset hashes, so the header always matches what was deployed. See [`docs/performance-optimization.md`](docs/performance-optimization.md).
- **Map Overlay Rendering**: `src/lib/offscreenCanvas.ts` + `src/workers/canvas-worker.js` animate map markers in a Web Worker via OffscreenCanvas, with a main-thread fallback and measured FPS. See [`docs/performance-optimization.md`](docs/performance-optimization.md).
- **Client Storage Encryption**: `src/lib/pbkdf2Key.ts` + `src/lib/secureStorage.ts` derive an AES-256-GCM key via PBKDF2 (100k iterations, per-device salt in IndexedDB) to encrypt local data. See [`docs/security-architecture.md`](docs/security-architecture.md).
- **Network Resilience Testing**: `tests/e2e/throttling.spec.ts` emulates 2G, 3G, a 500 kbps cap, and offline via CDP, with a CI matrix leg per profile. See [`docs/network-resilience.md`](docs/network-resilience.md).

### 6. Supply Chain Security & License Auditor (#540)
- **Auditor**: `scripts/audit-deps.js` audits `package-lock.json` and `server/package-lock.json` (zero dependencies, offline) and fails CI on unauthorized copyleft licenses (GPL/AGPL/SSPL/EUPL/OSL/CPAL/RPL not in `scripts/security/license_policy.js` `EXCEPTIONS`), unlisted or suspicious install scripts, and hijack indicators (untrusted registry host, `http://`/git sources, missing or non-sha512 integrity).
- **Report**: a deterministic `licenses.json`; `npm run security:audit-deps` regenerates it and `npm run security:audit-deps:check` (CI) fails when it is stale.
- **Runbook**: [docs/security-runbook.md](docs/security-runbook.md).
- **Tests**: `test/dep-audit.test.js`.

### 7. Build Pipeline Egress Monitoring & Data Exfiltration Prevention
- **Monitor**: `scripts/monitor-build-egress.sh` wraps a build command (`npm run build` by default) with a packet capture (`tcpdump`, or `iptables` LOG/REJECT when running as root) and classifies every observed destination — tcpdump `src > dst` lines, iptables `DST=` log lines, and DNS query names.
- **Unauthorized Connection Gate**: loopback/RFC1918/CGNAT plus a curated registry allowlist (npm, GitHub, PyPI, crates.io, Node.js) are permitted; anything else — including cloud metadata endpoints (`169.254.169.254`) — fails the build with exit code 1. `--enforce` additionally REJECTs the connection through an `iptables` `OUTPUT` chain while the build runs.
- **Egress Audit Logs**: `egress-capture.log` (raw packets), `egress-audit.log` (per-destination verdicts) and `egress-summary.log` are written to `artifacts/build-egress/` and uploaded as CI artifacts for security review.
- **CI Gate**: the `build-egress-monitor` job in `.github/workflows/ci.yml` runs installation and the production build inside the monitor in `--strict` mode (fails when capture is unavailable or unauthorized egress is seen).
- **Runbook**: [docs/security-runbook.md](docs/security-runbook.md).
- **Tests**: `test/egress-detector.test.js`.

### 8. Automated Dependency Version Drift & Breaking API Change Analyzer
- **Analyzer**: `scripts/detect-api-drift.js` extracts the exported type surface of every protected package — functions, interfaces, class members, call signatures and `export =` modules — from its `.d.ts` entry point with the TypeScript Compiler API, then diffs the installed surface against the reviewed baseline committed in `package.json` → `apiDrift.baseline`. Signatures are normalized (whitespace, `import("…")` specifiers rewritten to their `node_modules/` form) so the same package produces byte-identical baselines on CI runners and developer machines.
- **Version Pinning Guard**: dropped or re-typed signatures are *breaking*, new exports are *additive*. A breaking diff inside a semver-compatible (same/minor/patch) upgrade fails with exit 1 and names the version to pin; a breaking diff in a major upgrade is reported as a warning and needs a re-baseline. When a package does not bundle its own declarations the drift is classified with the `@types/<pkg>` version, so an `@types` minor bump that breaks call sites is caught too.
- **Exact Pin Opt-In**: `npm run security:api-drift:pin` (`--require-exact-pin`) additionally fails protected dependencies declared as `^` / `~` / `>=` instead of an exact `1.2.3`.
- **Rust half**: `Cargo.toml` → `[workspace.metadata.api-drift]` (`require-exact-pin`, `protected-crates`) is validated against `[workspace.dependencies]`, `[dependencies]` and `[dev-dependencies]`, where only `=1.2.3` counts as pinned (a bare `1.2.3` means `^1.2.3`).
- **Baselines**: `npm run security:api-drift:update` re-extracts and merges into `package.json` (root: cors, express, express-rate-limit, fuse.js, graphql, pg, react-dom; `server/package.json`: @stellar/stellar-sdk, @aztec/bb.js, @noir-lang/noir_js). Extraction options live in `tsconfig.json` → `apiDrift.compilerOptions`, deliberately outside `compilerOptions` so `tsc --noEmit` ignores them.
- **CI Gate**: the `api-drift-guard` job in `.github/workflows/ci.yml` installs with `npm ci --ignore-scripts`, runs `npm run security:api-drift` and `security:api-drift:server`, and uploads the drift report when it fails.
- **Tests**: `test/api-drift.test.js`.

---

### 9. Multi-Resolution Visual Layout Matrix
- **Spec**: [`tests/e2e/layout.spec.ts`](tests/e2e/layout.spec.ts) replays the same layout gates over `/`, `/help` and `/ranking` on six device resolutions: iPhone SE (375×667), iPhone 14 (390×844), Pixel 7 (412×915), iPad (768×1024), Laptop (1366×768) and a 4K display (2560×1440).
- **Overflow Detection**: each leg fails when `document.documentElement.scrollWidth` exceeds `window.innerWidth` — horizontal DOM scrolling on a phone cannot be panned back — and when a visible element is clipped by the right edge of the viewport (this is what catches a fixed header bar whose links run past 375 px). Landmark geometry (nav, primary heading) is additionally asserted to stay inside the viewport.
- **Visual Baselines**: viewport screenshots live in [`tests/e2e/layout.spec.ts-snapshots/`](tests/e2e/layout.spec.ts-snapshots) with a 5 % pixel tolerance; non-replayable surfaces (Mapbox canvas, live RPC latency pill, video frames) are frozen or masked before capture so the shot records layout, not fresh data. Regenerate deliberately with `npm run test:layout:generate`.
- **Resolution Projects**: every device is its own Playwright project (`layout-iphone-se` … `layout-display-4k`) declared in `playwright.config.js`, so a failure names its resolution. `npm run test:layout` runs the whole matrix; `npx playwright test --project=layout-iphone-se` runs one leg.
- **CI Matrix**: the `e2e-layout-matrix` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) fans out one leg per resolution on pull requests (`fail-fast: false`) and uploads `test-results/` plus the baselines when a leg fails.

---

### 10. Disaster Resilience, Accessibility & Privacy Hardening Spikes (#766–#769)
- **Right-to-be-Forgotten & Data-Purge Spike (#766)**: Multi-table partition-pruned deletion engine (`server/lib/dataPurge.js`), Redis/WebSocket buffer eviction, CRDT anti-resurrection barrier protocol for 48h offline stragglers, append-only ledger crypto-redaction, and signed erasure receipts. See [`docs/spikes/766-right-to-be-forgotten-purge-report.md`](docs/spikes/766-right-to-be-forgotten-purge-report.md). Tests: `test/data-purge-spike.test.js`.
- **WCAG 2.2 AA & Screen-Reader Hardening Spike (#767)**: Accessible rendezvous and incident keyboard list alternative (`src/components/MapAccessibleAlternative.jsx`), modal focus traps with invoker restoration (`src/lib/focusTrap.js`), and reduced-motion vestibular safety controls (`src/lib/a11yMotion.js`). See [`docs/spikes/767-wcag-screen-reader-hardening-report.md`](docs/spikes/767-wcag-screen-reader-hardening-report.md). Tests: `test/a11y-wcag-hardening.test.jsx`.
- **12-Hour Shift Battery & Thermal Management (#768)**: Hardware-aware power budgeting (`src/lib/powerManager.js`) with geofence-adaptive GPS sampling tiers (1Hz on-scene, 0.05Hz en-route, 0.016Hz stationary), Doze-aware presence state machine (`ACTIVE`, `DOZE_SUSPECTED`, `OFFLINE`), thermal-aware WASM proving with epoch-cache reuse, transient audio wakelock budgeting (capped to 5s), and mass-wake reconnection jitter. See [`docs/spikes/768-battery-thermal-field-responder-report.md`](docs/spikes/768-battery-thermal-field-responder-report.md). Tests: `test/power-battery-thermal-spike.test.js`.
- **Correlated Multi-Fault Chaos Engineering & Bulkhead Design (#769)**: Quad-fault chaos harness (`server/lib/chaosEngine.js`) executing the `RED_WEDDING` scenario (concurrent Redis crash, PostgreSQL partition detach, Stellar Horizon 429 rate limit storm, and CPU quota throttle), featuring connection pool lanes (`CRITICAL` vs `BACKGROUND`), staged admission load-shedding, `txBatcher` queue cap and spill-to-disk buffer, verification priority queues, and single-command rollback. See [`docs/spikes/769-multi-fault-chaos-bulkhead-report.md`](docs/spikes/769-multi-fault-chaos-bulkhead-report.md). Tests: `test/chaos-multi-fault-spike.test.js`.

---

### 11. Zero-Downtime Deploy, Observability Quota, Secrets Rotation & Anti-Spoofing Spikes (#758–#761)
- **Zero-Downtime Deploy Choreography (#758)**: Unified graceful deployment and shutdown protocol (`server/lib/zeroDowntimeDeploy.js`) coordinating migration advisory fencing, dual-readiness `/readyz` gating (<50 ledgers lag), graceful WS draining with `resumeSeq` tokens (blackout p95 <3s), and single-holder indexer advisory locking with atomic batch checkpoints. See [`docs/spikes/758-zero-downtime-deploy-report.md`](docs/spikes/758-zero-downtime-deploy-report.md). Tests: `test/zero-downtime-deploy-spike.test.js`.
- **OpenTelemetry Sampling & Quota Protection (#759)**: Observability quota guardian (`server/lib/otelSamplingEngine.js`) combining Pareto drop rules (stripping ≥70% noise spans), 5% head sampling with 100% tail capture for errors and emergency flows, salted PII/cardinality masking (<500 series), and an OTLP 429 circuit breaker. See [`docs/spikes/759-otel-sampling-quota-report.md`](docs/spikes/759-otel-sampling-quota-report.md). Tests: `test/otel-sampling-spike.test.js`.
- **Zero-Downtime Secrets Rotation Without Restart (#760)**: Hot-reloading secrets manager (`server/lib/secretRotationManager.js`) implementing atomic pre-validation, dual-trust signature verification windows (Gen N and Gen N-1 grace), and blue-green connection pool rebirth for PostgreSQL and Redis. See [`docs/spikes/760-secrets-rotation-report.md`](docs/spikes/760-secrets-rotation-report.md). Tests: `test/secret-rotation-spike.test.js`.
- **Anti-Spoofing & ZK Credential Replay Defense (#761)**: Security verification engine (`server/lib/antiSpoofVerification.js`) binding proofs cryptographically to incident and epoch, impossible-travel teleportation filter (>300 m/s), multi-device sybil nullifier deduplication, and a progressive disclosure ladder gating exact citizen coordinates in `Help.jsx`. See [`docs/spikes/761-anti-spoof-geofence-report.md`](docs/spikes/761-anti-spoof-geofence-report.md). Tests: `test/anti-spoof-verification-spike.test.js`.

---

### 12. PWA Cache Poisoning, Dependency Confusion & Build-Egress Defense Spikes (#762–#764)
- **PWA Cache Poisoning & Map Tile Integrity (#762)**: Integrity and anti-poisoning manager (`server/lib/tileCacheIntegrity.js`) removing opaque status 0 footguns (`statuses: [200]`), enforcing Stale-While-Revalidate with 7-day TTL, version-scoped cache lifecycle (`tiles-v1`), protobuf MIME & size bounds, and emergency in-app tile purge protocol (`PURGE_TILES`) with client telemetry. See [`docs/spikes/762-pwa-cache-poisoning-tile-report.md`](docs/spikes/762-pwa-cache-poisoning-tile-report.md). Tests: `test/pwa-cache-poisoning-spike.test.js`.
- **Dependency Confusion & Build-Tag Protection (#763)**: Pre-resolution dependency validator (`scripts/security/dependencyConfusionGuard.js`) enforcing exact build-tag pinning for `@sqlite.org/sqlite-wasm` without caret (`3.53.4-build1`), pre-resolution typosquatting and scope confusion gates, cross-lockfile consistency checks (`verify-lockfile-hashes.js`), and pre-compilation WASM source input verification (`verify-wasm-build.sh`). See [`docs/spikes/763-dependency-confusion-sqlite-wasm-report.md`](docs/spikes/763-dependency-confusion-sqlite-wasm-report.md). Tests: `test/dependency-confusion-spike.test.js`.
- **Build-Egress Exfiltration Defense (#764)**: Multi-phase pipeline confinement guardian (`scripts/security/buildEgressGuard.js`) enforcing secret-free install phase environment scoping, AST-based obfuscated sink detection (`"fe" + "tch"`) in `scripts/audit-ai-code.js`, artifact secret scanning (Stellar seeds, Mapbox tokens, Shannon entropy), protocol-aware egress anomaly detection (DNS tunneling & query-string beacons), and cryptographic release transcript attestation. See [`docs/spikes/764-build-egress-exfiltration-report.md`](docs/spikes/764-build-egress-exfiltration-report.md). Tests: `test/build-egress-exfiltration-spike.test.js`.

---

## Quick Start

```bash
# Install dependencies
npm install

# Run local development server & indexer
npm run dev

# Run code quality & type checking
npm run lint
npm run typecheck

# Run complete Vitest test suite
npm test

# Run the multi-resolution Playwright layout matrix (6 device profiles)
npm run test:layout

# Export Soroban contract storage state manually
npm run export:state
```

---

## Environment Variables

Configure `.env`:

```bash
VITE_MAPBOX_TOKEN=...
VITE_AEGIS_VAULT_ID=...
VITE_ZK_PROVER_URL=/zk
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
CONTRACT_ID=CC325F37QW7N2F5M3QGHL4A4O7J2K9L0M1N2O3P4Q5R6S7T8U9V0
```

---

## Deployment & Infrastructure

- **Server Blueprint**: Managed via `render.yaml` with web service and daily snapshot cron jobs.
- **CI/CD Pipeline**: GitHub Actions workflow at `.github/workflows/ci.yml`.

## Lockfile integrity

`npm run security:lockfiles` compares every npm SHA-512 integrity value and
Cargo SHA-256 checksum with the official npm and crates.io registries. CI runs
the check before installation and fails on divergence. Use
`npm run security:lockfiles:offline` to validate checksum shape without
network access; it is not a substitute for the CI registry check.

## Safe dependency installation

Normal npm installs have lifecycle scripts disabled by `.npmrc`. Run
`npm run security:install` for the standard install and scan. If a reviewed
native dependency genuinely requires a build script, pass its exact package
name to `bash scripts/sandbox-install.sh <package>`; the rebuild runs in a
rootless, capability-dropped container with no network, no host home/SSH mount,
a read-only container root, and only the repository mounted writable.

## AI-generated code security

`npm run security:ai-code` parses JavaScript and TypeScript ASTs and fails on
hardcoded secrets, unsanitized request data at sensitive sinks, unsafe HTML,
dynamic code, swallowed errors, unauthenticated contract submissions, invalid
platform API signatures, and undeclared package imports. PRs containing
AI-generated logic must carry the `ai-generated` label; the CI
`security-review` environment then requires a human security reviewer.
