import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  DependencyConfusionGuard,
  computeSha256,
} from "../scripts/security/dependencyConfusionGuard.js";

describe("ISP-093: Dependency Confusion & Build-Tag Bypass Protection Spike", () => {
  let guard;

  beforeEach(() => {
    guard = new DependencyConfusionGuard();
  });

  describe("Exact Build-Tag Pinning for @sqlite.org/sqlite-wasm", () => {
    it("should accept exact pinned build-tag without caret or tilde", () => {
      const mockPackageJson = {
        devDependencies: {
          "@sqlite.org/sqlite-wasm": "3.53.4-build1",
        },
      };
      const mockPackageLock = {
        packages: {
          "node_modules/@sqlite.org/sqlite-wasm": {
            version: "3.53.4-build1",
            integrity: "sha512-mockIntegrityString==",
          },
        },
      };

      const result = guard.validateExactBuildTagPin(
        mockPackageJson,
        mockPackageLock,
        "@sqlite.org/sqlite-wasm"
      );

      expect(result.valid).toBe(true);
      expect(result.pinned).toBe(true);
      expect(result.version).toBe("3.53.4-build1");
    });

    it("should reject loose range with caret (^)", () => {
      const mockPackageJson = {
        devDependencies: {
          "@sqlite.org/sqlite-wasm": "^3.53.4-build1",
        },
      };

      const result = guard.validateExactBuildTagPin(
        mockPackageJson,
        null,
        "@sqlite.org/sqlite-wasm"
      );

      expect(result.valid).toBe(false);
      expect(result.code).toBe("LOOSE_RANGE_DETECTED");
      expect(result.reason).toContain("loose range");
    });

    it("should reject loose ranges with tilde (~), star (*), or latest", () => {
      for (const range of ["~3.53.4-build1", "*", "latest", ">=3.53.0"]) {
        const mockPackageJson = {
          devDependencies: {
            "@sqlite.org/sqlite-wasm": range,
          },
        };
        const result = guard.validateExactBuildTagPin(
          mockPackageJson,
          null,
          "@sqlite.org/sqlite-wasm"
        );
        expect(result.valid).toBe(false);
        expect(result.code).toBe("LOOSE_RANGE_DETECTED");
      }
    });

    it("should fail when manifest declared version drifts from locked version", () => {
      const mockPackageJson = {
        devDependencies: {
          "@sqlite.org/sqlite-wasm": "3.53.4-build1",
        },
      };
      const mockPackageLock = {
        packages: {
          "node_modules/@sqlite.org/sqlite-wasm": {
            version: "3.53.4-build2", // Resolver picked build2
            integrity: "sha512-mock==",
          },
        },
      };

      const result = guard.validateExactBuildTagPin(
        mockPackageJson,
        mockPackageLock,
        "@sqlite.org/sqlite-wasm"
      );

      expect(result.valid).toBe(false);
      expect(result.code).toBe("LOCKFILE_VERSION_MISMATCH");
    });
  });

  describe("Dependency Confusion & Typosquatting Pre-Resolution Gate", () => {
    it("should flag unscoped sqlite-wasm as dependency confusion", () => {
      const { passed, findings } = guard.detectTyposquatAndConfusion([
        "sqlite-wasm",
        "@sqlite-org/sqlite-wasm",
        "@sqlite/wasm",
      ]);

      expect(passed).toBe(false);
      expect(findings.length).toBe(3);
      expect(findings.every((f) => f.type === "DEPENDENCY_CONFUSION")).toBe(true);
    });

    it("should detect Levenshtein distance collision against sensitive packages", () => {
      const { passed, findings } = guard.detectTyposquatAndConfusion([
        "mapbox-glx", // 1 edit away from mapbox-gl
        "soroban-clien", // 1 edit away from soroban-client
      ]);

      expect(passed).toBe(false);
      expect(findings.length).toBe(2);
      expect(findings[0].type).toBe("TYPOSQUAT_DISTANCE");
    });

    it("should pass when clean dependencies have no collisions", () => {
      const { passed, findings } = guard.detectTyposquatAndConfusion([
        "@sqlite.org/sqlite-wasm",
        "react",
        "vite",
        "vitest",
      ]);

      expect(passed).toBe(true);
      expect(findings.length).toBe(0);
    });
  });

  describe("Cross-Lockfile Synchronization Verification", () => {
    it("should detect version and integrity drift across root and server lockfiles", () => {
      const rootLock = {
        packages: {
          "node_modules/ws": {
            version: "8.18.0",
            integrity: "sha512-rootHash==",
          },
        },
      };
      const serverLock = {
        packages: {
          "node_modules/ws": {
            version: "8.17.1", // drifted
            integrity: "sha512-serverHash==",
          },
        },
      };

      const { synchronized, drifts } = guard.validateCrossLockfileConsistency(rootLock, serverLock);
      expect(synchronized).toBe(false);
      expect(drifts.length).toBe(1);
      expect(drifts[0].packageName).toBe("ws");
    });

    it("should pass when root and server shared dependencies are identical", () => {
      const rootLock = {
        packages: {
          "node_modules/ws": {
            version: "8.18.0",
            integrity: "sha512-sameHash==",
          },
        },
      };
      const serverLock = {
        packages: {
          "node_modules/ws": {
            version: "8.18.0",
            integrity: "sha512-sameHash==",
          },
        },
      };

      const { synchronized, drifts } = guard.validateCrossLockfileConsistency(rootLock, serverLock);
      expect(synchronized).toBe(true);
      expect(drifts.length).toBe(0);
    });
  });

  describe("Lifecycle Script Lockdown", () => {
    it("should confirm ignore-scripts=true in .npmrc configuration", () => {
      const validNpmrc = "legacy-peer-deps=true\nignore-scripts=true\n";
      const result = guard.enforceLifecycleScriptsPolicy(validNpmrc, []);
      expect(result.compliant).toBe(true);
    });

    it("should reject install when ignore-scripts is absent in both .npmrc and CLI args", () => {
      const invalidNpmrc = "legacy-peer-deps=true\n";
      const result = guard.enforceLifecycleScriptsPolicy(invalidNpmrc, ["npm", "ci"]);
      expect(result.compliant).toBe(false);
      expect(result.reason).toContain("Lifecycle scripts are not disabled");
    });
  });

  describe("WASM Pre-Compilation Source Input Verification", () => {
    it("should verify valid C/Noir source code before compilation begins", () => {
      const sourceCode = 'fn main() { println("secure"); }';
      const expectedSha256 = computeSha256(sourceCode);

      const result = guard.verifyWasmPreCompilationInput(sourceCode, expectedSha256);
      expect(result.verified).toBe(true);
      expect(result.hash).toBe(expectedSha256);
    });

    it("should abort compilation when source input has been tampered", () => {
      const originalCode = 'fn main() { println("secure"); }';
      const expectedSha256 = computeSha256(originalCode);

      const tamperedCode = 'fn main() { println("tampered"); }';
      const result = guard.verifyWasmPreCompilationInput(tamperedCode, expectedSha256);

      expect(result.verified).toBe(false);
      expect(result.reason).toContain("tampered source detected before compilation");
    });
  });
});
