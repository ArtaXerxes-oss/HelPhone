import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDebouncedSetter } from "../src/pages/Help.jsx";

// ---------------------------------------------------------------------------
// createDebouncedSetter tests
//
// Verifies that the debounce helper correctly batches rapid invocations so
// that high-frequency wallet STATE_UPDATED events do not flood React's
// rendering pipeline and block the main thread.
// ---------------------------------------------------------------------------

describe("createDebouncedSetter — timing and batching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("delays calling the setter until the delay has elapsed", () => {
    const setter = vi.fn();
    const { debouncedSet } = createDebouncedSetter(setter, 100);

    debouncedSet("a");
    expect(setter).not.toHaveBeenCalled();

    vi.advanceTimersByTime(99);
    expect(setter).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith("a");
  });

  it("only calls the setter once for rapid invocations", () => {
    const setter = vi.fn();
    const { debouncedSet } = createDebouncedSetter(setter, 100);

    debouncedSet("a");
    debouncedSet("b");
    debouncedSet("c");

    vi.advanceTimersByTime(100);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith("c");
  });

  it("resets the debounce timer on each new invocation", () => {
    const setter = vi.fn();
    const { debouncedSet } = createDebouncedSetter(setter, 100);

    debouncedSet("a");
    vi.advanceTimersByTime(50);

    debouncedSet("b");
    vi.advanceTimersByTime(50);

    // Should not have fired yet — timer was reset at t=50
    expect(setter).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith("b");
  });

  it("passes the latest value to the setter after multiple rapid calls", () => {
    const setter = vi.fn();
    const { debouncedSet } = createDebouncedSetter(setter, 100);

    debouncedSet("v1");
    debouncedSet("v2");
    vi.advanceTimersByTime(100);
    expect(setter).toHaveBeenCalledWith("v2");

    debouncedSet("v3");
    vi.advanceTimersByTime(100);
    expect(setter).toHaveBeenCalledWith("v3");
    expect(setter).toHaveBeenCalledTimes(2);
  });
});

describe("createDebouncedSetter — flush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("flush() immediately calls the setter with the latest pending value", () => {
    const setter = vi.fn();
    const { debouncedSet, flush } = createDebouncedSetter(setter, 100);

    debouncedSet("urgent");
    flush();

    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith("urgent");
  });

  it("flush() is idempotent when called twice in a row", () => {
    const setter = vi.fn();
    const { debouncedSet, flush } = createDebouncedSetter(setter, 100);

    debouncedSet("x");
    flush();
    flush();

    expect(setter).toHaveBeenCalledTimes(1);
  });

  it("flush() does nothing when there is no pending value", () => {
    const setter = vi.fn();
    const { flush } = createDebouncedSetter(setter, 100);

    flush();
    expect(setter).not.toHaveBeenCalled();
  });

  it("flush() clears the pending timer so a delayed fire does not occur", () => {
    const setter = vi.fn();
    const { debouncedSet, flush } = createDebouncedSetter(setter, 100);

    debouncedSet("value");
    flush();

    // Advance past the original delay — no second call
    vi.advanceTimersByTime(100);
    expect(setter).toHaveBeenCalledTimes(1);
  });
});

describe("createDebouncedSetter — cancel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("cancel() prevents the pending timer from firing", () => {
    const setter = vi.fn();
    const { debouncedSet, cancel } = createDebouncedSetter(setter, 100);

    debouncedSet("doomed");
    cancel();
    vi.advanceTimersByTime(100);

    expect(setter).not.toHaveBeenCalled();
  });

  it("cancel() is a no-op when there is no pending timer", () => {
    const setter = vi.fn();
    const { cancel } = createDebouncedSetter(setter, 100);

    expect(() => cancel()).not.toThrow();
    expect(setter).not.toHaveBeenCalled();
  });

  it("calling cancel() then debouncedSet() starts a fresh timer", () => {
    const setter = vi.fn();
    const { debouncedSet, cancel } = createDebouncedSetter(setter, 100);

    debouncedSet("old");
    cancel();

    debouncedSet("new");
    vi.advanceTimersByTime(100);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith("new");
  });
});

describe("createDebouncedSetter — edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("works with a custom delay", () => {
    const setter = vi.fn();
    const { debouncedSet } = createDebouncedSetter(setter, 250);

    debouncedSet("a");
    vi.advanceTimersByTime(249);
    expect(setter).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(setter).toHaveBeenCalledWith("a");
  });

  it("handles setter throwing without breaking subsequent calls", () => {
    const setter = vi.fn().mockImplementationOnce(() => {
      throw new Error("first call fails");
    });
    const { debouncedSet, flush } = createDebouncedSetter(setter, 100);

    debouncedSet("failing");
    expect(() => flush()).toThrow("first call fails");

    debouncedSet("recovery");
    flush();
    expect(setter).toHaveBeenCalledTimes(2);
    expect(setter).toHaveBeenLastCalledWith("recovery");
  });

  it("supplies an empty string setter (no-op gracefully)", () => {
    const setter = vi.fn();
    const { debouncedSet, flush, cancel } = createDebouncedSetter(setter, 100);

    debouncedSet("");
    flush();
    expect(setter).toHaveBeenCalledWith("");

    cancel();
  });

  it("maintains independent state across instances", () => {
    const setterA = vi.fn();
    const setterB = vi.fn();
    const a = createDebouncedSetter(setterA, 100);
    const b = createDebouncedSetter(setterB, 100);

    a.debouncedSet("only-a");
    b.debouncedSet("only-b");

    a.flush();
    expect(setterA).toHaveBeenCalledWith("only-a");
    expect(setterB).not.toHaveBeenCalled();

    b.flush();
    expect(setterB).toHaveBeenCalledWith("only-b");
  });
});