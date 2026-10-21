import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  loadMyRequestIds,
  saveMyRequestId,
  anonymizeLocation,
} from "../src/pages/Help.jsx";

// ---------------------------------------------------------------------------
// loadMyRequestIds / saveMyRequestId / anonymizeLocation
//
// loadMyRequestIds and saveMyRequestId share the "hp_my_requests" localStorage
// key. Both must tolerate storage that throws (private browsing, quota,
// disabled storage) or holds corrupted/tampered data without crashing the
// caller. anonymizeLocation must reject malformed coordinates instead of
// silently producing NaN that later fails deep inside the contract call.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "hp_my_requests";

describe("loadMyRequestIds", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty array when nothing is stored", () => {
    expect(loadMyRequestIds()).toEqual([]);
  });

  it("returns previously stored ids", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([3, 2, 1]));
    expect(loadMyRequestIds()).toEqual([3, 2, 1]);
  });

  it("returns an empty array on invalid JSON instead of throwing", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadMyRequestIds()).toEqual([]);
  });

  it("returns an empty array when the stored value is valid JSON but not an array", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ hijacked: true }));
    expect(loadMyRequestIds()).toEqual([]);
  });

  it("returns an empty array when the stored value is JSON null", () => {
    localStorage.setItem(STORAGE_KEY, "null");
    expect(loadMyRequestIds()).toEqual([]);
  });

  it("drops non-finite entries from a tampered array", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([1, null, "abc", NaN, 2]),
    );
    expect(loadMyRequestIds()).toEqual([1, 2]);
  });

  it("returns an empty array when localStorage.getItem throws", () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });
    expect(loadMyRequestIds()).toEqual([]);
    spy.mockRestore();
  });
});

describe("saveMyRequestId", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores a new id", () => {
    saveMyRequestId(42);
    expect(loadMyRequestIds()).toEqual([42]);
  });

  it("prepends new ids so the most recent is first", () => {
    saveMyRequestId(1);
    saveMyRequestId(2);
    expect(loadMyRequestIds()).toEqual([2, 1]);
  });

  it("does not duplicate an id that is already stored", () => {
    saveMyRequestId(7);
    saveMyRequestId(7);
    expect(loadMyRequestIds()).toEqual([7]);
  });

  it("caps the stored list at 20 entries", () => {
    for (let i = 1; i <= 25; i++) saveMyRequestId(i);
    const ids = loadMyRequestIds();
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe(25);
  });

  it("ignores non-finite ids", () => {
    saveMyRequestId(NaN);
    saveMyRequestId(undefined);
    expect(loadMyRequestIds()).toEqual([]);
  });

  it("does not throw when localStorage.setItem throws (quota exceeded / private mode)", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    expect(() => saveMyRequestId(9)).not.toThrow();
    spy.mockRestore();
  });
});

describe("anonymizeLocation", () => {
  it("rounds coordinates to 2 decimal places (~1km precision)", () => {
    expect(anonymizeLocation([40.712776, -74.005974])).toEqual([
      40.71, -74.01,
    ]);
  });

  it("throws when location is not an array", () => {
    expect(() => anonymizeLocation(null)).toThrow();
    expect(() => anonymizeLocation(undefined)).toThrow();
  });

  it("throws when a coordinate is missing or non-finite", () => {
    expect(() => anonymizeLocation([40.71])).toThrow();
    expect(() => anonymizeLocation([NaN, -74.01])).toThrow();
    expect(() => anonymizeLocation([40.71, Infinity])).toThrow();
  });
});
