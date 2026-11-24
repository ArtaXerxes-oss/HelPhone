import { describe, expect, it } from "vitest";
import { buildStagingPayload } from "../src/lib/nfc/stagingTag";
import { createStagingGateway, parseStagingRecord } from "../server/lib/stagingCheckIn.ts";

const SECRET = "a".repeat(64);
const T0 = 1_700_000_000_000;
const TS = Math.floor(T0 / 1000);

async function signed(overrides = {}) {
  return buildStagingPayload({
    stagingId: "STAGING-BRAVO-04",
    secretHex: SECRET,
    now: T0,
    ...overrides,
  });
}

describe("server staging check-in gateway (#940)", () => {
  it("accepts a payload the device signed, then answers a replay as duplicate", async () => {
    const gateway = createStagingGateway({ secretHex: SECRET, now: () => T0 });
    const payload = await signed({ nonce: "0123456789abcdef" });

    expect(gateway.checkIn(payload)).toEqual({
      status: 201,
      body: { outcome: "accepted", stagingId: "STAGING-BRAVO-04" },
    });
    expect(gateway.checkIn(payload)).toEqual({
      status: 200,
      body: { outcome: "duplicate", stagingId: "STAGING-BRAVO-04" },
    });
  });

  it("rejects a forged tag whose HMAC does not match the server secret", async () => {
    const gateway = createStagingGateway({ secretHex: SECRET, now: () => T0 });
    const record = JSON.parse(await signed());
    record.stagingId = "STAGING-CHARLIE-09";
    expect(gateway.checkIn(record)).toEqual({ status: 422, body: { outcome: "forged" } });
  });

  it("refuses a payload signed with a different secret", async () => {
    const gateway = createStagingGateway({ secretHex: "b".repeat(64), now: () => T0 });
    expect(gateway.checkIn(await signed()).body.outcome).toBe("forged");
  });

  it("rejects stale timestamps outside the skew window", async () => {
    const gateway = createStagingGateway({ secretHex: SECRET, now: () => T0 + 3 * 86_400_000 });
    expect(gateway.checkIn(await signed())).toEqual({ status: 422, body: { outcome: "stale", stagingId: "STAGING-BRAVO-04" } });
  });

  it("answers 409 for a revoked staging ID, after the signature is checked", async () => {
    const gateway = createStagingGateway({
      secretHex: SECRET,
      revokedStagingIds: ["STAGING-BRAVO-04"],
      now: () => T0,
    });
    expect(gateway.checkIn(await signed())).toEqual({
      status: 409,
      body: { outcome: "revoked", stagingId: "STAGING-BRAVO-04" },
    });
  });

  it("fails closed with 503 when no server secret is provisioned", async () => {
    const gateway = createStagingGateway({ now: () => T0 });
    expect(gateway.checkIn(await signed())).toEqual({ status: 503, body: { outcome: "unconfigured" } });
  });

  it("rejects malformed input and accepts only the strict record shape", () => {
    const gateway = createStagingGateway({ secretHex: SECRET, now: () => T0 });
    expect(gateway.checkIn("not-json")).toEqual({ status: 422, body: { outcome: "malformed" } });
    expect(gateway.checkIn({ v: 2 })).toEqual({ status: 422, body: { outcome: "malformed" } });
    expect(parseStagingRecord({ v: 1, stagingId: "../etc", nonce: "0123456789abcdef", ts: TS, hmac: "a".repeat(64) })).toBeNull();
    expect(parseStagingRecord({ v: 1, stagingId: "S1", nonce: "0123456789abcdef", ts: 1.5, hmac: "a".repeat(64) })).toBeNull();
  });
});
