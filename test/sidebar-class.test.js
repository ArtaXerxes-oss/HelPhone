import { describe, it, expect, vi, beforeAll } from "vitest";
import { safeToggleClass } from "../src/pages/Help.jsx";

// ---------------------------------------------------------------------------
// safeToggleClass tests
//
// Verifies the dead-letter queue fallback that prevents silent desync between
// React state and DOM state when a ref-based effect runs before the target
// element mounts.
// ---------------------------------------------------------------------------

describe("safeToggleClass — element available (happy path)", () => {
  it("adds the class when isOpen is true", () => {
    const el = document.createElement("div");
    el.id = "test-sidebar";
    const applied = safeToggleClass(el, true, "test-sidebar");
    expect(applied).toBe(true);
    expect(el.classList.contains("hp-mobile-open")).toBe(true);
  });

  it("removes the class when isOpen is false", () => {
    const el = document.createElement("div");
    el.id = "test-sidebar";
    el.classList.add("hp-mobile-open");
    const applied = safeToggleClass(el, false, "test-sidebar");
    expect(applied).toBe(true);
    expect(el.classList.contains("hp-mobile-open")).toBe(false);
  });

  it("uses a custom class name", () => {
    const el = document.createElement("div");
    el.id = "test-sidebar";
    const applied = safeToggleClass(el, true, "test-sidebar", "my-class");
    expect(applied).toBe(true);
    expect(el.classList.contains("my-class")).toBe(true);
    expect(el.classList.contains("hp-mobile-open")).toBe(false);
  });

  it("returns true when applied immediately", () => {
    const el = document.createElement("div");
    el.id = "test-sidebar";
    const r = safeToggleClass(el, true, "test-sidebar");
    expect(r).toBe(true);
  });

  it("is idempotent — adding when already present does not error", () => {
    const el = document.createElement("div");
    el.id = "test-sidebar";
    el.classList.add("hp-mobile-open");
    expect(() => safeToggleClass(el, true, "test-sidebar")).not.toThrow();
    expect(el.classList.contains("hp-mobile-open")).toBe(true);
  });
});

describe("safeToggleClass — element null (dead-letter path)", () => {
  it("returns false when element is null", () => {
    const r = safeToggleClass(null, true);
    expect(r).toBe(false);
  });

  it("does not throw when element is null", () => {
    expect(() => safeToggleClass(null, true)).not.toThrow();
  });

  it("happy-path immediately clears the dead-letter queue entry", () => {
    const el = document.createElement("div");
    el.id = "helphone-help-sidebar";

    // Queue a dead-letter
    safeToggleClass(null, true);

    // Now provide the element — should apply immediately
    const applied = safeToggleClass(el, false, "helphone-help-sidebar");
    expect(applied).toBe(true);
    expect(el.classList.contains("hp-mobile-open")).toBe(false);
  });

  // The dead-letter rAF retry is inherently async in jsdom.  We verify the
  // scheduling contract by spying *inside* the same test so no callbacks leak.
  it("schedules a single requestAnimationFrame per element ID", () => {
    // Spy before any external rAF can interfere
    const raf = window.requestAnimationFrame;
    const calls = [];
    window.requestAnimationFrame = (cb) => calls.push(cb);

    safeToggleClass(null, true);
    safeToggleClass(null, false);
    safeToggleClass(null, true);

    expect(calls).toHaveLength(1);

    window.requestAnimationFrame = raf;
  });

  it("applies the class via rAF retry when element appears within the frame", () => {
    return new Promise((done) => {
      const el = document.createElement("div");
      el.id = "helphone-help-sidebar";
      document.body.appendChild(el);

      safeToggleClass(null, true);

      // The rAF callback is not guaranteed to fire before the next test
      // unless we schedule our assertion inside the same frame queue.
      requestAnimationFrame(() => {
        expect(el.classList.contains("hp-mobile-open")).toBe(true);
        document.body.removeChild(el);
        done();
      });
    });
  });
});

describe("safeToggleClass — edge cases", () => {
  it("does not throw when called with undefined element", () => {
    expect(() => safeToggleClass(undefined, true)).not.toThrow();
  });

  it("returns false for undefined element (dead-letter path)", () => {
    const r = safeToggleClass(undefined, true);
    expect(r).toBe(false);
  });

  it("immediately applies class when element is provided", () => {
    const el = document.createElement("div");
    el.id = "e";
    safeToggleClass(el, true, "e");
    expect(el.classList.contains("hp-mobile-open")).toBe(true);
  });
});