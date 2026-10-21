import { describe, expect, it } from "vitest";
import { ZkProofCache } from "../src/services/zkProofCache.js";

describe("ZkProofCache", () => {
  it("returns cached proofs and refreshes LRU metadata", () => {
    let now = 1000;
    const cache = new ZkProofCache({ storage: null, maxEntries: 2, ttlMs: 1000, now: () => now });
    cache.set("a", { proof: "proof-a" });
    now += 10;
    expect(cache.get("a")).toEqual({ proof: "proof-a" });
    expect(cache.stats().entries).toBe(1);
  });

  it("evicts expired and least-recently-used entries", () => {
    let now = 1000;
    const cache = new ZkProofCache({ storage: null, maxEntries: 2, ttlMs: 100, now: () => now });
    cache.set("a", { proof: "a" });
    now += 1;
    cache.set("b", { proof: "b" });
    now += 1;
    cache.get("a");
    now += 1;
    cache.set("c", { proof: "c" });

    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).toEqual({ proof: "a" });
    expect(cache.get("c")).toEqual({ proof: "c" });

    now += 200;
    expect(cache.get("a")).toBeNull();
    expect(cache.stats().entries).toBe(1);
  });
});
