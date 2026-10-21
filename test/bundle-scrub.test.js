import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectBundle, verifyBundle } from "../scripts/helphone-bundle.js";
import {
  scanForPii,
  scrubObject,
  scrubText,
} from "../scripts/security/env_firewall.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "helphone-bundle-test-"));
const PII_FIXTURE = {
  phone: "+393331234567",
  coords: "45.464200, 9.190000",
  notes: "Via Roma 1 allergy to penicillin",
  memo: "customer complained loudly",
  email: "responder@example.org",
  stagingId: "STAGING-BRAVO-04",
};

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    // best-effort — surface failures are non-fatal here
  }
});

describe("PII scrubbing (ISP-130)", () => {
  it("catches phone, coords, notes, memo and email — the fixture that broke the old firewall", () => {
    const findings = scanForPii(JSON.stringify(PII_FIXTURE));
    const names = findings.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "e164-phone",
        "full-precision-coords",
        "free-text-notes",
        "email",
      ]),
    );
  });

  it("scrubText removes every hit while preserving non-PII fields", () => {
    const { text, hits } = scrubText(JSON.stringify(PII_FIXTURE));
    expect(hits.length).toBeGreaterThanOrEqual(4);
    expect(text).not.toContain("+393331234567");
    expect(text).not.toContain("45.464200");
    expect(text).not.toContain("penicillin");
    expect(text).not.toContain("responders@example.org");
    expect(text).toContain("STAGING-BRAVO-04"); // staging IDs are not PII
  });

  it("scrubObject deep-scrubs nested structures", () => {
    const scrubbed = scrubObject({
      events: [{ notes: "secret medical detail" }],
    });
    expect(scrubbed.events[0].notes).toBe("[REDACTED-PII]");
  });
});

describe("incident bundle generator (ISP-130)", () => {
  it("collects a volunteer-safe bundle with manifest hashes and expiry", () => {
    const out = path.join(TMP, "volunteer.tgz");
    const { manifest } = collectBundle({
      since: "2h",
      tier: "volunteer-safe",
      out,
      extraFiles: { "server-logs/dispatch.txt": JSON.stringify(PII_FIXTURE) },
    });
    expect(manifest.tier).toBe("volunteer-safe");
    expect(manifest.collector).toContain("@");
    expect(manifest.git.commit).toBeTruthy();
    expect(manifest.flagVersions.radioBridge.version).toBeGreaterThanOrEqual(1);
    expect(manifest.expiresAt).toBeTruthy();
    expect(manifest.redactionVersion).toBe("1");
    for (const f of manifest.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.redaction).toMatch(/scrub-v1/);
    }
    // The operator-supplied PII fixture must have been scrubbed inside the archive.
    const raw = fs.readFileSync(out);
    expect(raw.includes(Buffer.from("+393331234567"))).toBe(false);
    const verified = verifyBundle(out);
    expect(verified.ok).toBe(true);
  });

  it("detects tampering via verify", () => {
    const out = path.join(TMP, "tamper.tgz");
    collectBundle({ since: "1h", tier: "volunteer-safe", out });
    const buf = fs.readFileSync(out);
    buf[Math.floor(buf.length / 2)] ^= 0xff; // flip a byte
    fs.writeFileSync(out, buf);
    let failed = false;
    try {
      const result = verifyBundle(out);
      failed = !result.ok || result.manifest == null;
    } catch {
      failed = true; // corrupted gzip is also a caught failure
    }
    expect(failed).toBe(true);
  });

  it("refuses command-internal tier without --break-glass", () => {
    expect(() =>
      collectBundle({
        since: "1h",
        tier: "command-internal",
        out: path.join(TMP, "x.tgz"),
      }),
    ).toThrow(/break-glass/);
  });

  it("writes an audit log + shorter expiry for break-glass bundles", () => {
    const out = path.join(TMP, "internal.tgz");
    const { manifest } = collectBundle({
      since: "1h",
      tier: "command-internal",
      breakGlass: true,
      out,
      extraFiles: {
        "ledger/note.txt": "full fidelity note with phone +393331234567 kept",
      },
    });
    expect(manifest.files.some((f) => f.path === "audit-log.json")).toBe(true);
    const expiryDays = (new Date(manifest.expiresAt) - Date.now()) / 86400000;
    expect(expiryDays).toBeLessThanOrEqual(7.1);
    expect(verifyBundle(out).ok).toBe(true);
  });
});
