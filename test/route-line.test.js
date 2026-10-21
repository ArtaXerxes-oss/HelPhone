import { describe, it, expect } from "vitest";
import { buildRouteFeature } from "../src/pages/Help.jsx";

// ---------------------------------------------------------------------------
// buildRouteFeature() tests
//
// RouteLine memoizes on this builder instead of allocating a new GeoJSON
// object every render. These tests verify the builder itself stays correct
// (lng/lat order, structure) independent of the memoization.
// ---------------------------------------------------------------------------

describe("buildRouteFeature", () => {
  it("builds a GeoJSON LineString Feature", () => {
    const feature = buildRouteFeature([10, 20], [30, 40]);
    expect(feature.type).toBe("Feature");
    expect(feature.geometry.type).toBe("LineString");
  });

  it("converts [lat, lng] input into [lng, lat] coordinate pairs", () => {
    const feature = buildRouteFeature([10, 20], [30, 40]);
    expect(feature.geometry.coordinates).toEqual([
      [20, 10],
      [40, 30],
    ]);
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const a = buildRouteFeature([10, 20], [30, 40]);
    const b = buildRouteFeature([10, 20], [30, 40]);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("reflects updated coordinates on the next call", () => {
    const first = buildRouteFeature([1, 2], [3, 4]);
    const second = buildRouteFeature([5, 6], [7, 8]);
    expect(first.geometry.coordinates).toEqual([
      [2, 1],
      [4, 3],
    ]);
    expect(second.geometry.coordinates).toEqual([
      [6, 5],
      [8, 7],
    ]);
  });
});
