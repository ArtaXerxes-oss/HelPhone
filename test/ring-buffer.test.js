import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// #531 — client view of the contract's bounded verification history (ring
// buffer, capacity 500 per wallet). The pure window math is tested directly;
// the contract.js wrapper is tested with only the RPC round-trip faked, the
// same way test/contract-functions.test.js does it.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({ servers: [] }));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal();
  class Server {
    constructor() {
      this.simulateTransaction = vi.fn();
      state.servers.push(this);
    }
  }
  return { ...actual, rpc: { ...actual.rpc, Server } };
});

import { nativeToScVal } from "@stellar/stellar-sdk";
import { getExpertVerificationWindow } from "../src/lib/contract.js";
import { isRetained, recentIndexes, verificationWindow } from "../src/lib/ringBuffer.js";

const CAP = 500;

describe("verificationWindow", () => {
  it("is empty for a wallet with no history", () => {
    expect(verificationWindow(0, CAP)).toEqual({
      total: 0,
      capacity: CAP,
      oldest: 0,
      retained: 0,
      evicted: 0,
    });
  });

  it("retains everything up to capacity", () => {
    expect(verificationWindow(CAP, CAP)).toMatchObject({ oldest: 0, retained: CAP, evicted: 0 });
    expect(verificationWindow(3, CAP)).toMatchObject({ oldest: 0, retained: 3, evicted: 0 });
  });

  it("evicts the oldest entries once over capacity", () => {
    expect(verificationWindow(CAP + 1, CAP)).toMatchObject({ oldest: 1, retained: CAP, evicted: 1 });
    expect(verificationWindow(1237, CAP)).toMatchObject({ oldest: 737, retained: CAP, evicted: 737 });
  });

  it("never reports more retained than capacity, however far it wraps", () => {
    for (const total of [CAP, CAP + 1, CAP * 2, CAP * 7 + 13]) {
      const w = verificationWindow(total, CAP);
      expect(w.retained).toBeLessThanOrEqual(CAP);
      expect(w.retained + w.evicted).toBe(w.total);
    }
  });

  it("treats garbage as zero instead of producing NaN", () => {
    expect(verificationWindow(undefined, undefined)).toMatchObject({ total: 0, capacity: 0, oldest: 0 });
    expect(verificationWindow("abc", CAP)).toMatchObject({ total: 0, oldest: 0 });
    expect(verificationWindow(-4, CAP).total).toBe(0);
    expect(verificationWindow(12.9, CAP).total).toBe(12);
  });

  it("accepts numeric strings and bigints from the RPC layer", () => {
    expect(verificationWindow("510", "500")).toMatchObject({ total: 510, oldest: 10 });
    expect(verificationWindow(510n, 500n)).toMatchObject({ total: 510, oldest: 10 });
  });
});

describe("isRetained", () => {
  const w = verificationWindow(CAP + 25, CAP); // indexes 25..524 are readable

  it("is true only inside [oldest, total)", () => {
    expect(isRetained(w, 24)).toBe(false);
    expect(isRetained(w, 25)).toBe(true);
    expect(isRetained(w, 524)).toBe(true);
    expect(isRetained(w, 525)).toBe(false);
  });

  it("rejects non-integers and negatives", () => {
    expect(isRetained(w, -1)).toBe(false);
    expect(isRetained(w, 30.5)).toBe(false);
    expect(isRetained(w, Number.NaN)).toBe(false);
  });

  it("finds nothing in an empty window", () => {
    expect(isRetained(verificationWindow(0, CAP), 0)).toBe(false);
  });
});

describe("recentIndexes", () => {
  it("lists the newest entries first", () => {
    expect(recentIndexes(verificationWindow(10, CAP), 3)).toEqual([9, 8, 7]);
  });

  it("never asks for evicted entries", () => {
    const w = verificationWindow(CAP + 2, CAP); // oldest = 2
    const all = recentIndexes(w, 10_000);
    expect(all).toHaveLength(CAP);
    expect(all[0]).toBe(CAP + 1);
    expect(all.at(-1)).toBe(2);
    expect(all.every((i) => isRetained(w, i))).toBe(true);
  });

  it("returns nothing for an empty history or a non-positive limit", () => {
    expect(recentIndexes(verificationWindow(0, CAP), 5)).toEqual([]);
    expect(recentIndexes(verificationWindow(5, CAP), 0)).toEqual([]);
    expect(recentIndexes(verificationWindow(5, CAP), -3)).toEqual([]);
    expect(recentIndexes(verificationWindow(5, CAP), Number.NaN)).toEqual([]);
  });
});

describe("getExpertVerificationWindow (contract.js)", () => {
  const WALLET = "GB6Q7N7EHW5H6HZKAIIO4R2VTB7JEBX5XN4FOXXT6YTDA36Z7ALA656J";
  const fnName = (tx) => tx.operations[0].func.invokeContract().functionName().toString();

  beforeEach(() => {
    vi.clearAllMocks();
    // The read cache is keyed by wallet+time; move past any earlier entry.
    vi.setSystemTime(Date.now() + 10_000);
  });

  it("reads the lifetime total and capacity and derives the window", async () => {
    const server = state.servers.at(-1);
    server.simulateTransaction.mockImplementation(async (tx) => {
      const name = fnName(tx);
      if (name === "get_expert_verification_count") return { result: { retval: nativeToScVal(612, { type: "u32" }) } };
      if (name === "get_expert_verification_capacity") return { result: { retval: nativeToScVal(500, { type: "u32" }) } };
      throw new Error(`unexpected call ${name}`);
    });

    await expect(getExpertVerificationWindow(WALLET)).resolves.toEqual({
      total: 612,
      capacity: 500,
      oldest: 112,
      retained: 500,
      evicted: 112,
    });
    expect(server.simulateTransaction).toHaveBeenCalledTimes(2);
  });

  it("returns null without asking the contract when there is no wallet", async () => {
    const server = state.servers.at(-1);
    await expect(getExpertVerificationWindow("")).resolves.toBeNull();
    await expect(getExpertVerificationWindow(undefined)).resolves.toBeNull();
    expect(server.simulateTransaction).not.toHaveBeenCalled();
  });

  it("treats an empty simulation result as zero", async () => {
    const server = state.servers.at(-1);
    server.simulateTransaction.mockResolvedValue({});
    await expect(getExpertVerificationWindow(WALLET)).resolves.toMatchObject({
      total: 0,
      retained: 0,
    });
  });
});
