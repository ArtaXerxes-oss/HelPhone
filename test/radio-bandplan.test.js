import { describe, expect, it } from "vitest";
import {
  BAND_MODES,
  HAM_WIRE_FIELDS,
  PII_FIELDS,
  assertHamSafe,
  decryptLicensed,
  redactForHam,
  toGridSquare,
  toWire,
  triageCode,
} from "../src/lib/radio/bandPlan";
import { randomHex } from "../src/lib/field/crypto";
import { utf8Decode } from "../src/lib/field/crypto";

const PII_INTENT = {
  type: "medical",
  severity: 3,
  name: "Maria Rossi",
  phone: "+393331234567",
  notes: "allergy to penicillin, Via Roma 1",
  address: "Via Roma 1, Milano",
  contact: "@maria",
  lat: 45.4642,
  lng: 9.19,
  wallet: "GABC123SECRETWALLET",
  id: 42,
};

describe("band plan — ham (Part 97) redaction", () => {
  it("strips every PII field from the ham wire schema", () => {
    const { wire, redacted } = redactForHam(PII_INTENT, {
      from: "HEL-04",
      to: "HEL-BASE",
    });
    assertHamSafe(wire);
    for (const field of PII_FIELDS) {
      expect(wire[field]).toBeUndefined();
      expect(JSON.stringify(wire)).not.toContain(PII_INTENT[field]);
    }
    expect(redacted).toEqual(
      expect.arrayContaining([
        "name",
        "phone",
        "notes",
        "address",
        "contact",
        "lat",
        "lng",
        "wallet",
      ]),
    );
    for (const key of Object.keys(wire)) {
      expect(HAM_WIRE_FIELDS).toContain(key);
    }
    expect(wire.t).toBe("MED");
    expect(wire.s).toBe(3);
    expect(wire.from).toBe("HEL-04");
  });

  it("assertHamSafe throws on any PII leak (build gate)", () => {
    expect(() => assertHamSafe({ t: "MED", phone: "+15551234567" })).toThrow(
      /PII leak/,
    );
    expect(assertHamSafe({ t: "MED", g: "JN59ss" })).toBe(true);
  });

  it("reduces coordinates to a coarse 6-char grid square", () => {
    const grid = toGridSquare(45.4642, 9.19);
    expect(grid).toMatch(/^[A-R]{2}[0-9]{2}[A-X]{2}$/);
    expect(grid).not.toContain("45.46");
  });

  it("maps emergency types to compact triage codes", () => {
    expect(triageCode("medical")).toBe("MED");
    expect(triageCode("car")).toBe("CAR");
    expect(triageCode("unknown-type")).toBe("OTH");
  });

  it("ham toWire produces plaintext JSON under the frame budget", async () => {
    const { bytes, mode, redacted } = await toWire(
      PII_INTENT,
      BAND_MODES.HAM,
      null,
      {
        from: "HEL-04",
      },
    );
    expect(mode).toBe(BAND_MODES.HAM);
    expect(bytes.length).toBeLessThan(100);
    const parsed = JSON.parse(utf8Decode(bytes));
    assertHamSafe(parsed);
    expect(redacted.length).toBeGreaterThan(0);
  });
});

describe("band plan — licensed (Part 90) AEAD", () => {
  it("encrypts + decrypts a full PII intent with a fresh nonce each time", async () => {
    const key = randomHex(32);
    const a = await toWire(PII_INTENT, BAND_MODES.LICENSED, key);
    const b = await toWire(PII_INTENT, BAND_MODES.LICENSED, key);
    expect(Array.from(a.bytes)).not.toEqual(Array.from(b.bytes)); // no nonce reuse
    const decoded = await decryptLicensed(a.bytes, key);
    expect(decoded.phone).toBe(PII_INTENT.phone);
    expect(decoded.name).toBe(PII_INTENT.name);
  });

  it("licensed frames fit the 150B MTU after fragmentation", async () => {
    const key = randomHex(32);
    const { bytes } = await toWire(PII_INTENT, BAND_MODES.LICENSED, key);
    // 12B IV + GCM tag + compact JSON — comfortably under a couple frames.
    expect(bytes.length).toBeLessThan(400);
  });

  it("licensed toWire requires a session key", async () => {
    await expect(toWire(PII_INTENT, BAND_MODES.LICENSED, null)).rejects.toThrow(
      /session key/,
    );
  });
});
