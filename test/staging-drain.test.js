import { beforeEach, describe, expect, it } from "vitest";
import { PRIO, clearQueue, enqueue, listQueue } from "../src/lib/field/offlineQueue";
import {
  decodeStagingPayload,
  encodeStagingPayload,
  flushStagingQueue,
  stagingEndpoint,
} from "../src/lib/field/stagingDrain";

// Digit-heavy on purpose: the offline queue's phone pattern would rewrite these runs in a string.
const SIGNED = JSON.stringify({
  v: 1,
  stagingId: "STAGING-7788-1234567",
  nonce: "0123456789abcdef",
  ts: 1700000000,
  hmac: "9876543210fedcba".repeat(4),
});

function queueStaging(key, payload = SIGNED) {
  return enqueue({
    kind: "staging",
    prio: PRIO.ROSTER,
    idempotencyKey: key,
    data: { payloadBytes: encodeStagingPayload(payload), stagingId: "STAGING-7788-1234567", source: "nfc" },
  }).entry;
}

function respond(status, body = {}) {
  return async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
}

describe("staging payload storage (#940)", () => {
  beforeEach(() => {
    localStorage.clear();
    clearQueue();
  });

  it("round-trips a signed payload through the offline queue without changing a byte", () => {
    queueStaging("staging-1");
    const [stored] = listQueue();
    expect(decodeStagingPayload(stored.data.payloadBytes)).toBe(SIGNED);
  });

  it("rejects bytes that are not a valid payload", () => {
    expect(decodeStagingPayload(undefined)).toBeNull();
    expect(decodeStagingPayload([])).toBeNull();
    expect(decodeStagingPayload([300])).toBeNull();
  });

  it("builds the server check-in URL without a trailing slash", () => {
    expect(stagingEndpoint("https://api.example/")).toBe("https://api.example/api/staging/check-in");
  });
});

describe("flushStagingQueue (#940)", () => {
  beforeEach(() => {
    localStorage.clear();
    clearQueue();
  });

  it("posts the signed payload and removes the entry on 201", async () => {
    queueStaging("staging-10");
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { status: 201, ok: true };
    };
    const result = await flushStagingQueue({ fetcher, base: "https://helphone.test" });
    expect(calls).toEqual([{ url: "https://helphone.test/api/staging/check-in", body: { payload: SIGNED } }]);
    expect(result).toEqual({ sent: 1, duplicate: 0, conflicts: [], pending: 0 });
    expect(listQueue()).toHaveLength(0);
  });

  it("treats a duplicate (200) as delivered exactly once", async () => {
    queueStaging("staging-11");
    const result = await flushStagingQueue({ fetcher: respond(200), base: "https://x.test" });
    expect(result.duplicate).toBe(1);
    expect(listQueue()).toHaveLength(0);
  });

  it("removes a revoked (409) entry and reports the conflict to the operator", async () => {
    queueStaging("staging-12");
    const result = await flushStagingQueue({
      fetcher: respond(409, { outcome: "revoked", stagingId: "STAGING-7788-1234567" }),
      base: "https://x.test",
    });
    expect(result.conflicts).toEqual([
      expect.objectContaining({ outcome: "revoked", stagingId: "STAGING-7788-1234567" }),
    ]);
    expect(listQueue()).toHaveLength(0);
  });

  it("removes a forged (422) entry and reports it as a conflict", async () => {
    queueStaging("staging-13");
    const result = await flushStagingQueue({ fetcher: respond(422, { outcome: "forged" }), base: "https://x.test" });
    expect(result.conflicts[0].outcome).toBe("forged");
    expect(listQueue()).toHaveLength(0);
  });

  it("keeps the entry and stops on 503 or a network error, so it retries later", async () => {
    queueStaging("staging-14");
    queueStaging("staging-15");
    const unavailable = await flushStagingQueue({ fetcher: respond(503), base: "https://x.test" });
    expect(unavailable.pending).toBe(2);
    expect(listQueue()).toHaveLength(2);

    const offline = await flushStagingQueue({
      fetcher: async () => {
        throw new Error("Failed to fetch");
      },
      base: "https://x.test",
    });
    expect(offline.pending).toBe(2);
    expect(listQueue()).toHaveLength(2);
  });

  it("drops an entry with no usable payload rather than retrying it forever", async () => {
    enqueue({ kind: "staging", idempotencyKey: "legacy-1", data: { stagingId: "S1" } });
    const result = await flushStagingQueue({ fetcher: respond(201), base: "https://x.test" });
    expect(result.conflicts[0].outcome).toBe("malformed");
    expect(listQueue()).toHaveLength(0);
  });
});
