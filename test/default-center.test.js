import { describe, it, expect } from "vitest";
import { DEFAULT_CENTER } from "../src/pages/Help.jsx";

// ---------------------------------------------------------------------------
// DEFAULT_CENTER tests
//
// Verifies the shared fallback map center is the expected [lat, lng] pair
// and is frozen so it can't be mutated in place by a stray write elsewhere.
// ---------------------------------------------------------------------------

describe("DEFAULT_CENTER", () => {
  it("is the expected [lat, lng] fallback", () => {
    expect(DEFAULT_CENTER).toEqual([20, 0]);
  });

  it("is frozen and cannot be mutated", () => {
    expect(Object.isFrozen(DEFAULT_CENTER)).toBe(true);
    // ES modules run in strict mode, so writing to a frozen array throws.
    expect(() => {
      DEFAULT_CENTER[0] = 999;
    }).toThrow();
    expect(DEFAULT_CENTER).toEqual([20, 0]);
  });
});
