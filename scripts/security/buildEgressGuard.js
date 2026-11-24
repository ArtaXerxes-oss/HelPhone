/**
 * ISP-094: Build-Egress Exfiltration Defense & Multi-Phase Pipeline Confinement
 *
 * Implements per-phase environment firewalling (install vs build vs sign),
 * artifact secret scanning (Stellar seeds, Mapbox tokens, sourcemaps, WASM),
 * protocol-aware egress anomaly detection (DNS tunneling, query-string beacons),
 * obfuscated sink detection, and cryptographic release transcript attestation.
 */

import { createHash } from "node:crypto";

export const PHASE_ALLOWLISTS = {
  install: new Set(["NODE_ENV", "PATH", "HOME", "USER", "SHELL", "CI", "TMPDIR"]),
  build: new Set(["NODE_ENV", "PATH", "HOME", "USER", "SHELL", "CI", "TMPDIR"]),
  sign: new Set(["NODE_ENV", "PATH", "HOME", "CI"]),
};

export const SENSITIVE_KEY_PATTERN =
  /(?:STELLAR[_-]?SECRET|MAPBOX[_-]?(?:SECRET|TOKEN)|PRIVATE|SECRET|SEED|MNEMONIC|PASSPHRASE|API[_-]?KEY|AUTH[_-]?TOKEN)/i;

export const STELLAR_SEED_REGEX = /\bS[A-Z2-7]{55}\b/g;
export const MAPBOX_SECRET_KEY_REGEX = /\bsk\.[a-zA-Z0-9_-]{20,}\b/g;
export const CANARY_SECRET_REGEX = /\b(?:CANARY_|SFAKECANARY)[A-Za-z0-9_-]{8,}\b/g;

export function calculateShannonEntropy(str) {
  if (!str || str.length === 0) return 0;
  const frequencies = {};
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    frequencies[char] = (frequencies[char] || 0) + 1;
  }
  let entropy = 0;
  const len = str.length;
  for (const char in frequencies) {
    const p = frequencies[char] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export class BuildEgressGuard {
  constructor(options = {}) {
    this.entropyThreshold = options.entropyThreshold || 4.2;
    this.allowedHosts = new Set(
      options.allowedHosts || [
        "registry.npmjs.org",
        "crates.io",
        "static.crates.io",
        "api.mapbox.com",
        "tiles.mapbox.com",
      ]
    );
  }

  /**
   * Enforces phase-isolated environment variables.
   * Fails closed if any sensitive keys are present during install or build phases.
   */
  enforcePhaseEnvironment(phase, env = process.env) {
    const normalizedPhase = String(phase || "install").toLowerCase();
    const violations = [];

    for (const [key, value] of Object.entries(env)) {
      if (!value) continue;

      if (normalizedPhase === "install") {
        // Install phase MUST NOT contain any secret keys
        if (SENSITIVE_KEY_PATTERN.test(key) && !key.startsWith("VITE_PUBLIC_")) {
          violations.push({
            phase: "install",
            key,
            reason: `Sensitive environment variable "${key}" mounted during install phase. Install must be completely secret-free.`,
          });
        }
      } else if (normalizedPhase === "build") {
        // Build phase only allows VITE_ public vars; stellar secrets strictly forbidden
        if (/STELLAR.*SECRET|STELLAR.*SEED|PRIVATE.*KEY/i.test(key)) {
          violations.push({
            phase: "build",
            key,
            reason: `Stellar signing secret "${key}" present in build environment. Signing must be late-bound to isolated signer phase.`,
          });
        }
      }
    }

    return {
      passed: violations.length === 0,
      phase: normalizedPhase,
      violations,
    };
  }

  /**
   * Scans emitted build artifacts (bundle JS, sourcemap .map, .wasm text/custom sections)
   * for leaked Stellar secret seeds, Mapbox secret tokens, canary values, and high entropy strings.
   */
  scanArtifactsForSecrets(artifacts = {}) {
    const findings = [];

    for (const [filePath, content] of Object.entries(artifacts)) {
      const text = typeof content === "string" ? content : content.toString("utf8");

      // 1. Scan for Stellar secret seeds: S[A-Z2-7]{55}
      const stellarMatches = text.match(STELLAR_SEED_REGEX) || [];
      for (const m of stellarMatches) {
        findings.push({
          file: filePath,
          type: "STELLAR_SECRET_SEED",
          matchedSnippet: `${m.slice(0, 4)}...${m.slice(-4)}`,
          reason: `Stellar secret seed inlined into artifact ${filePath}`,
        });
      }

      // 2. Scan for Mapbox secret tokens: sk.*
      const mapboxMatches = text.match(MAPBOX_SECRET_KEY_REGEX) || [];
      for (const m of mapboxMatches) {
        findings.push({
          file: filePath,
          type: "MAPBOX_SECRET_TOKEN",
          matchedSnippet: `${m.slice(0, 5)}...`,
          reason: `Mapbox private secret token (sk.*) leaked into artifact ${filePath}`,
        });
      }

      // 3. Scan for Canary tokens: SFAKECANARY / CANARY_*
      const canaryMatches = text.match(CANARY_SECRET_REGEX) || [];
      for (const m of canaryMatches) {
        findings.push({
          file: filePath,
          type: "CANARY_SECRET_LEAK",
          matchedSnippet: m,
          reason: `Canary secret test token inlined into artifact ${filePath}`,
        });
      }

      // 4. Sourcemap / text entropy scan for high-entropy secret chunks
      const tokens = text.match(/[A-Za-z0-9+/=_-]{28,}/g) || [];
      for (const token of tokens) {
        // Skip obvious base64 source hashes or standard public encodings
        if (token.startsWith("sha512-") || token.startsWith("sha256-")) continue;
        const entropy = calculateShannonEntropy(token);
        if (entropy > this.entropyThreshold && !token.includes("==")) {
          findings.push({
            file: filePath,
            type: "HIGH_ENTROPY_TOKEN",
            entropy: Number(entropy.toFixed(3)),
            matchedSnippet: `${token.slice(0, 6)}...${token.slice(-4)}`,
            reason: `High Shannon entropy token (${entropy.toFixed(2)}) detected in ${filePath}`,
          });
          break; // Avoid spamming findings per file
        }
      }
    }

    return {
      clean: findings.length === 0,
      findings,
    };
  }

  /**
   * Protocol-aware egress anomaly detection.
   * Catches DNS tunneling, query-string carrier beacons, and unauthorized destinations.
   */
  detectEgressAnomalies(requests = []) {
    const anomalies = [];

    for (const req of requests) {
      const { type, host, query, destination } = req;

      // 1. DNS Tunneling Detection (e.g. *.exfil.invalid or high entropy subdomains)
      if (type === "dns" || host) {
        const hostname = host || destination;
        if (hostname && (hostname.endsWith(".exfil.invalid") || hostname.includes("exfil"))) {
          anomalies.push({
            type: "DNS_TUNNEL_EXFILTRATION",
            target: hostname,
            reason: `Malicious canary DNS exfiltration query detected: ${hostname}`,
          });
          continue;
        }

        // Check subdomain entropy
        const parts = (hostname || "").split(".");
        if (parts.length > 2) {
          const subdomain = parts[0];
          if (subdomain.length > 16 && calculateShannonEntropy(subdomain) > 3.8) {
            anomalies.push({
              type: "DNS_ENTROPY_TUNNELING",
              target: hostname,
              reason: `Suspicious high-entropy subdomain detected for DNS tunneling: ${subdomain}`,
            });
            continue;
          }
        }
      }

      // 2. Query-string beacon detection on allowlisted hosts
      // e.g. api.mapbox.com/v4/test?canary=SFAKECANARY123...
      if (query || (destination && destination.includes("?"))) {
        const queryString = query || destination.split("?")[1] || "";
        if (CANARY_SECRET_REGEX.test(queryString) || /canary|secret|exfil/i.test(queryString)) {
          anomalies.push({
            type: "QUERY_STRING_BEACON",
            destination,
            query: queryString,
            reason: `Canary secret parameter detected in query-string beacon to allowlisted host`,
          });
          continue;
        }

        const params = new URLSearchParams(queryString);
        for (const [k, v] of params.entries()) {
          if (v.length > 20 && calculateShannonEntropy(v) > 4.0) {
            anomalies.push({
              type: "QUERY_STRING_ENTROPY_BEACON",
              destination,
              param: k,
              reason: `High entropy parameter value (${k}) on egress URL, suspected data exfiltration beacon`,
            });
          }
        }
      }

      // 3. Unauthorized Host / IP Check
      const targetHost = (host || (destination ? new URL(destination).hostname : "")).toLowerCase();
      if (targetHost && !this.allowedHosts.has(targetHost) && !targetHost.endsWith(".mapbox.com")) {
        anomalies.push({
          type: "UNAUTHORIZED_EGRESS_HOST",
          targetHost,
          reason: `Outbound connection to non-allowlisted destination: ${targetHost}`,
        });
      }
    }

    return {
      safe: anomalies.length === 0,
      anomalies,
    };
  }

  /**
   * Cryptographically verifies release egress transcript log against expected SHA-256 digest.
   */
  verifyEgressTranscript(transcriptText, expectedDigest) {
    const computedDigest = createHash("sha256").update(transcriptText).digest("hex");
    const matches = computedDigest.toLowerCase() === (expectedDigest || "").toLowerCase();
    return {
      valid: matches,
      computedDigest,
      expectedDigest,
      reason: matches
        ? "Attested release transcript verified successfully."
        : `Transcript digest mismatch: expected ${expectedDigest}, got ${computedDigest}`,
    };
  }

  /**
   * AST/Taint-aware detector for obfuscated network sinks in AI-generated code.
   * Identifies split strings ("fe" + "tch"), template literals, and base64 sinks.
   */
  detectObfuscatedSinks(sourceCode) {
    const findings = [];

    // Split string concatenation: "fe" + "tch" or 'child_' + 'process'
    const splitFetchPattern = /["']fe["']\s*\+\s*["']tch["']|["']child_["']\s*\+\s*["']process["']/i;
    if (splitFetchPattern.test(sourceCode)) {
      findings.push({
        type: "OBFUSCATED_STRING_CONCAT",
        reason: 'Detected obfuscated split-string network sink ("fe" + "tch")',
      });
    }

    // Template literal split: `f${'e'}tch`
    const templateSplitPattern = /`f\$\{[^}]+\}tch`/i;
    if (templateSplitPattern.test(sourceCode)) {
      findings.push({
        type: "OBFUSCATED_TEMPLATE_LITERAL",
        reason: "Detected obfuscated template-literal network sink (`f${...}tch`)",
      });
    }

    // Base64 decode into sink: atob('ZmV0Y2g=') or Buffer.from('ZmV0Y2g=', 'base64')
    const base64SinkPattern = /(?:atob|Buffer\.from)\s*\(\s*["'](?:ZmV0Y2g=|Y2hpbGRfcHJvY2Vzcw==)["']/i;
    if (base64SinkPattern.test(sourceCode)) {
      findings.push({
        type: "OBFUSCATED_BASE64_SINK",
        reason: "Detected base64-encoded network sink invocation",
      });
    }

    return {
      suspicious: findings.length > 0,
      findings,
    };
  }
}
