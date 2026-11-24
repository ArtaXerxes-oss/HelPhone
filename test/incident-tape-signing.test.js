import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildIncidentTape,
  restoreQuarantinedTape,
  signIncidentTape,
  sweepIncidentTapes,
  verifyIncidentTape,
} from "../server/lib/incidentTape.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "helphone-tape-signing-"));

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("Incident-tape signing & retention (#951)", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const pubPem = publicKey.export({ type: "spki", format: "pem" });

  it("signs and verifies an incident tape and rejects tampering", () => {
    const events = buildIncidentTape({
      log: [{ timestamp: "2026-11-21T10:00:00Z", type: "dispatch.created", dispatchId: "d-1" }],
    });
    const signed = signIncidentTape(
      {
        generatedAt: "2026-11-21T10:05:00Z",
        scrubbed: true,
        events,
      },
      privPem,
      { keyId: "maintainer-test", now: new Date("2026-11-21T10:05:00Z") },
    );

    const okRes = verifyIncidentTape(signed, pubPem, {
      now: new Date("2026-11-21T12:00:00Z"),
    });
    expect(okRes.ok).toBe(true);
    expect(okRes.keyId).toBe("maintainer-test");

    // Modified tape fails verification
    const tampered = structuredClone(signed);
    tampered.events[0].type = "dispatch.tampered";
    const badRes = verifyIncidentTape(tampered, pubPem, {
      now: new Date("2026-11-21T12:00:00Z"),
    });
    expect(badRes.ok).toBe(false);
    expect(badRes.problems.length).toBeGreaterThan(0);
  });

  it("rejects expired tapes", () => {
    const signed = signIncidentTape(
      {
        generatedAt: "2026-10-01T00:00:00Z",
        scrubbed: false,
        tier: "command-internal",
        events: [],
      },
      privPem,
      { keyId: "maintainer-test", now: new Date("2026-10-01T00:00:00Z") },
    );
    const expiredRes = verifyIncidentTape(signed, pubPem, {
      now: new Date("2026-10-10T00:00:00Z"),
    });
    expect(expiredRes.ok).toBe(false);
    expect(expiredRes.expired).toBe(true);
  });

  it("quarantines expired tapes, logs audit events, allows restore within grace window, and purges after grace", () => {
    const tapeDir = path.join(TMP, "tapes");
    fs.mkdirSync(tapeDir, { recursive: true });
    const expiredTape = signIncidentTape(
      {
        generatedAt: "2026-10-01T00:00:00Z",
        scrubbed: false,
        tier: "command-internal",
        events: [],
      },
      privPem,
      { now: new Date("2026-10-01T00:00:00Z") },
    );
    const freshTape = signIncidentTape(
      {
        generatedAt: "2026-11-20T00:00:00Z",
        scrubbed: true,
        tier: "volunteer-safe",
        events: [],
      },
      privPem,
      { now: new Date("2026-11-20T00:00:00Z") },
    );

    fs.writeFileSync(path.join(tapeDir, "old.tape.json"), JSON.stringify(expiredTape));
    fs.writeFileSync(path.join(tapeDir, "fresh.tape.json"), JSON.stringify(freshTape));

    const sweep1 = sweepIncidentTapes({
      tapeDir,
      now: new Date("2026-11-21T00:00:00Z"),
      graceDays: 7,
    });
    expect(sweep1.quarantined).toEqual(["old.tape.json"]);
    expect(sweep1.retained).toEqual(["fresh.tape.json"]);
    expect(fs.existsSync(path.join(tapeDir, "old.tape.json"))).toBe(false);

    // Restore within grace window
    restoreQuarantinedTape({
      tapeDir,
      filename: "old.tape.json",
      now: new Date("2026-11-23T00:00:00Z"),
    });
    expect(fs.existsSync(path.join(tapeDir, "old.tape.json"))).toBe(true);

    // Re-quarantine and purge after grace window
    sweepIncidentTapes({
      tapeDir,
      now: new Date("2026-11-24T00:00:00Z"),
      graceDays: 7,
    });
    const sweep3 = sweepIncidentTapes({
      tapeDir,
      now: new Date("2026-12-05T00:00:00Z"),
      graceDays: 7,
    });
    expect(sweep3.purged).toEqual(["old.tape.json"]);

    const auditLines = fs
      .readFileSync(path.join(tapeDir, "retention-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(auditLines.map((e) => e.action)).toEqual([
      "quarantine",
      "restore",
      "quarantine",
      "purge",
    ]);
  });
});
