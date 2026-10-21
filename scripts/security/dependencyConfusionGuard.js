/**
 * ISP-093: Dependency Confusion & Build-Tag Bypass Protection Guard
 *
 * Implements pre-resolution dependency validation, strict build-tag pinning for
 * @sqlite.org/sqlite-wasm, typosquatting & scope confusion detection, cross-lockfile
 * synchronization checks, lifecycle script lockdown, and WASM pre-compilation input verification.
 */

import { createHash } from "node:crypto";

export const CRITICAL_PINNED_PACKAGES = {
  "@sqlite.org/sqlite-wasm": {
    expectedVersion: "3.53.4-build1",
    allowedScopes: ["@sqlite.org"],
    mustBeExact: true,
  },
};

export const SENSITIVE_TYPOSQUAT_TARGETS = [
  "@sqlite.org/sqlite-wasm",
  "mapbox-gl",
  "soroban-client",
  "stellar-sdk",
  "@stellar/stellar-sdk",
  "workbox-precaching",
  "workbox-routing",
  "workbox-strategies",
];

export function computeSha256(bufferOrString) {
  return createHash("sha256").update(bufferOrString).digest("hex");
}

export function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

export class DependencyConfusionGuard {
  constructor(options = {}) {
    this.criticalPackages = options.criticalPackages || CRITICAL_PINNED_PACKAGES;
    this.allowedInstallScripts = new Set(options.allowedInstallScripts || []);
    this.enforceIgnoreScripts = options.enforceIgnoreScripts !== false;
  }

  /**
   * Asserts that a package is strictly pinned without range operators (^, ~, >, <, *, latest).
   */
  validateExactBuildTagPin(packageJson, packageLock = null, packageName = "@sqlite.org/sqlite-wasm") {
    const deps = {
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {}),
      ...(packageJson.optionalDependencies || {}),
    };

    const declaredVersion = deps[packageName];
    if (!declaredVersion) {
      return { valid: true, pinned: false, reason: `Package ${packageName} not declared in manifest` };
    }

    // Check for range characters
    const hasRangeOperator = /^[\^~><*=]|latest|\.x/i.test(declaredVersion);
    if (hasRangeOperator) {
      return {
        valid: false,
        packageName,
        declaredVersion,
        code: "LOOSE_RANGE_DETECTED",
        reason: `Package ${packageName} uses loose range "${declaredVersion}". Must be pinned to exact build-tag release without ^, ~, or loose operators.`,
      };
    }

    // If package-lock is provided, verify locked version and integrity format
    if (packageLock) {
      const lockPackages = packageLock.packages || {};
      const packageKey = `node_modules/${packageName}`;
      const lockEntry = lockPackages[packageKey] || (packageLock.dependencies && packageLock.dependencies[packageName]);

      if (lockEntry) {
        if (lockEntry.version !== declaredVersion) {
          return {
            valid: false,
            packageName,
            declaredVersion,
            lockedVersion: lockEntry.version,
            code: "LOCKFILE_VERSION_MISMATCH",
            reason: `Declared version "${declaredVersion}" does not match locked version "${lockEntry.version}".`,
          };
        }

        if (lockEntry.integrity && !lockEntry.integrity.startsWith("sha512-")) {
          return {
            valid: false,
            packageName,
            integrity: lockEntry.integrity,
            code: "INTEGRITY_ALGORITHM_WEAK",
            reason: `Lockfile integrity "${lockEntry.integrity}" must use SHA-512.`,
          };
        }
      }
    }

    return { valid: true, pinned: true, version: declaredVersion };
  }

  /**
   * Scans dependency names for confusion or typosquats against sensitive packages.
   * e.g., sqlite-wasm vs @sqlite.org/sqlite-wasm
   */
  detectTyposquatAndConfusion(packageNames = []) {
    const findings = [];

    for (const name of packageNames) {
      // 1. Dependency confusion check for SQLite WASM
      if (
        name === "sqlite-wasm" ||
        name === "@sqlite-org/sqlite-wasm" ||
        name === "@sqlite/wasm" ||
        name.startsWith("@sqlite-wasm/") ||
        name === "sqlite-wasm-build"
      ) {
        findings.push({
          packageName: name,
          target: "@sqlite.org/sqlite-wasm",
          type: "DEPENDENCY_CONFUSION",
          reason: `Unscoped or fake-scoped typosquat of official "@sqlite.org/sqlite-wasm".`,
        });
        continue;
      }

      // 2. Levenshtein distance check against critical targets
      const baseName = name.includes("/") ? name.split("/").pop() : name;
      for (const target of SENSITIVE_TYPOSQUAT_TARGETS) {
        const targetBase = target.includes("/") ? target.split("/").pop() : target;
        if (name === target) continue;

        const dist = levenshteinDistance(baseName.toLowerCase(), targetBase.toLowerCase());
        if (dist === 1 || (dist === 2 && baseName.length >= 8 && targetBase.length >= 8)) {
          findings.push({
            packageName: name,
            target,
            type: "TYPOSQUAT_DISTANCE",
            reason: `Name "${name}" is suspiciously close to "${target}" (Levenshtein distance: ${dist}).`,
          });
        }
      }
    }

    return {
      passed: findings.length === 0,
      findings,
    };
  }

  /**
   * Verifies consistency between root package-lock.json and server/package-lock.json.
   * Identifies any drift in shared dependency versions or integrity hashes.
   */
  validateCrossLockfileConsistency(rootLock, serverLock) {
    const rootPackages = rootLock.packages || {};
    const serverPackages = serverLock.packages || {};

    const rootMap = new Map();
    for (const [key, val] of Object.entries(rootPackages)) {
      if (!key.startsWith("node_modules/") || !val.version) continue;
      const pkgName = key.replace(/^node_modules\//, "");
      rootMap.set(pkgName, { version: val.version, integrity: val.integrity });
    }

    const drifts = [];
    for (const [key, val] of Object.entries(serverPackages)) {
      if (!key.startsWith("node_modules/") || !val.version) continue;
      const pkgName = key.replace(/^node_modules\//, "");
      if (rootMap.has(pkgName)) {
        const rootEntry = rootMap.get(pkgName);
        if (rootEntry.version !== val.version || (rootEntry.integrity && val.integrity && rootEntry.integrity !== val.integrity)) {
          drifts.push({
            packageName: pkgName,
            root: rootEntry,
            server: { version: val.version, integrity: val.integrity },
            reason: `Cross-lockfile drift: root has ${rootEntry.version}, server has ${val.version}`,
          });
        }
      }
    }

    return {
      synchronized: drifts.length === 0,
      drifts,
    };
  }

  /**
   * Asserts that ignore-scripts is enforced by default in .npmrc or install flags.
   */
  enforceLifecycleScriptsPolicy(npmrcText = "", invokedArgs = []) {
    const hasIgnoreScriptsInNpmrc = /ignore-scripts\s*=\s*true/i.test(npmrcText);
    const hasIgnoreScriptsInArgs = invokedArgs.includes("--ignore-scripts");

    if (!hasIgnoreScriptsInNpmrc && !hasIgnoreScriptsInArgs) {
      return {
        compliant: false,
        reason: "Lifecycle scripts are not disabled. ignore-scripts=true must be set in .npmrc or --ignore-scripts in CI install command.",
      };
    }

    return { compliant: true };
  }

  /**
   * Verifies WASM source input hash BEFORE compilation starts.
   * Prevents malicious or tampered source code from entering the compilation pipeline.
   */
  verifyWasmPreCompilationInput(inputBuffer, expectedSha256) {
    const actualHash = computeSha256(inputBuffer);
    if (actualHash.toLowerCase() !== expectedSha256.toLowerCase()) {
      return {
        verified: false,
        expectedSha256,
        actualSha256: actualHash,
        reason: `WASM pre-compilation input hash mismatch: expected ${expectedSha256}, got ${actualHash}. Compilation aborted before execution.`,
      };
    }
    return {
      verified: true,
      hash: actualHash,
    };
  }
}
