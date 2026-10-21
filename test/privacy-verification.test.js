import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// #529 — client mirror of the aegis_vault differential-privacy zone policy
// (contracts/aegis_vault/src/privacy.rs). The vectors below are the same ones
// the Rust tests use, so the two implementations cannot silently drift apart.
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

import { nativeToScVal, StrKey } from "@stellar/stellar-sdk";
import {
  DEFAULT_ZONE_PRIVACY,
  MAX_X,
  MAX_Y,
  alignZone,
  buildPrivateLocationProofZone,
  checkOverlap,
  laplaceScale,
  minBoxDimension,
  validateParams,
  validateZone,
  violationFromVaultError,
} from "../src/lib/privacy.js";
import { buildLocationProofZone } from "../src/lib/zk.js";

const ON = { ...DEFAULT_ZONE_PRIVACY, enabled: true };
const MIN = 300_000n; // default: b = 100_000, t = 3

const box = (xMin, xMax, yMin, yMax) => ({
  boxXMin: String(xMin),
  boxXMax: String(xMax),
  boxYMin: String(yMin),
  boxYMax: String(yMax),
});
const square = (x, y, side) => box(x, x + side, y, y + side);

describe("Laplace bound", () => {
  it("scale is sensitivity over epsilon", () => {
    expect(laplaceScale(ON)).toBe(100_000n);
    expect(laplaceScale({ ...ON, epsilonMilli: 500 })).toBe(200_000n); // smaller epsilon, more noise
    expect(laplaceScale({ ...ON, epsilonMilli: 100 })).toBe(1_000_000n);
  });

  it("rounds up, never down", () => {
    expect(laplaceScale({ ...ON, sensitivity: 10, epsilonMilli: 3_000 })).toBe(4n); // 3.33 -> 4
  });

  it("has no scale without epsilon", () => {
    expect(laplaceScale({ ...ON, epsilonMilli: 0 })).toBeNull();
    expect(minBoxDimension({ ...ON, epsilonMilli: 0 })).toBeNull();
    expect(minBoxDimension({ ...ON, grid: 0 })).toBeNull();
  });

  it("minimum side is b * t rounded up to the grid", () => {
    expect(minBoxDimension(ON)).toBe(MIN);
    expect(minBoxDimension({ ...ON, sensitivity: 100_001 })).toBe(310_000n); // 300_003 -> next 10_000
  });

  it("stronger privacy demands a bigger box", () => {
    expect(minBoxDimension({ ...ON, epsilonMilli: 250 })).toBeGreaterThan(minBoxDimension(ON));
  });

  it("stays exact where the intermediate product passes 2^53", () => {
    // sensitivity * 1000 = 9_007_199_254_741_000 > Number.MAX_SAFE_INTEGER.
    const sensitivity = 9_007_199_254_741;
    expect(sensitivity * 1000).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(laplaceScale({ ...ON, sensitivity })).toBe(9_007_199_254_741n);
  });
});

describe("validateParams", () => {
  it("accepts the defaults and rejects what the contract rejects", () => {
    expect(validateParams(ON)).toEqual({ ok: true });
    for (const bad of [
      { ...ON, epsilonMilli: 0 },
      { ...ON, sensitivity: 0 },
      { ...ON, tailMult: 0 },
      { ...ON, grid: 0 },
      { ...ON, kCells: 0 },
      { ...ON, sensitivity: Number(MAX_Y) }, // minimum box larger than the map
    ]) {
      expect(validateParams(bad)).toEqual({ ok: false, error: "invalid_params" });
    }
  });
});

describe("validateZone (same vectors as privacy.rs)", () => {
  it("accepts a box at exactly the bound", () => {
    expect(validateZone(box(0, 300_000, 0, 300_000), ON)).toEqual({ ok: true });
    expect(validateZone(box(1_000_000, 4_000_000, 2_000_000, 2_300_000), ON)).toEqual({ ok: true });
  });

  it("rejects a box one cell under the bound on either axis", () => {
    expect(validateZone(box(0, 290_000, 0, 300_000), ON)).toEqual({ ok: false, error: "too_small" });
    expect(validateZone(box(0, 300_000, 0, 290_000), ON)).toEqual({ ok: false, error: "too_small" });
  });

  it("requires edges on the grid", () => {
    for (const b of [
      box(1, 300_001, 0, 300_000),
      box(0, 300_000, 5, 300_005),
      box(0, 300_001, 0, 300_000),
      box(0, 300_000, 0, 300_500),
    ]) {
      expect(validateZone(b, ON)).toEqual({ ok: false, error: "not_on_grid" });
    }
  });

  it("rejects malformed boxes", () => {
    for (const b of [
      box(300_000, 0, 0, 300_000), // inverted x
      box(0, 300_000, 300_000, 0), // inverted y
      box(100_000, 100_000, 0, 300_000), // zero width
      box(0, 300_000, 200_000, 200_000), // zero height
      box(0, MAX_X + 10_000n, 0, 300_000), // beyond longitude range
      box(0, 300_000, 0, MAX_Y + 10_000n), // beyond latitude range
      box(-10_000, 300_000, 0, 300_000), // negative
      { boxXMin: "abc", boxXMax: "1", boxYMin: "0", boxYMax: "1" },
    ]) {
      expect(validateZone(b, ON)).toEqual({ ok: false, error: "malformed" });
    }
  });

  it("accepts the whole map", () => {
    expect(validateZone(box(0, MAX_X, 0, MAX_Y), ON)).toEqual({ ok: true });
  });

  it("reports invalid parameters before looking at the box", () => {
    expect(validateZone(square(0, 0, 300_000), { ...ON, epsilonMilli: 0 })).toEqual({
      ok: false,
      error: "invalid_params",
    });
  });
});

describe("checkOverlap (spatial k-anonymity)", () => {
  const a = square(1_000_000, 1_000_000, 1_000_000);

  it("never objects to disjoint zones", () => {
    expect(checkOverlap(a, square(5_000_000, 5_000_000, 1_000_000), ON)).toEqual({ ok: true });
  });

  it("allows a generous overlap, symmetrically", () => {
    const b = square(1_500_000, 1_500_000, 1_000_000); // 500_000 x 500_000
    expect(checkOverlap(a, b, ON)).toEqual({ ok: true });
    expect(checkOverlap(b, a, ON)).toEqual({ ok: true });
  });

  it("rejects a sliver that would pin a location to a narrow strip", () => {
    const sliver = square(1_990_000, 1_000_000, 1_000_000); // 10_000 wide overlap
    expect(checkOverlap(a, sliver, ON)).toEqual({ ok: false, error: "overlap_too_small" });
    expect(checkOverlap(sliver, a, ON)).toEqual({ ok: false, error: "overlap_too_small" });
  });

  it("rejects zones that only touch, because closed boxes share the edge", () => {
    expect(checkOverlap(a, square(2_000_000, 1_000_000, 1_000_000), ON)).toEqual({
      ok: false,
      error: "overlap_too_small",
    });
    expect(checkOverlap(a, square(2_000_000, 2_000_000, 1_000_000), ON)).toEqual({
      ok: false,
      error: "overlap_too_small",
    });
  });

  it("enforces the k-cell floor even when each side is long enough", () => {
    const strict = { ...ON, kCells: 1_000 };
    const b = square(1_700_000, 1_700_000, 1_000_000); // 30 x 30 = 900 cells
    expect(checkOverlap(a, b, strict)).toEqual({ ok: false, error: "overlap_too_small" });
    expect(checkOverlap(a, b, ON)).toEqual({ ok: true });
  });

  it("allows identical zones", () => {
    expect(checkOverlap(a, a, ON)).toEqual({ ok: true });
  });
});

describe("alignZone", () => {
  it("snaps outward to the grid and never shrinks the region", () => {
    const raw = box(1_234_567, 1_934_567, 2_222_222, 2_922_222);
    const out = alignZone(raw, ON);
    expect(validateZone(out, ON)).toEqual({ ok: true });
    expect(BigInt(out.boxXMin)).toBeLessThanOrEqual(BigInt(raw.boxXMin));
    expect(BigInt(out.boxXMax)).toBeGreaterThanOrEqual(BigInt(raw.boxXMax));
    expect(BigInt(out.boxYMin)).toBeLessThanOrEqual(BigInt(raw.boxYMin));
    expect(BigInt(out.boxYMax)).toBeGreaterThanOrEqual(BigInt(raw.boxYMax));
  });

  it("leaves an already-valid box unchanged", () => {
    const good = square(1_000_000, 2_000_000, 500_000);
    expect(alignZone(good, ON)).toEqual(good);
  });

  it("widens a too-small box to the Laplace bound around the same centre", () => {
    const out = alignZone(box(5_000_000, 5_010_000, 6_000_000, 6_010_000), ON);
    expect(validateZone(out, ON)).toEqual({ ok: true });
    expect(BigInt(out.boxXMax) - BigInt(out.boxXMin)).toBeGreaterThanOrEqual(MIN);
    expect(BigInt(out.boxXMin)).toBeLessThan(5_000_000n);
    expect(BigInt(out.boxXMax)).toBeGreaterThan(5_010_000n);
  });

  it("shifts instead of shrinking at the edge of the map", () => {
    const corner = alignZone(box(0, 10_000, 0, 10_000), ON);
    expect(corner).toEqual(square(0, 0, Number(MIN)));
    const far = alignZone(box(MAX_X - 10_000n, MAX_X, MAX_Y - 10_000n, MAX_Y), ON);
    expect(validateZone(far, ON)).toEqual({ ok: true });
    expect(BigInt(far.boxXMax)).toBe(MAX_X);
    expect(BigInt(far.boxYMax)).toBe(MAX_Y);
  });

  it("always produces a valid box for any point on the map (property check)", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 500; i++) {
      const x = Math.floor(rnd() * Number(MAX_X));
      const y = Math.floor(rnd() * Number(MAX_Y));
      const w = Math.floor(rnd() * 2_000_000) + 1;
      const h = Math.floor(rnd() * 2_000_000) + 1;
      const raw = box(x, Math.min(x + w, Number(MAX_X)), y, Math.min(y + h, Number(MAX_Y)));
      const out = alignZone(raw, ON);
      expect(out, JSON.stringify(raw)).not.toBeNull();
      expect(validateZone(out, ON), JSON.stringify(raw)).toEqual({ ok: true });
    }
  });

  it("returns null when no valid box exists", () => {
    expect(alignZone(square(0, 0, 300_000), { ...ON, epsilonMilli: 0 })).toBeNull();
    expect(alignZone(box(300_000, 0, 0, 300_000), ON)).toBeNull(); // inverted
    expect(alignZone({ boxXMin: "x", boxXMax: "1", boxYMin: "0", boxYMax: "1" }, ON)).toBeNull();
  });
});

describe("buildPrivateLocationProofZone", () => {
  it("returns a policy-compliant zone where the plain builder would not", () => {
    const plain = buildLocationProofZone({ lat: 6.5244, lng: 3.3792, radiusMeters: 250 });
    expect(validateZone(plain, ON).ok).toBe(false); // off-grid and far too fine

    const priv = buildPrivateLocationProofZone({ lat: 6.5244, lng: 3.3792, privacy: ON, radiusMeters: 250 });
    expect(validateZone(priv, ON)).toEqual({ ok: true });
    expect(priv.center).toEqual({ lat: 6.5244, lng: 3.3792 });
    // Still contains the original region.
    expect(BigInt(priv.boxXMin)).toBeLessThanOrEqual(BigInt(plain.boxXMin));
    expect(BigInt(priv.boxXMax)).toBeGreaterThanOrEqual(BigInt(plain.boxXMax));
  });

  it("refuses when the parameters cannot be satisfied", () => {
    expect(() =>
      buildPrivateLocationProofZone({ lat: 0, lng: 0, privacy: { ...ON, epsilonMilli: 0 } }),
    ).toThrow(/privacy parameters/);
  });
});

describe("violationFromVaultError", () => {
  it("maps the contract's error numbers", () => {
    expect(violationFromVaultError(13)).toBe("invalid_params");
    expect(violationFromVaultError(14)).toBe("malformed");
    expect(violationFromVaultError(15)).toBe("not_on_grid");
    expect(violationFromVaultError(16)).toBe("too_small");
    expect(violationFromVaultError(17)).toBe("overlap_too_small");
    expect(violationFromVaultError(3)).toBeNull();
  });
});

describe("getZonePrivacyPolicy (contract.js)", () => {
  const VAULT = StrKey.encodeContract(Buffer.alloc(32, 7));
  const fnName = (tx) => tx.operations[0].func.invokeContract().functionName().toString();

  beforeEach(() => {
    vi.resetModules();
    state.servers.length = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns null when no vault is configured", async () => {
    vi.stubEnv("VITE_AEGIS_VAULT_ID", "");
    const { getZonePrivacyPolicy } = await import("../src/lib/contract.js");
    await expect(getZonePrivacyPolicy()).resolves.toBeNull();
  });

  it("reads the parameters and the derived minimum box", async () => {
    vi.stubEnv("VITE_AEGIS_VAULT_ID", VAULT);
    const { getZonePrivacyPolicy } = await import("../src/lib/contract.js");
    const server = state.servers.at(-1);
    server.simulateTransaction.mockImplementation(async (tx) => {
      const name = fnName(tx);
      if (name === "privacy_params") {
        return {
          result: {
            retval: nativeToScVal(
              { enabled: true, epsilon_milli: 500, sensitivity: 100_000n, tail_mult: 3, grid: 10_000n, k_cells: 25 },
              {
                type: {
                  enabled: ["symbol", "bool"],
                  epsilon_milli: ["symbol", "u32"],
                  sensitivity: ["symbol", "u64"],
                  tail_mult: ["symbol", "u32"],
                  grid: ["symbol", "u64"],
                  k_cells: ["symbol", "u32"],
                },
              },
            ),
          },
        };
      }
      if (name === "min_box_dimension") return { result: { retval: nativeToScVal(600_000n, { type: "u64" }) } };
      throw new Error(`unexpected call ${name}`);
    });

    await expect(getZonePrivacyPolicy()).resolves.toEqual({
      enabled: true,
      epsilonMilli: 500,
      sensitivity: 100_000,
      tailMult: 3,
      grid: 10_000,
      kCells: 25,
      minBoxDimension: 600_000,
    });
    // The JS mirror agrees with the contract's own answer.
    expect(minBoxDimension({ ...ON, epsilonMilli: 500 })).toBe(600_000n);
  });
});
