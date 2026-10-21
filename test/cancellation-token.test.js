import { describe, it, expect, vi } from "vitest";
import { cancellationToken } from "../src/pages/Help.jsx";

// ---------------------------------------------------------------------------
// cancellationToken tests
//
// Verifies that the token correctly guards async operations against stale
// state updates after effect teardown or re-execution.
// ---------------------------------------------------------------------------

describe("cancellationToken — active / cancel", () => {
  it("starts active", () => {
    const ct = cancellationToken();
    expect(ct.active).toBe(true);
  });

  it("becomes inactive after cancel()", () => {
    const ct = cancellationToken();
    ct.cancel();
    expect(ct.active).toBe(false);
  });

  it("cancel() is idempotent", () => {
    const ct = cancellationToken();
    ct.cancel();
    ct.cancel();
    expect(ct.active).toBe(false);
  });

  it("multiple tokens are independent", () => {
    const a = cancellationToken();
    const b = cancellationToken();
    a.cancel();
    expect(a.active).toBe(false);
    expect(b.active).toBe(true);
  });
});

describe("cancellationToken — wrap", () => {
  it("resolves with the promise result when active", async () => {
    const ct = cancellationToken();
    const result = await ct.wrap(Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("returns undefined when cancelled before the promise resolves", async () => {
    const ct = cancellationToken();
    const p = new Promise((r) => setTimeout(r, 100));
    ct.cancel();
    const result = await ct.wrap(p);
    expect(result).toBeUndefined();
  });

  it("returns undefined when cancelled during the await", async () => {
    vi.useFakeTimers();
    const ct = cancellationToken();

    let resolve;
    const p = new Promise((r) => { resolve = r; });
    const wrapped = ct.wrap(p);

    // Cancel before the promise resolves
    ct.cancel();
    resolve("should be ignored");

    const result = await wrapped;
    expect(result).toBeUndefined();
    vi.useRealTimers();
  });

  it("returns undefined when called after cancel", async () => {
    const ct = cancellationToken();
    ct.cancel();
    const result = await ct.wrap(Promise.resolve("never"));
    expect(result).toBeUndefined();
  });

  it("handles promise rejection gracefully when cancelled", async () => {
    const ct = cancellationToken();
    ct.cancel();
    // Should not throw — the wrap short-circuits before awaiting
    const result = await ct.wrap(Promise.reject(new Error("should not throw")));
    expect(result).toBeUndefined();
  });

  it("preserves promise rejection when active and not cancelled", async () => {
    const ct = cancellationToken();
    await expect(
      ct.wrap(Promise.reject(new Error("actual fail"))),
    ).rejects.toThrow("actual fail");
  });
});

describe("cancellationToken — simulates effect re-run pattern", () => {
  it("second generation cancels the first", async () => {
    // Simulates: effect runs, dep changes, cleanup cancels token,
    // then new effect creates a new token.
    const gen1 = cancellationToken();
    const gen2 = cancellationToken();

    gen1.cancel(); // cleanup of first effect

    // First generation's in-flight op should be guarded
    const result = await gen1.wrap(Promise.resolve("stale"));
    expect(result).toBeUndefined();

    // Second generation's operations proceed normally
    const result2 = await gen2.wrap(Promise.resolve("fresh"));
    expect(result2).toBe("fresh");
  });

  it("multiple in-flight ops are all cancelled by a single cancel()", async () => {
    const ct = cancellationToken();
    const op1 = ct.wrap(Promise.resolve("a"));
    const op2 = ct.wrap(Promise.resolve("b"));

    ct.cancel();

    expect(await op1).toBeUndefined();
    expect(await op2).toBeUndefined();
  });

  it("checking active after cancel returns false (no stale closure)", () => {
    const ct = cancellationToken();
    ct.cancel();

    // This simulates an async callback that checks `ct.active`
    // after the effect has been torn down.
    expect(ct.active).toBe(false);
  });
});