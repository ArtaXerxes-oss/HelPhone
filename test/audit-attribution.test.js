import { describe, expect, it } from "vitest";
import {
  attributionFor,
  dailyUserHash,
  deviceClassOf,
  uvTierOf,
  utcDay,
} from "../server/indexer/auditAttribution.js";
import { ContractEventStreamer, InMemoryAuditSink, normalizeContractEvent } from "../server/indexer/auditStreamer.js";

const SECRET = "s".repeat(40);
const USER = "GCUSERRAWIDENTIFIER123";
const DEVICE = "device-serial-XYZ-998877";

describe("daily user hash (#926)", () => {
  it("is stable within a UTC day and differs across days", () => {
    const today = dailyUserHash(USER, "2026-11-22", SECRET);
    expect(dailyUserHash(USER, "2026-11-22", SECRET)).toBe(today);
    expect(dailyUserHash(USER, "2026-11-23", SECRET)).not.toBe(today);
  });

  it("is case and whitespace insensitive on the user id", () => {
    expect(dailyUserHash(`  ${USER.toLowerCase()} `, "2026-11-22", SECRET)).toBe(
      dailyUserHash(USER, "2026-11-22", SECRET),
    );
  });

  it("depends on the secret, so it cannot be recomputed from the id alone", () => {
    expect(dailyUserHash(USER, "2026-11-22", "t".repeat(40))).not.toBe(dailyUserHash(USER, "2026-11-22", SECRET));
  });

  it("refuses a short secret rather than writing unkeyed hashes", () => {
    expect(() => dailyUserHash(USER, "2026-11-22", "short")).toThrow("at least 32 characters");
  });

  it("uses the UTC calendar day", () => {
    expect(utcDay("2026-11-22T23:59:59Z")).toBe("2026-11-22");
    expect(utcDay("2026-11-23T00:00:00Z")).toBe("2026-11-23");
  });
});

describe("attribution fields (#926)", () => {
  it("maps the UV claim to an explicit tier", () => {
    expect(uvTierOf({ uv: true })).toBe("uv");
    expect(uvTierOf({ uv: false })).toBe("limited");
    expect(uvTierOf({})).toBe("unknown");
  });

  it("allows only the coarse device classes", () => {
    expect(deviceClassOf({ deviceClass: "mid" })).toBe("mid");
    expect(deviceClassOf({ deviceClass: DEVICE })).toBe("unknown");
    expect(deviceClassOf({})).toBe("unknown");
  });

  it("never copies a device identifier into the attribution", () => {
    const fields = attributionFor({ userId: USER, deviceId: DEVICE, deviceClass: "low" }, {
      secret: SECRET,
      observedAt: "2026-11-22T10:00:00Z",
    });
    expect(Object.keys(fields).sort()).toEqual(["device_class", "uv_tier", "user_hash_per_day"]);
    expect(JSON.stringify(fields)).not.toContain(DEVICE);
  });

  it("returns a null user hash when the event names no user", () => {
    const fields = attributionFor({ topic: "heartbeat" }, { secret: SECRET, observedAt: "2026-11-22T10:00:00Z" });
    expect(fields.user_hash_per_day).toBeNull();
  });
});

describe("normalized audit rows (#926)", () => {
  const observedAt = "2026-11-22T10:00:00Z";
  const event = {
    pagingToken: "501",
    ledger: 42,
    topic: "dispatch_claimed",
    actor: USER,
    uv: true,
    deviceId: DEVICE,
    deviceClass: "high",
    payload: { userId: USER, deviceId: DEVICE, dispatchId: "d-1" },
  };

  it("replaces the raw actor with a daily hash and leaves no raw user id in the row", () => {
    const row = normalizeContractEvent(event, { observedAt, attributionSecret: SECRET });
    expect(row.actor).toBeNull();
    expect(row.attribution.user_hash_per_day).toBe(dailyUserHash(USER, "2026-11-22", SECRET));
    expect(row.attribution.uv_tier).toBe("uv");
    expect(row.attribution.device_class).toBe("high");
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(USER);
    expect(serialized).not.toContain(DEVICE);
  });

  it("keeps the legacy actor field when no secret is configured", () => {
    const row = normalizeContractEvent(event, { observedAt });
    expect(row.actor).toBe(USER);
    expect(row.attribution).toBeNull();
  });
});

describe("streamer attribution wiring (#926)", () => {
  it("attaches attribution to every appended row when a secret is configured", async () => {
    const sink = new InMemoryAuditSink();
    const streamer = new ContractEventStreamer({
      sink,
      attributionSecret: SECRET,
      fetchEvents: async () => [{ pagingToken: "9", topic: "claimed", actor: USER, uv: false }],
    });
    await streamer.poll();
    const [row] = sink.latest();
    expect(row.actor).toBeNull();
    expect(row.attribution.uv_tier).toBe("limited");
    expect(row.attribution.user_hash_per_day).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
});
