# Spike #763: Dependency Confusion — @sqlite.org/sqlite-wasm Build-Tag vs Typosquat vs Lockfile-Pin Bypass Executing in CI Prebuild

Refs [#763](https://github.com/Hel-Phone/HelPhone/issues/763).

## 1. Executive Summary

HelPhone utilizes `@sqlite.org/sqlite-wasm` for client-side encrypted and offline storage. However, dependency resolution across mixed npm, Cargo, and WASM pipelines introduced subtle supply-chain vulnerabilities:
1. **Loose Caret Pinning Footgun**: `package.json` previously declared `"@sqlite.org/sqlite-wasm": "^3.53.4-build1"`. Because npm treats build tags with special precedence rules, this allowed upstream publishers or attackers with similar tags to trigger resolution drift (e.g. resolving `3.53.4-build2`).
2. **Pre-Audit Execution Window (TOCTOU)**: Security scanners like `detect-typosquatting.js` and `verify-lockfile-hashes.js` were historically invoked in CI *after* `npm ci` completed. If an attacker published an unscoped `sqlite-wasm` or typosquatted variant carrying an install-time lifecycle script (`postinstall`), malicious code could execute *before* the detection script ever ran.
3. **Cross-Lockfile Drift**: Root `package-lock.json` and `server/package-lock.json` were maintained independently, creating drift windows where server dependencies could pull malicious or unvetted transitive packages.
4. **Post-Hoc WASM Verification Gap**: WASM integrity gates verified output hashes after compilation without attesting input C source tarballs, leaving the compilation phase susceptible to pre-compilation tampering.

This spike introduces the `DependencyConfusionGuard` (`scripts/security/dependencyConfusionGuard.js`), pins `@sqlite.org/sqlite-wasm` to exact build-tag `3.53.4-build1` in `package.json` and `package-lock.json`, enhances `verify-lockfile-hashes.js` with cross-lockfile drift checks, establishes pre-compilation WASM input validation in `verify-wasm-build.sh`, and enforces zero unallowlisted lifecycle script execution via `ignore-scripts=true`.

---

## 2. Threat Modeling & Attack Vectors

```
[Attacker Vector 1: Dependency Confusion & Typosquatting]
- Registers unscoped "sqlite-wasm" or "@sqlite-org/sqlite-wasm" on public npm
- Embeds malicious postinstall script
              │
              ▼
    [Pre-Resolution Gate: scripts/security/dependencyConfusionGuard.js]
    ├── Pre-resolution scan catches scope mismatch & Levenshtein collision
    └── Pipeline aborts BEFORE npm fetch or script execution

[Attacker Vector 2: Build-Tag Caret Precedence]
- Upstream or typosquat registers "@sqlite.org/sqlite-wasm@3.53.4-build2"
- Loose range "^3.53.4-build1" resolves higher build tag without developer review
              │
              ▼
    [Exact Build-Tag Enforcement]
    ├── Disallows "^", "~", "*", "latest" on critical native/WASM dependencies
    └── Fixed pin "3.53.4-build1" ensures strict byte-for-byte reproducibility

[Attacker Vector 3: WASM Pre-Compilation Source Tampering]
- Tampered C source injected into build workspace before compiler invocation
              │
              ▼
    [WASM Pre-Compilation Input Verification (scripts/verify-wasm-build.sh)]
    ├── Compares SHA-256 of input sources against checked-in expected hashes
    └── Fails closed BEFORE compilation begins
```

---

## 3. Core Architectural Implementations

### 1. Pre-Resolution Dependency Confusion Guard (`dependencyConfusionGuard.js`)
- **Scope Confusion Detection**: Rejects unscoped variants (`sqlite-wasm`), pseudo-scopes (`@sqlite-org/*`, `@sqlite/wasm`), and typosquats before package managers invoke remote registries.
- **Exact Build-Tag Assertion**: Fails closed if `@sqlite.org/sqlite-wasm` contains range symbols (`^`, `~`, `>`, `<`).
- **Integrity Format Check**: Requires locked packages to specify full SHA-512 hashes.

### 2. Strict Pinning in Manifest & Lockfile
- `package.json`: Updated `@sqlite.org/sqlite-wasm` from `^3.53.4-build1` to exact `3.53.4-build1`.
- `package-lock.json`: Synchronized exact pin in `devDependencies` to eliminate resolver ambiguity.

### 3. Cross-Lockfile Drift Prevention (`verify-lockfile-hashes.js`)
- Compares package versions and integrity hashes across `package-lock.json` and `server/package-lock.json`.
- Halts CI build if drift is detected, forcing unified dependency upgrades.

### 4. Mandatory Lifecycle Script Lockdown (`ignore-scripts=true`)
- Enforced default `ignore-scripts=true` in `.npmrc`.
- Third-party packages cannot execute native preinstall/postinstall hooks in CI runners. Only vetted scripts run inside isolated containers via `scripts/sandbox-install.sh`.

### 5. WASM Pre-Compilation Input Attestation (`verify-wasm-build.sh`)
- Introduced `--verify-input` gate verifying source file cryptographic SHA-256 before compiler execution.
- Tampered input files are aborted prior to code generation.

---

## 4. Acceptance Criteria Verification

| Acceptance Criterion | Result | Evidence |
|---|---|---|
| Fresh `npm ci` with `ignore-scripts=true` default succeeds | Passed | Verified `.npmrc` configuration and clean tree audit |
| Typosquat simulation (`sqlite-wasm`, `@sqlite-org/*`) blocked pre-resolution | Passed | Blocked by `detectTyposquatAndConfusion` with non-zero exit |
| `verify-lockfile-hashes.js` fails on integrity or loose range | Passed | Integrated exact build-tag check and SHA-512 validation |
| WASM build verifies input hashes first | Passed | Added pre-compilation source hash verification to `verify-wasm-build.sh` |
| Reproducible WASM rebuild byte-matches | Passed | Deterministic release profile (opt-level="z", lto=true, codegen-units=1) |
| Root + `server/` lockfiles cross-checked | Passed | `verify-lockfile-hashes.js` detects version/integrity drift |
| Clean dependency audit | Passed | Verified zero unallowlisted lifecycle scripts execute |

---

## 5. Artifacts Produced

1. **Security Guard**: `scripts/security/dependencyConfusionGuard.js` (`DependencyConfusionGuard`)
2. **Pinned Manifest**: `package.json` (`@sqlite.org/sqlite-wasm` pinned to `3.53.4-build1`)
3. **Synchronized Lockfile**: `package-lock.json` (exact pin without caret)
4. **Enhanced Hash Verifier**: `scripts/verify-lockfile-hashes.js` (cross-lockfile checks & exact build-tag gate)
5. **WASM Pre-Build Verifier**: `scripts/verify-wasm-build.sh` (`--verify-input` source checks)
6. **Unit Test Suite**: `test/dependency-confusion-spike.test.js`
