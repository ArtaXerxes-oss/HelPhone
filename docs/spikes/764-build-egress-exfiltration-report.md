# Spike #764: Build-Egress Exfiltration — Multi-Phase Confinement, Artifact Secret Scanning & AI Sink Detection

Refs [#764](https://github.com/Hel-Phone/HelPhone/issues/764).

## 1. Executive Summary

HelPhone protects sensitive cryptographic keys, including Stellar master operator keys, Soroban contract signing keys, and Mapbox secret tokens. Previously, build-time security scanning focused primarily on runtime checks or post-build artifact inspection without strict per-phase network and environment confinement:
1. **Secrets Present in Untrusted Phases**: In standard CI workflows, environment variables containing secrets were mounted across all pipeline steps, including `npm ci` where untrusted third-party dependencies executed lifecycle scripts.
2. **Side-Channel Carrier Bypasses**: Simple host allowlists in `monitor-build-egress.sh` allowed requests to `api.mapbox.com` or DNS resolvers. Malicious code could encode secrets into DNS query labels (DNS tunneling, e.g. `SFAKECANARY...exfil.invalid`) or query string parameters on allowlisted hosts (e.g. `https://api.mapbox.com/v4/test?canary=SFAKECANARY...`).
3. **Inlining via Vite & Sourcemaps**: Build tools (Vite `define`, inlined environment variables, and sourcemap files) could accidentally embed high-entropy keys or canary tokens into `dist/**` without triggering automated build abortion.
4. **Obfuscated Sinks in AI Contributions**: Regex-based scanners in `audit-ai-code.js` were easily bypassed using split string concatenation (`"fe" + "tch"`), template literals (`` `f${'e'}tch` ``), or base64 decoding (`atob('ZmV0Y2g=')`).

This spike introduces the `BuildEgressGuard` (`scripts/security/buildEgressGuard.js`), upgrades `scripts/audit-ai-code.js` with AST-based obfuscated sink detection, enforces secret-free install phase environment scoping in `scripts/security/env_firewall.js`, adds comprehensive artifact scanning (Stellar seeds, Mapbox tokens, Shannon entropy), protocol-aware egress anomaly detection, and cryptographic release transcript attestation.

---

## 2. Multi-Phase Confinement & Attack Mitigation Architecture

```
[CI / CD PIPELINE TOPOLOGY]

   PHASE 1: INSTALL (Network Confined, Zero Secrets)
   ├── ENV: INSTALL_ALLOW = [NODE_ENV, PATH, HOME, CI]
   ├── Fail-closed if any SECRET|PRIVATE|SEED|TOKEN present
   ├── npm ci --ignore-scripts (only allowlisted sandboxes execute)
   └── Egress restricted to verified registry CDNs

   PHASE 2: BUILD & AUDIT (Public Client Vars Only)
   ├── ENV: BUILD_ALLOW = [VITE_MAPBOX_PUBLIC_*, VITE_*]
   ├── Vite build + sourcemap generation
   ├── Artifact Secret Scan (scripts/security/buildEgressGuard.js):
   │   ├── Stellar seeds: \bS[A-Z2-7]{55}\b
   │   ├── Mapbox private tokens: \bsk\.[a-zA-Z0-9_-]+\b
   │   ├── Canary patterns: \b(?:CANARY_|SFAKECANARY)\b
   │   └── Shannon entropy threshold (> 4.2)
   └── AI-Code AST Audit: detects split-string ("fe" + "tch") and base64 sinks

   PHASE 3: SIGN & RELEASE (Isolated Signer Job)
   ├── Isolated runner, zero third-party package execution
   ├── Releases signed only if:
   │   ├── Egress transcript digest matches clean baseline
   │   └── Artifact scan passes with zero leaks
```

---

## 3. Core Architectural Implementations

### 1. Multi-Phase Environment Firewall (`buildEgressGuard.js` & `env_firewall.js`)
- **Phase Enforcer**: `enforcePhaseEnvironment(phase, env)` asserts that the install phase contains zero secret variables. Any accidental secret leakage immediately halts CI execution.
- **Late-Binding Secrets**: Stellar signing secrets and Mapbox private tokens are strictly withheld until the release signing phase, never exposed to build workers.

### 2. Deep Artifact Secret Scanner
- Scans all output files in `dist/` including JavaScript bundles, CSS, `.map` sourcemaps, and WASM custom sections.
- Evaluates string patterns against known key prefixes and calculates Shannon entropy on raw tokens, catching obfuscated or unformatted secret seeds.

### 3. Protocol-Aware Egress Inspection
- **DNS Tunneling Defense**: Detects high-entropy subdomains and suspicious exfiltration TLDs (`.exfil.invalid`).
- **Query-String Beacon Detection**: Inspects URL parameters on allowlisted domains (e.g. Mapbox API) for canary leaks or high-entropy data payloads.

### 4. Taint-Aware AI-Code Sink Detection (`audit-ai-code.js`)
- Upgraded TypeScript AST parsing in `scripts/audit-ai-code.js` to inspect binary addition expressions.
- Intercepts split string invocations such as `"fe" + "tch"` and `'child_' + 'process'`, flagging AI-touched pull requests for mandatory manual review.

### 5. Cryptographic Release Transcript Attestation
- Per-phase network capture logs are hashed via SHA-256.
- Release signing scripts require an attested, verified transcript digest before cryptographic signatures are applied to production release artifacts.

---

## 4. Acceptance Criteria Verification

| Acceptance Criterion | Result | Evidence |
|---|---|---|
| Install-phase env dump contains zero secrets | Passed | `enforcePhaseEnvironment("install")` fails on any sensitive key |
| Canary DNS exfil blocked & logged | Passed | `detectEgressAnomalies` flags `.exfil.invalid` and high-entropy labels |
| Canary query-string beacon to allowlisted host blocked | Passed | Query-string parameter scan detects canary tokens & entropy spikes |
| Artifact secret-scan fails on inlined secrets | Passed | Scans `dist/**` for `S[A-Z2-7]{55}`, `sk.*`, and canary values |
| Per-phase egress transcripts verified | Passed | `verifyEgressTranscript` cryptographically checks SHA-256 digests |
| `audit-ai-code.js` flags obfuscated `fetch` in AI diffs | Passed | AST inspects string concatenation (`"fe" + "tch"`) and sinks |
| Legitimate build and allowlisted traffic passes | Passed | Clean tree passes with zero false-positives |
| Key-rotation runbook updated in `docs/security-runbook.md` | Passed | Added incident trigger, key compromise protocol, and containment |

---

## 5. Artifacts Produced

1. **Egress & Artifact Guard**: `scripts/security/buildEgressGuard.js` (`BuildEgressGuard`)
2. **Upgraded AI Code Auditor**: `scripts/audit-ai-code.js` (AST split-string & sink detection)
3. **Hardened Env Firewall**: `scripts/security/env_firewall.js` (`enforcePhase` export)
4. **Incident Response Runbook**: `docs/security-runbook.md` (Egress Anomaly & Key-Rotation Runbook)
5. **Unit Test Suite**: `test/build-egress-exfiltration-spike.test.js`
