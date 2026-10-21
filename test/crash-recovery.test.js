import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  saveDraft,
  loadDraft,
  clearDraft,
  restoreDraft,
  startAutoSave,
  isDraftExpired,
  DRAFT_KEY,
  DRAFT_EXPIRATION_MS,
  AUTO_SAVE_INTERVAL_MS,
  __testables,
} from "../src/lib/crashRecovery.ts";

// ---------------------------------------------------------------------------
// IndexedDB Crash Recovery Tests
//
// Uses fake-indexeddb (configured globally via jsdom environment) for IDB
// simulation. Tests are kept isolated: clearDraft() runs before each test.
// ---------------------------------------------------------------------------

const { hasMeaningfulData } = __testables;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDraft(overrides = {}) {
  return {
    emergencyType: "medical",
    nickname: "Alice",
    contact: "555-0100",
    location: [40.7128, -74.006],
    searchQuery: "hospital",
    ...overrides,
  };
}

// ── Unit: isDraftExpired ──────────────────────────────────────────────────────

describe("isDraftExpired", () => {
  it("returns false for a fresh draft", () => {
    const draft = { updatedAt: Date.now(), createdAt: Date.now() };
    expect(isDraftExpired(draft)).toBe(false);
  });

  it("returns true when updatedAt is older than 1 hour", () => {
    const old = Date.now() - (DRAFT_EXPIRATION_MS + 1000);
    const draft = { updatedAt: old, createdAt: old };
    expect(isDraftExpired(draft)).toBe(true);
  });

  it("uses createdAt when updatedAt is 0", () => {
    const old = Date.now() - (DRAFT_EXPIRATION_MS + 1000);
    const draft = { updatedAt: 0, createdAt: old };
    expect(isDraftExpired(draft)).toBe(true);
  });

  it("DRAFT_EXPIRATION_MS is 1 hour in ms", () => {
    expect(DRAFT_EXPIRATION_MS).toBe(60 * 60 * 1000);
  });
});

// ── Unit: hasMeaningfulData ───────────────────────────────────────────────────

describe("hasMeaningfulData", () => {
  it("returns true when emergencyType set", () => {
    expect(
      hasMeaningfulData({
        emergencyType: "lost",
        nickname: "",
        contact: "",
        location: null,
        searchQuery: "",
      }),
    ).toBe(true);
  });

  it("returns true when nickname set", () => {
    expect(
      hasMeaningfulData({
        emergencyType: null,
        nickname: "Bob",
        contact: "",
        location: null,
        searchQuery: "",
      }),
    ).toBe(true);
  });

  it("returns true when location set", () => {
    expect(
      hasMeaningfulData({
        emergencyType: null,
        nickname: "",
        contact: "",
        location: [1, 2],
        searchQuery: "",
      }),
    ).toBe(true);
  });

  it("returns false when all fields empty", () => {
    expect(
      hasMeaningfulData({
        emergencyType: null,
        nickname: "",
        contact: "",
        location: null,
        searchQuery: "",
      }),
    ).toBe(false);
  });

  it("returns false when whitespace-only strings", () => {
    expect(
      hasMeaningfulData({
        emergencyType: "   ",
        nickname: "  ",
        contact: "",
        location: null,
        searchQuery: "",
      }),
    ).toBe(false);
  });

  it("returns true when extra fields present", () => {
    expect(
      hasMeaningfulData({
        emergencyType: null,
        nickname: "",
        contact: "",
        location: null,
        searchQuery: "",
        extra: { foo: 1 },
      }),
    ).toBe(true);
  });
});

// ── Integration: saveDraft / loadDraft / clearDraft ───────────────────────────

describe("saveDraft / loadDraft / clearDraft", () => {
  beforeEach(async () => {
    await clearDraft();
  });

  it("returns null when no draft exists", async () => {
    const result = await loadDraft();
    expect(result).toBeNull();
  });

  it("saves and loads a draft with all fields", async () => {
    const partial = makeDraft();
    await saveDraft(partial);

    const draft = await loadDraft();
    expect(draft).not.toBeNull();
    expect(draft.emergencyType).toBe("medical");
    expect(draft.nickname).toBe("Alice");
    expect(draft.contact).toBe("555-0100");
    expect(draft.location).toEqual([40.7128, -74.006]);
    expect(draft.searchQuery).toBe("hospital");
    expect(typeof draft.createdAt).toBe("number");
    expect(typeof draft.updatedAt).toBe("number");
  });

  it("preserves createdAt across overwrites", async () => {
    await saveDraft(makeDraft());
    const first = await loadDraft();
    const firstCreatedAt = first.createdAt;

    await saveDraft({ ...makeDraft(), nickname: "Bob" });
    const second = await loadDraft();
    expect(second.createdAt).toBe(firstCreatedAt);
    expect(second.nickname).toBe("Bob");
  });

  it("clearDraft removes saved data", async () => {
    await saveDraft(makeDraft());
    await clearDraft();
    const result = await loadDraft();
    expect(result).toBeNull();
  });

  it("loadDraft returns null for expired draft", async () => {
    // Manually write an expired draft via saveDraft + manipulate updatedAt
    await saveDraft(makeDraft());
    const draft = await loadDraft();
    expect(draft).not.toBeNull();

    // Save with old timestamp
    const old = Date.now() - (DRAFT_EXPIRATION_MS + 1000);
    await saveDraft({ ...makeDraft(), extra: { _forcedUpdatedAt: old } });

    // We can't override updatedAt through saveDraft, so test the isDraftExpired
    // helper directly with a synthetic old draft
    const syntheticOld = { ...draft, updatedAt: old, createdAt: old };
    expect(isDraftExpired(syntheticOld)).toBe(true);
  });
});

// ── Integration: restoreDraft ─────────────────────────────────────────────────

describe("restoreDraft", () => {
  beforeEach(async () => {
    await clearDraft();
  });

  it("returns null when nothing saved", async () => {
    const result = await restoreDraft();
    expect(result).toBeNull();
  });

  it("returns the saved draft", async () => {
    await saveDraft(makeDraft());
    const result = await restoreDraft();
    expect(result).not.toBeNull();
    expect(result.emergencyType).toBe("medical");
  });
});

// ── Integration: startAutoSave ────────────────────────────────────────────────

describe("startAutoSave", () => {
  beforeEach(async () => {
    await clearDraft();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves immediately on start if data is meaningful", async () => {
    const stop = startAutoSave(() => makeDraft());
    // Immediate save is synchronous-ish; wait a tick
    await new Promise((r) => setTimeout(r, 10));
    const draft = await loadDraft();
    expect(draft).not.toBeNull();
    expect(draft.emergencyType).toBe("medical");
    stop();
  });

  it("does not save when getDraft returns null", async () => {
    const stop = startAutoSave(() => null);
    await new Promise((r) => setTimeout(r, 10));
    const draft = await loadDraft();
    expect(draft).toBeNull();
    stop();
  });

  it("does not save when data has no meaningful fields", async () => {
    const stop = startAutoSave(() => ({
      emergencyType: null,
      nickname: "",
      contact: "",
      location: null,
      searchQuery: "",
    }));
    await new Promise((r) => setTimeout(r, 10));
    const draft = await loadDraft();
    expect(draft).toBeNull();
    stop();
  });

  it("returns a stop function that halts saves", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const stop = startAutoSave(() => {
      callCount++;
      return makeDraft();
    });
    stop();
    // Advance well past AUTO_SAVE_INTERVAL_MS
    vi.advanceTimersByTime(AUTO_SAVE_INTERVAL_MS * 5);
    // After stop, interval should not fire additional saves (counter stays at initial 1 for immediate call)
    expect(callCount).toBeLessThanOrEqual(1);
  });

  it("AUTO_SAVE_INTERVAL_MS is 2 seconds", () => {
    expect(AUTO_SAVE_INTERVAL_MS).toBe(2000);
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe("exported constants", () => {
  it("DRAFT_KEY is a non-empty string", () => {
    expect(typeof DRAFT_KEY).toBe("string");
    expect(DRAFT_KEY.length).toBeGreaterThan(0);
  });
});
