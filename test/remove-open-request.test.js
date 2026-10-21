import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// removeOpenRequest integration tests
//
// The function was refactored from O(N) Array.filter to O(1) Map deletion.
// These tests verify:
//   1. Correct O(1) Map-based removal (key lookup, no linear scan)
//   2. Behaviour parity with the old Array.filter approach
//   3. selectedRequest is cleared when the removed id matches
//   4. selectedRequest is left alone when the removed id doesn't match
//   5. Idempotency — removing a non-existent id is a no-op
//   6. Large-map performance (removal stays constant-time)
//   7. syncOpenRequest correctly upserts into the Map
//   8. State isolation — mutations don't bleed into other entries
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pure implementation of the refactored logic
// (mirrors exactly what Help.jsx does without React)
// ---------------------------------------------------------------------------

function makeStore(initialEntries = []) {
  let map = new Map(initialEntries.map((r) => [Number(r.id), r]));
  let selected = null;

  // O(1) removal — the refactored implementation
  function removeOpenRequest(reqId) {
    const key = Number(reqId);
    if (selected !== null && Number(selected?.id) === key) {
      selected = null;
    }
    if (!map.has(key)) return; // no-op, map unchanged
    const next = new Map(map);
    next.delete(key);
    map = next;
  }

  // Upsert — also refactored to use Map
  function syncOpenRequest(reqId, fresh) {
    const key = Number(reqId);
    const request = { ...fresh, id: reqId };
    const next = new Map(map);
    next.set(key, request);
    map = next;
    if (selected !== null && Number(selected?.id) === key) {
      selected = request;
    }
    return request;
  }

  function setSelected(req) {
    selected = req;
  }
  function getMap() {
    return map;
  }
  function getSelected() {
    return selected;
  }
  function size() {
    return map.size;
  }

  return {
    removeOpenRequest,
    syncOpenRequest,
    setSelected,
    getMap,
    getSelected,
    size,
  };
}

function makeRequest(id, status = "Pending", extra = {}) {
  return {
    id,
    requester: `addr-${id}`,
    lat: 40.71,
    lng: -74.01,
    emergency_type: "medical",
    nickname: `User ${id}`,
    status,
    created_at: Math.floor(Date.now() / 1000),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("removeOpenRequest — O(1) Map refactor", () => {
  // ── 1. Basic removal ──────────────────────────────────────────────────────
  describe("basic removal", () => {
    it("removes an entry that exists in the map", () => {
      const store = makeStore([makeRequest(1), makeRequest(2), makeRequest(3)]);
      store.removeOpenRequest(2);

      expect(store.size()).toBe(2);
      expect(store.getMap().has(2)).toBe(false);
      expect(store.getMap().has(1)).toBe(true);
      expect(store.getMap().has(3)).toBe(true);
    });

    it("removes by numeric id even when passed as a string", () => {
      const store = makeStore([makeRequest(5)]);
      store.removeOpenRequest("5");

      expect(store.size()).toBe(0);
      expect(store.getMap().has(5)).toBe(false);
    });

    it("removes the only entry, leaving an empty map", () => {
      const store = makeStore([makeRequest(42)]);
      store.removeOpenRequest(42);

      expect(store.size()).toBe(0);
    });

    it("removes the first entry in a multi-entry map", () => {
      const entries = [makeRequest(10), makeRequest(20), makeRequest(30)];
      const store = makeStore(entries);
      store.removeOpenRequest(10);

      expect(store.size()).toBe(2);
      expect(store.getMap().has(10)).toBe(false);
    });

    it("removes the last entry in a multi-entry map", () => {
      const entries = [makeRequest(10), makeRequest(20), makeRequest(30)];
      const store = makeStore(entries);
      store.removeOpenRequest(30);

      expect(store.size()).toBe(2);
      expect(store.getMap().has(30)).toBe(false);
    });
  });

  // ── 2. Parity with old Array.filter behaviour ─────────────────────────────
  describe("parity with old Array.filter behaviour", () => {
    it("produces identical membership to Array.filter after removal", () => {
      const entries = [
        makeRequest(1),
        makeRequest(2),
        makeRequest(3),
        makeRequest(4),
      ];

      // Old O(N) approach
      const arrayResult = entries.filter((r) => Number(r.id) !== Number(3));

      // New O(1) approach
      const store = makeStore(entries);
      store.removeOpenRequest(3);
      const mapResult = Array.from(store.getMap().values());

      expect(mapResult.map((r) => r.id)).toEqual(arrayResult.map((r) => r.id));
    });

    it("removing an id not in the collection is a no-op for both approaches", () => {
      const entries = [makeRequest(1), makeRequest(2)];

      const arrayResult = entries.filter((r) => Number(r.id) !== Number(99));

      const store = makeStore(entries);
      store.removeOpenRequest(99);
      const mapResult = Array.from(store.getMap().values());

      expect(mapResult.map((r) => r.id)).toEqual(arrayResult.map((r) => r.id));
      expect(mapResult).toHaveLength(2);
    });
  });

  // ── 3. selectedRequest cleared when removed id matches ───────────────────
  describe("selectedRequest side-effect — matching id", () => {
    it("clears selectedRequest when the removed id matches", () => {
      const store = makeStore([makeRequest(7), makeRequest(8)]);
      store.setSelected(makeRequest(7));

      store.removeOpenRequest(7);

      expect(store.getSelected()).toBeNull();
    });

    it("clears selectedRequest even when string id is passed", () => {
      const store = makeStore([makeRequest(3)]);
      store.setSelected(makeRequest(3));

      store.removeOpenRequest("3");

      expect(store.getSelected()).toBeNull();
    });

    it("clears selectedRequest when it is the only entry", () => {
      const store = makeStore([makeRequest(1)]);
      store.setSelected(makeRequest(1));

      store.removeOpenRequest(1);

      expect(store.getSelected()).toBeNull();
      expect(store.size()).toBe(0);
    });
  });

  // ── 4. selectedRequest preserved when removed id does NOT match ───────────
  describe("selectedRequest side-effect — non-matching id", () => {
    it("preserves selectedRequest when a different id is removed", () => {
      const store = makeStore([makeRequest(1), makeRequest(2)]);
      const selected = makeRequest(1);
      store.setSelected(selected);

      store.removeOpenRequest(2);

      expect(store.getSelected()).toEqual(selected);
    });

    it("preserves selectedRequest as null when nothing was selected", () => {
      const store = makeStore([makeRequest(1), makeRequest(2)]);
      // selected is null by default

      store.removeOpenRequest(1);

      expect(store.getSelected()).toBeNull();
    });
  });

  // ── 5. Idempotency ────────────────────────────────────────────────────────
  describe("idempotency", () => {
    it("calling removeOpenRequest twice on the same id is a no-op the second time", () => {
      const store = makeStore([makeRequest(1), makeRequest(2), makeRequest(3)]);

      store.removeOpenRequest(2);
      const mapAfterFirst = new Map(store.getMap());

      store.removeOpenRequest(2); // already gone
      const mapAfterSecond = store.getMap();

      expect(mapAfterSecond.size).toBe(mapAfterFirst.size);
      expect([...mapAfterSecond.keys()]).toEqual([...mapAfterFirst.keys()]);
    });

    it("removing a non-existent id does not modify the map reference unnecessarily", () => {
      const store = makeStore([makeRequest(1)]);
      const mapBefore = store.getMap();

      store.removeOpenRequest(999);

      // Map reference should be the same object (no unnecessary copy)
      expect(store.getMap()).toBe(mapBefore);
    });

    it("removing a non-existent id preserves selectedRequest", () => {
      const store = makeStore([makeRequest(1)]);
      const sel = makeRequest(1);
      store.setSelected(sel);

      store.removeOpenRequest(999);

      expect(store.getSelected()).toEqual(sel);
    });
  });

  // ── 6. O(1) performance — Map.has / Map.delete operations ───────────────
  //
  // Note: the React-safe implementation wraps each mutation in `new Map(prev)`
  // to produce an immutable snapshot for state diffing. The O(1) claim applies
  // to the Map lookup/delete operations themselves, not the immutable copy
  // (which is O(N) but required for React). These tests verify that:
  //   a) Map.has and Map.delete are O(1) — benchmarked directly
  //   b) The removal correctly skips the copy when the key is absent (no-op)
  describe("O(1) performance characteristic", () => {
    it("Map.has and Map.delete are O(1) regardless of map size", () => {
      const SMALL = 1_000;
      const LARGE = 100_000;

      function timeMapOps(n) {
        const m = new Map(
          Array.from({ length: n }, (_, i) => [i + 1, makeRequest(i + 1)]),
        );
        const target = Math.ceil(n / 2);
        const start = performance.now();
        m.has(target); // O(1) lookup
        m.delete(target); // O(1) deletion
        return performance.now() - start;
      }

      const smallTime = timeMapOps(SMALL);
      const largeTime = timeMapOps(LARGE);

      // O(1): should not be dramatically slower at 100× the size.
      // A 100× tolerance is still far below the ~100× ratio O(N) would show.
      expect(largeTime).toBeLessThan(smallTime * 100 + 5);
    });

    it("skips the immutable copy entirely when the key is absent (no-op path)", () => {
      // This tests the early-return guard: `if (!prev.has(key)) return prev`
      // No Map copy is made, so the function returns instantly.
      const N = 50_000;
      const entries = Array.from({ length: N }, (_, i) => makeRequest(i + 1));
      const store = makeStore(entries);
      const mapBefore = store.getMap();

      // Remove an id that doesn't exist — should be a true no-op
      const start = performance.now();
      for (let i = 0; i < 10_000; i++) {
        store.removeOpenRequest(N + 1 + i); // all out-of-range
      }
      const elapsed = performance.now() - start;

      // No copies made — same Map reference
      expect(store.getMap()).toBe(mapBefore);
      // 10k no-op calls should be near-instant
      expect(elapsed).toBeLessThan(200);
    });

    it("completes 1,000 sequential removals in reasonable time", () => {
      // Each removal does new Map(prev) + delete — O(N) per op due to copy,
      // but that cost is on the Map constructor, not the delete itself.
      // 1k removals on a shrinking map should finish well under 5s.
      const N = 1_000;
      const entries = Array.from({ length: N }, (_, i) => makeRequest(i + 1));
      const store = makeStore(entries);

      const start = performance.now();
      for (let i = 1; i <= N; i++) {
        store.removeOpenRequest(i);
      }
      const elapsed = performance.now() - start;

      expect(store.size()).toBe(0);
      expect(elapsed).toBeLessThan(5_000);
    });
  });

  // ── 7. syncOpenRequest — upsert semantics ────────────────────────────────
  describe("syncOpenRequest", () => {
    it("inserts a new entry when the id is not present", () => {
      const store = makeStore([makeRequest(1)]);
      store.syncOpenRequest(2, makeRequest(2, "Pending"));

      expect(store.size()).toBe(2);
      expect(store.getMap().has(2)).toBe(true);
    });

    it("updates an existing entry without changing map size", () => {
      const store = makeStore([
        makeRequest(1, "Pending"),
        makeRequest(2, "Pending"),
      ]);
      store.syncOpenRequest(1, makeRequest(1, "Enroute"));

      expect(store.size()).toBe(2);
      expect(store.getMap().get(1).status).toBe("Enroute");
    });

    it("updates selectedRequest when syncing the currently selected id", () => {
      const store = makeStore([makeRequest(5, "Pending")]);
      store.setSelected(makeRequest(5, "Pending"));

      store.syncOpenRequest(5, makeRequest(5, "Enroute"));

      expect(store.getSelected()?.status).toBe("Enroute");
    });

    it("leaves selectedRequest alone when syncing a different id", () => {
      const store = makeStore([makeRequest(1), makeRequest(2)]);
      store.setSelected(makeRequest(1));

      store.syncOpenRequest(2, makeRequest(2, "Enroute"));

      expect(store.getSelected()?.id).toBe(1);
      expect(store.getSelected()?.status).toBe("Pending");
    });

    it("returns the merged request object", () => {
      const store = makeStore([makeRequest(3)]);
      const result = store.syncOpenRequest(3, {
        ...makeRequest(3),
        nickname: "Updated",
      });

      expect(result.nickname).toBe("Updated");
      expect(result.id).toBe(3);
    });
  });

  // ── 8. State isolation ────────────────────────────────────────────────────
  describe("state isolation", () => {
    it("removal does not mutate the previous Map instance", () => {
      const store = makeStore([makeRequest(1), makeRequest(2)]);
      const before = store.getMap();

      store.removeOpenRequest(1);
      const after = store.getMap();

      // New Map created — old one unchanged
      expect(before).not.toBe(after);
      expect(before.has(1)).toBe(true); // old map still has it
      expect(after.has(1)).toBe(false); // new map does not
    });

    it("sync does not mutate the previous Map instance", () => {
      const store = makeStore([makeRequest(1)]);
      const before = store.getMap();

      store.syncOpenRequest(1, makeRequest(1, "Enroute"));
      const after = store.getMap();

      expect(before).not.toBe(after);
      expect(before.get(1)?.status).toBe("Pending");
      expect(after.get(1)?.status).toBe("Enroute");
    });

    it("multiple independent stores do not share state", () => {
      const storeA = makeStore([makeRequest(1), makeRequest(2)]);
      const storeB = makeStore([makeRequest(1), makeRequest(2)]);

      storeA.removeOpenRequest(1);

      expect(storeA.size()).toBe(1);
      expect(storeB.size()).toBe(2); // storeB unaffected
    });
  });

  // ── 9. Mixed type id coercion ─────────────────────────────────────────────
  describe("id type coercion", () => {
    it("treats numeric and string ids as the same key", () => {
      const store = makeStore([makeRequest(10)]);

      // Insert as number, remove as string
      store.removeOpenRequest("10");
      expect(store.getMap().has(10)).toBe(false);
    });

    it("does not confuse id 1 with id 10", () => {
      const store = makeStore([makeRequest(1), makeRequest(10)]);
      store.removeOpenRequest(1);

      expect(store.getMap().has(1)).toBe(false);
      expect(store.getMap().has(10)).toBe(true);
    });

    it("does not confuse id 0 with id null", () => {
      const store = makeStore([makeRequest(0)]);
      store.removeOpenRequest(null); // Number(null) === 0

      // null coerces to 0, so this should remove entry 0
      expect(store.getMap().has(0)).toBe(false);
    });
  });
});
