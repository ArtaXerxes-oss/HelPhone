import { describe, it, expect } from "vitest";
import { computeWalletStatus } from "../src/pages/Help.jsx";

// ---------------------------------------------------------------------------
// computeWalletStatus tests
//
// Verifies the parallel-validation helper that independently re-validates
// wallet addresses at render time (defence in depth) and produces a safe,
// truncated display string.
// ---------------------------------------------------------------------------

const VALID_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3";
const VALID_ADDR_2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC";

// ── Connected: valid addresses ──────────────────────────────────────────────
describe("computeWalletStatus — connected (valid G-address)", () => {
  it("returns isConnected=true for a valid G-address", () => {
    const { isConnected } = computeWalletStatus(VALID_ADDR);
    expect(isConnected).toBe(true);
  });

  it("returns a truncated displayAddress for a valid address", () => {
    const { displayAddress } = computeWalletStatus(VALID_ADDR);
    expect(displayAddress).toBe(
      `${VALID_ADDR.slice(0, 8)}...${VALID_ADDR.slice(-6)}`,
    );
  });

  it("displayAddress is shorter than the full address", () => {
    const { displayAddress } = computeWalletStatus(VALID_ADDR);
    expect(displayAddress.length).toBeLessThan(VALID_ADDR.length);
    expect(displayAddress).toContain("...");
  });

  it("works with a second valid address", () => {
    const { isConnected } = computeWalletStatus(VALID_ADDR_2);
    expect(isConnected).toBe(true);
  });
});

// ── Disconnected: empty / falsy inputs ──────────────────────────────────────
describe("computeWalletStatus — disconnected (empty / falsy)", () => {
  it("returns isConnected=false for empty string", () => {
    expect(computeWalletStatus("").isConnected).toBe(false);
  });

  it("returns displayAddress='' for empty string", () => {
    expect(computeWalletStatus("").displayAddress).toBe("");
  });

  it("returns isConnected=false for null", () => {
    expect(computeWalletStatus(null).isConnected).toBe(false);
  });

  it("returns isConnected=false for undefined", () => {
    expect(computeWalletStatus(undefined).isConnected).toBe(false);
  });

  it("returns displayAddress='' for null", () => {
    expect(computeWalletStatus(null).displayAddress).toBe("");
  });
});

// ── Disconnected: structurally invalid strings ──────────────────────────────
describe("computeWalletStatus — disconnected (invalid strings)", () => {
  it("returns isConnected=false for a secret-key-like S-address", () => {
    const secretLike = "S" + "C".repeat(55);
    expect(computeWalletStatus(secretLike).isConnected).toBe(false);
  });

  it("returns isConnected=false for a short address (55 chars)", () => {
    expect(computeWalletStatus(VALID_ADDR.slice(0, 55)).isConnected).toBe(false);
  });

  it("returns isConnected=false for a long address (57 chars)", () => {
    expect(computeWalletStatus(VALID_ADDR + "A").isConnected).toBe(false);
  });

  it("returns isConnected=false when address starts with lowercase g", () => {
    const lower = "g" + VALID_ADDR.slice(1);
    expect(computeWalletStatus(lower).isConnected).toBe(false);
  });

  it("returns isConnected=false for an Ethereum-style 0x address", () => {
    expect(
      computeWalletStatus("0x742d35Cc6634C0532925a3b8D4C9b5A9f1e3c6b8")
        .isConnected,
    ).toBe(false);
  });

  it("returns displayAddress='' for every invalid input", () => {
    const cases = [
      "S" + "C".repeat(55),
      VALID_ADDR.slice(0, 55),
      VALID_ADDR + "A",
      "g" + VALID_ADDR.slice(1),
      "not-an-address",
      "",
      "   ",
    ];
    for (const c of cases) {
      expect(computeWalletStatus(c).displayAddress).toBe("");
    }
  });
});

// ── Defence in depth: state corruption scenarios ────────────────────────────
describe("computeWalletStatus — defence in depth (state corruption)", () => {
  it("rejects a JWT-style string that happens to start with G", () => {
    const jwt = "GeyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI=";
    expect(computeWalletStatus(jwt).isConnected).toBe(false);
  });

  it("rejects a string with embedded null byte even if it passes length check", () => {
    const injected = VALID_ADDR.slice(0, 55) + "\0";
    expect(computeWalletStatus(injected).isConnected).toBe(false);
  });

  it("rejects a string with embedded newline", () => {
    const injected = VALID_ADDR.slice(0, 55) + "\n";
    expect(computeWalletStatus(injected).isConnected).toBe(false);
  });

  it("rejects a string that starts with G but contains lowercase letters", () => {
    const bad = "G" + "A".repeat(30) + "a" + "A".repeat(24);
    expect(computeWalletStatus(bad).isConnected).toBe(false);
  });

  it("rejects a 56-char string that is all 'G' (valid G-address OK)", () => {
    const allG = "G".repeat(56);
    expect(computeWalletStatus(allG).isConnected).toBe(true);
  });
});

// ── displayAddress contract ─────────────────────────────────────────────────
describe("computeWalletStatus — displayAddress contract", () => {
  it("is always a string (never null or undefined)", () => {
    const cases = [
      VALID_ADDR,
      "",
      null,
      undefined,
      "S" + "C".repeat(55),
      "garbage",
    ];
    for (const c of cases) {
      expect(typeof computeWalletStatus(c).displayAddress).toBe("string");
    }
  });

  it("never exposes the full address in displayAddress", () => {
    const { displayAddress } = computeWalletStatus(VALID_ADDR);
    expect(displayAddress).not.toBe(VALID_ADDR);
    expect(displayAddress.length).toBeLessThan(VALID_ADDR.length);
  });

  it("displayAddress contains exactly one ellipsis segment", () => {
    const { displayAddress } = computeWalletStatus(VALID_ADDR);
    const parts = displayAddress.split("...");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(VALID_ADDR.slice(0, 8));
    expect(parts[1]).toBe(VALID_ADDR.slice(-6));
  });
});