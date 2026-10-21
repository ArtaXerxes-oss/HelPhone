import { beforeEach, describe, expect, it } from "vitest";
import {
  NDEF_MIME,
  buildStagingPayload,
  createCheckInOutStore,
  createStagingRegistry,
  shortCodeFor,
  verifyStagingPayload,
} from "../src/lib/nfc/stagingTag";

const SECRET = "a".repeat(64);

describe("NFC staging tag payload", () => {
  it("builds and verifies a genuine payload offline", async () => {
    const payload = await buildStagingPayload({
      stagingId: "STAGING-BRAVO-04",
      secretHex: SECRET,
      now: 1700000000000,
    });
    const record = JSON.parse(payload);
    expect(record.v).toBe(1);
    expect(record.stagingId).toBe("STAGING-BRAVO-04");
    // Zero PII on the tag — only staging identity + HMAC material.
    expect(payload).not.toMatch(/phone|name|notes|@/);
    const result = await verifyStagingPayload(payload, SECRET, {
      now: 1700000000000,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects cloned/static tags with a bad HMAC", async () => {
    const payload = await buildStagingPayload({
      stagingId: "STAGING-BRAVO-04",
      secretHex: SECRET,
      now: 1700000000000,
    });
    const tampered = JSON.parse(payload);
    tampered.nonce = "deadbeefdeadbeef";
    const result = await verifyStagingPayload(
      JSON.stringify(tampered),
      SECRET,
      {
        now: 1700000000000,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("hmac");
  });

  it("rejects stale timestamps beyond skew window", async () => {
    const payload = await buildStagingPayload({
      stagingId: "STAGING-BRAVO-04",
      secretHex: SECRET,
      now: 1700000000000,
    });
    const result = await verifyStagingPayload(payload, SECRET, {
      now: 1700000000000 + 3 * 86400000,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("stale");
  });

  it("rejects malformed payloads", async () => {
    expect((await verifyStagingPayload("not-json", SECRET)).reason).toBe(
      "malformed",
    );
    expect((await verifyStagingPayload('{"v":2}', SECRET)).reason).toBe(
      "schema",
    );
  });

  it("exposes the NDEF mime type for provisioning", () => {
    expect(NDEF_MIME).toBe("x-helphone/staging");
  });
});

describe("check-in/out reducer", () => {
  let store;
  let now;
  beforeEach(() => {
    now = 1000000;
    store = createCheckInOutStore({ now: () => now });
  });

  it("accepts the first check-in and suppresses a double-tap within 15s", () => {
    const first = store.checkInOut({
      responderId: "R1",
      stagingId: "S1",
      direction: "IN",
      nonce: "n1",
    });
    expect(first.status).toBe("accepted");
    now += 5000; // 5s later — gloved user taps again
    const second = store.checkInOut({
      responderId: "R1",
      stagingId: "S1",
      direction: "IN",
      nonce: "n2",
    });
    expect(second.status).toBe("duplicate_suppressed");
    expect(store.roster()).toHaveLength(1);
    expect(store.headcount("S1")).toBe(1);
  });

  it("suppresses retransmits of the same nonce regardless of debounce", async () => {
    store.checkInOut({
      responderId: "R1",
      stagingId: "S1",
      direction: "IN",
      nonce: "same",
    });
    now += 60000;
    const dup = store.checkInOut({
      responderId: "R1",
      stagingId: "S1",
      direction: "IN",
      nonce: "same",
    });
    expect(dup.status).toBe("duplicate_suppressed");
    expect(dup.reason).toBe("nonce");
  });

  it("allows OUT after IN and allows re-IN after the debounce window", () => {
    store.checkInOut({
      responderId: "R1",
      stagingId: "S1",
      direction: "IN",
      nonce: "a",
    });
    const out = store.checkInOut({
      responderId: "R1",
      stagingId: "S1",
      direction: "OUT",
      nonce: "b",
    });
    expect(out.status).toBe("accepted");
    now += 20000;
    const rein = store.checkInOut({
      responderId: "R1",
      stagingId: "S1",
      direction: "IN",
      nonce: "c",
    });
    expect(rein.status).toBe("accepted");
  });

  it("escalates unmatched INs after 30 minutes", () => {
    store.checkInOut({
      responderId: "R1",
      stagingId: "S1",
      direction: "IN",
      nonce: "a",
    });
    expect(store.unmatchedIns()).toHaveLength(0);
    now += 31 * 60 * 1000;
    expect(store.unmatchedIns()).toHaveLength(1);
  });

  it("rejects malformed intents", () => {
    expect(
      store.checkInOut({ responderId: null, stagingId: "S1", direction: "IN" })
        .status,
    ).toBe("rejected");
    expect(
      store.checkInOut({
        responderId: "R1",
        stagingId: "S1",
        direction: "SIDEWAYS",
      }).status,
    ).toBe("rejected");
  });
});

describe("fallback short codes", () => {
  it("registers and resolves codes for no-NFC devices", () => {
    const registry = createStagingRegistry();
    const code = registry.register("STAGING-BRAVO-04");
    expect(code).toMatch(/^[A-Z0-9]{4,6}$/);
    expect(shortCodeFor("STAGING-BRAVO-04")).toBe(code);
    expect(registry.resolve(code)).toBe("STAGING-BRAVO-04");
    expect(registry.resolve("ZZZZZZ")).toBeNull();
  });
});
