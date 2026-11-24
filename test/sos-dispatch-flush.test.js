import { beforeEach, describe, expect, it } from "vitest";
import {
  PRIO,
  clearQueue,
  enqueue,
  listQueue,
} from "../src/lib/field/offlineQueue";
import { flushSosQueue, sosEndpoint } from "../src/lib/field/sosDispatch";

const HERE = { lat: 57.64911, lng: 10.40744 };

function queueSos(key, extra = {}) {
  return enqueue({
    kind: "sos",
    prio: PRIO.SOS,
    idempotencyKey: key,
    data: { ts: 1_000, source: "hardware-key", force: false, ...extra },
  }).entry;
}

function respond(status) {
  return async () => ({ status, ok: status >= 200 && status < 300 });
}

describe("flushSosQueue (#941)", () => {
  beforeEach(() => {
    localStorage.clear();
    clearQueue();
  });

  it("posts the idempotency key and location, then removes the entry on 201", async () => {
    queueSos("sos-10");
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { status: 201, ok: true };
    };

    const result = await flushSosQueue({ fetcher, base: "https://helphone.test", location: HERE });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://helphone.test/api/dispatch/sos");
    expect(calls[0].body).toEqual({
      idempotencyKey: "sos-10",
      source: "hardware-key",
      force: false,
      location: HERE,
    });
    expect(result).toEqual({ sent: 1, declined: 0, rejected: 0, pending: 0 });
    expect(listQueue()).toHaveLength(0);
  });

  it("treats a duplicate (200) as delivered", async () => {
    queueSos("sos-11");
    const result = await flushSosQueue({ fetcher: respond(200), base: "https://x.test" });
    expect(result.sent).toBe(1);
    expect(listQueue()).toHaveLength(0);
  });

  it("removes a declined (202) entry: the server did not auto-dispatch it", async () => {
    queueSos("sos-12");
    const result = await flushSosQueue({ fetcher: respond(202), base: "https://x.test" });
    expect(result.declined).toBe(1);
    expect(listQueue()).toHaveLength(0);
  });

  it("removes an invalid (422) entry instead of retrying it forever", async () => {
    queueSos("sos-13");
    const result = await flushSosQueue({ fetcher: respond(422), base: "https://x.test" });
    expect(result.rejected).toBe(1);
    expect(listQueue()).toHaveLength(0);
  });

  it("keeps the entry and stops on a server error so it retries later", async () => {
    queueSos("sos-14");
    queueSos("sos-15");
    let calls = 0;
    const result = await flushSosQueue({
      fetcher: async () => {
        calls += 1;
        return { status: 503, ok: false };
      },
      base: "https://x.test",
    });
    expect(calls).toBe(1);
    expect(result.pending).toBe(2);
    expect(listQueue()).toHaveLength(2);
  });

  it("keeps the entry when the network is down", async () => {
    queueSos("sos-16");
    const result = await flushSosQueue({
      fetcher: async () => {
        throw new TypeError("Failed to fetch");
      },
      base: "https://x.test",
    });
    expect(result.pending).toBe(1);
    expect(listQueue()).toHaveLength(1);
  });

  it("sends no location when the device has no fix, rather than a fabricated one", async () => {
    queueSos("sos-17");
    let body = null;
    await flushSosQueue({
      fetcher: async (_url, init) => {
        body = JSON.parse(init.body);
        return { status: 201, ok: true };
      },
      base: "https://x.test",
      location: null,
    });
    expect(body.location).toBeUndefined();
  });

  it("builds the endpoint from the base URL without a double slash", () => {
    expect(sosEndpoint("https://api.example/")).toBe("https://api.example/api/dispatch/sos");
  });
});
