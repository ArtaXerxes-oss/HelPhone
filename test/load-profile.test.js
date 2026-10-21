import { describe, it, expect, beforeEach } from "vitest";
import { loadProfile } from "../src/pages/Help.jsx";

// ---------------------------------------------------------------------------
// loadProfile() tests
//
// Verifies the localStorage-backed profile loader always returns a plain
// object, even when localStorage holds malformed or unexpected JSON, so
// callers can safely read .nickname / .contact without crashing.
// ---------------------------------------------------------------------------

describe("loadProfile", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty object when nothing is stored", () => {
    expect(loadProfile()).toEqual({});
  });

  it("returns the stored profile object", () => {
    localStorage.setItem(
      "hp_profile",
      JSON.stringify({ nickname: "Sam", contact: "sam@example.com" }),
    );
    expect(loadProfile()).toEqual({
      nickname: "Sam",
      contact: "sam@example.com",
    });
  });

  it("returns an empty object for invalid JSON", () => {
    localStorage.setItem("hp_profile", "{not json");
    expect(loadProfile()).toEqual({});
  });

  it("returns an empty object when the stored value is the JSON literal null", () => {
    localStorage.setItem("hp_profile", "null");
    expect(loadProfile()).toEqual({});
  });

  it("returns an empty object when the stored value is an array", () => {
    localStorage.setItem("hp_profile", "[1,2,3]");
    expect(loadProfile()).toEqual({});
  });

  it("returns an empty object when the stored value is a primitive", () => {
    localStorage.setItem("hp_profile", "42");
    expect(loadProfile()).toEqual({});
  });
});
