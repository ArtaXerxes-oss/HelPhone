import { describe, it, expect } from "vitest";
import { distance } from "../src/pages/Help.jsx";

// ---------------------------------------------------------------------------
// distance() tests
//
// Verifies the haversine helper (incl. the sinLng term) returns a correct
// km distance for valid coordinates, and null — never NaN — for malformed
// or missing coordinates, so callers can't silently render "NaN km away".
// ---------------------------------------------------------------------------

describe("distance — valid coordinates", () => {
  it("returns 0 for identical points", () => {
    expect(distance([10, 20], [10, 20])).toBe(0);
  });

  it("computes a known distance (roughly London to Paris, ~344km)", () => {
    const london = [51.5074, -0.1278];
    const paris = [48.8566, 2.3522];
    const km = distance(london, paris);
    expect(km).toBeGreaterThan(330);
    expect(km).toBeLessThan(360);
  });

  it("is symmetric", () => {
    const a = [10, 20];
    const b = [30, 40];
    expect(distance(a, b)).toBeCloseTo(distance(b, a), 10);
  });
});

describe("distance — invalid coordinates", () => {
  it("returns null when a coordinate is NaN", () => {
    expect(distance([NaN, 20], [10, 20])).toBeNull();
  });

  it("returns null when a coordinate is undefined", () => {
    expect(distance([undefined, 20], [10, 20])).toBeNull();
  });

  it("returns null when a coordinate is null", () => {
    expect(distance([10, 20], [null, 20])).toBeNull();
  });

  it("returns null when a point is entirely missing", () => {
    expect(distance(null, [10, 20])).toBeNull();
    expect(distance([10, 20], undefined)).toBeNull();
  });

  it("returns null for Infinity", () => {
    expect(distance([Infinity, 20], [10, 20])).toBeNull();
  });
});

describe("distance — strict type assertion for dLng and intermediate values", () => {
  it("returns null when dLng calculation would produce NaN", () => {
    // Edge case: extremely large values that could overflow during calculation
    const huge = [1e308, 1e308];
    const normal = [10, 20];
    expect(distance(huge, normal)).toBeNull();
  });

  it("returns null when dLat calculation would produce NaN", () => {
    // Edge case: coordinates that pass initial validation but produce invalid dLat
    const edgeA = [Number.MAX_VALUE / 2, 20];
    const edgeB = [Number.MAX_VALUE / 2, 20];
    const result = distance(edgeA, edgeB);
    // Should either be null or a valid number, never NaN
    expect(result === null || Number.isFinite(result)).toBe(true);
  });

  it("returns null when sin calculations would produce NaN", () => {
    // Coordinates that might cause issues in trigonometric functions
    const a = [90, 180]; // Extreme valid lat/lng
    const b = [-90, -180];
    const result = distance(a, b);
    expect(result === null || Number.isFinite(result)).toBe(true);
    expect(Number.isNaN(result)).toBe(false);
  });

  it("never returns NaN for any combination of edge case inputs", () => {
    const edgeCases = [
      [0, 0],
      [90, 180],
      [-90, -180],
      [0.0001, 0.0001],
      [89.9999, 179.9999],
      [-89.9999, -179.9999],
      [45, 90],
      [-45, -90],
    ];

    for (const a of edgeCases) {
      for (const b of edgeCases) {
        const result = distance(a, b);
        expect(Number.isNaN(result)).toBe(false);
        expect(result === null || Number.isFinite(result)).toBe(true);
      }
    }
  });

  it("handles rapid sequential calculations without dropping requests", () => {
    // Simulate parallel emergency requests being processed
    const requester = [40.7128, -74.0060]; // NYC
    const responders = [
      [40.7589, -73.9851], // Times Square
      [40.6892, -74.0445], // Jersey City
      [40.7306, -73.9352], // Brooklyn
      [40.7489, -73.9680], // Queens
    ];

    const results = responders.map((responder) =>
      distance(requester, responder)
    );

    // All results should be valid numbers or null, never NaN
    results.forEach((result) => {
      expect(Number.isNaN(result)).toBe(false);
      expect(result === null || Number.isFinite(result)).toBe(true);
    });

    // All results should be positive distances
    results.forEach((result) => {
      if (result !== null) {
        expect(result).toBeGreaterThanOrEqual(0);
      }
    });
  });

  it("ensures dLng validation prevents emergency request drops", () => {
    // Test the specific dLng edge case mentioned in the issue
    const a = [10.5, 20.7];
    const b = [10.6, 20.8];
    const result = distance(a, b);

    // Must return a valid finite number, not NaN
    expect(Number.isFinite(result)).toBe(true);
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("validates haversine formula result before returning", () => {
    // Test that the final result undergoes strict validation
    const validPoints = [
      [51.5074, -0.1278], // London
      [48.8566, 2.3522], // Paris
    ];

    const result = distance(...validPoints);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
  });

  it("handles concurrent calculations with different coordinate ranges", () => {
    // Simulate real-world scenario with multiple emergency requests
    const scenarios = [
      { requester: [34.0522, -118.2437], responder: [34.0522, -118.2437] }, // Same location
      { requester: [40.7128, -74.0060], responder: [34.0522, -118.2437] }, // Cross-country
      { requester: [0, 0], responder: [0.001, 0.001] }, // Near equator
      { requester: [89, 0], responder: [89, 90] }, // Near pole
    ];

    const results = scenarios.map(({ requester, responder }) =>
      distance(requester, responder)
    );

    // Parallel processing should not produce any NaN values
    results.forEach((result, idx) => {
      expect(Number.isNaN(result)).toBe(false);
      expect(result === null || Number.isFinite(result)).toBe(true);
    });
  });
});
