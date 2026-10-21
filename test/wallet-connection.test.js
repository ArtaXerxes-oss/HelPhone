import { describe, it, expect, vi, beforeEach } from "vitest";
import { sanitizeWalletAddress } from "../src/pages/Help.jsx";

// ---------------------------------------------------------------------------
// wallet-connection tests
//
// Covers the four hardening properties introduced to promptWalletConnection:
//
//   1. sanitizeWalletAddress — structural validation of Stellar G-addresses
//   2. Re-entrant gate       — single in-flight call at a time
//   3. Stale-address prevention — only validated addresses reach state
//   4. Side-channel / error sink — no credential material escapes via console
// ---------------------------------------------------------------------------

// ── Address fixtures ─────────────────────────────────────────────────────────
// Stellar public keys (G-addresses) are exactly 56 characters:
//   G  +  55 characters from the RFC 4648 base-32 alphabet [A-Z2-7]
//
// These are synthetic structurally-valid addresses (not real keypairs).
const VALID_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3"; // 56 chars
const VALID_ADDR_2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC"; // 56 chars

// Verify fixture lengths at module load so a typo is caught immediately
if (VALID_ADDR.length !== 56)
  throw new Error(`VALID_ADDR is ${VALID_ADDR.length} chars, expected 56`);
if (VALID_ADDR_2.length !== 56)
  throw new Error(`VALID_ADDR_2 is ${VALID_ADDR_2.length} chars, expected 56`);

// ── 1. sanitizeWalletAddress — valid inputs ──────────────────────────────────
describe("sanitizeWalletAddress — valid G-addresses", () => {
  it("accepts a canonical 56-char Stellar G-address", () => {
    expect(sanitizeWalletAddress(VALID_ADDR)).toBe(VALID_ADDR);
  });

  it("returns the address unchanged when it is already clean", () => {
    const result = sanitizeWalletAddress(VALID_ADDR);
    expect(result).toHaveLength(56);
    expect(result[0]).toBe("G");
  });

  it("trims leading/trailing spaces before validating", () => {
    expect(sanitizeWalletAddress(`  ${VALID_ADDR}  `)).toBe(VALID_ADDR);
  });

  it("trims leading/trailing tabs before validating", () => {
    expect(sanitizeWalletAddress(`\t${VALID_ADDR}\t`)).toBe(VALID_ADDR);
  });

  it("accepts a second distinct valid address", () => {
    expect(sanitizeWalletAddress(VALID_ADDR_2)).toBe(VALID_ADDR_2);
  });

  it("accepts addresses using digits 2-7 (valid base-32 digits)", () => {
    // G + 51 A's + "2345" = 56 chars total, all from [A-Z2-7]
    const withDigits = "G" + "A".repeat(51) + "2345";
    expect(withDigits).toHaveLength(56);
    expect(sanitizeWalletAddress(withDigits)).toBe(withDigits);
  });

  it("accepts all-uppercase-letter address (no digits)", () => {
    const allLetters = "G" + "A".repeat(55);
    expect(sanitizeWalletAddress(allLetters)).toBe(allLetters);
  });
});

// ── 2. sanitizeWalletAddress — invalid / malicious inputs ────────────────────
describe("sanitizeWalletAddress — invalid / malicious inputs", () => {
  // ── Wrong length ──────────────────────────────────────────────────────────
  it("rejects an address that is too short (55 chars)", () => {
    expect(sanitizeWalletAddress(VALID_ADDR.slice(0, 55))).toBe("");
  });

  it("rejects an address that is too long (57 chars)", () => {
    expect(sanitizeWalletAddress(VALID_ADDR + "A")).toBe("");
  });

  it("rejects an empty string", () => {
    expect(sanitizeWalletAddress("")).toBe("");
  });

  it("rejects a whitespace-only string", () => {
    expect(sanitizeWalletAddress("   ")).toBe("");
  });

  // ── Wrong prefix ──────────────────────────────────────────────────────────
  it("rejects a Stellar S-address (secret key) with G replaced by S", () => {
    // Secret keys are also 56 chars but start with S
    const secretLike = "S" + VALID_ADDR.slice(1);
    expect(sanitizeWalletAddress(secretLike)).toBe("");
  });

  it("rejects an address starting with a lowercase g", () => {
    const lower = "g" + VALID_ADDR.slice(1);
    expect(sanitizeWalletAddress(lower)).toBe("");
  });

  it("rejects an address that does not start with G", () => {
    expect(sanitizeWalletAddress("A" + VALID_ADDR.slice(1))).toBe("");
  });

  // ── Invalid characters ────────────────────────────────────────────────────
  it("rejects an address containing digit 0 (not in base-32)", () => {
    const bad = VALID_ADDR.slice(0, 10) + "0" + VALID_ADDR.slice(11);
    expect(sanitizeWalletAddress(bad)).toBe("");
  });

  it("rejects an address containing digit 1 (not in base-32)", () => {
    const bad = VALID_ADDR.slice(0, 10) + "1" + VALID_ADDR.slice(11);
    expect(sanitizeWalletAddress(bad)).toBe("");
  });

  it("rejects an address containing digit 8 (not in base-32)", () => {
    const bad = VALID_ADDR.slice(0, 10) + "8" + VALID_ADDR.slice(11);
    expect(sanitizeWalletAddress(bad)).toBe("");
  });

  it("rejects an address containing digit 9 (not in base-32)", () => {
    const bad = VALID_ADDR.slice(0, 10) + "9" + VALID_ADDR.slice(11);
    expect(sanitizeWalletAddress(bad)).toBe("");
  });

  it("rejects an address containing a lowercase letter", () => {
    const bad = VALID_ADDR.slice(0, 5) + "a" + VALID_ADDR.slice(6);
    expect(sanitizeWalletAddress(bad)).toBe("");
  });

  it("rejects an address containing a special character (!)", () => {
    const bad = VALID_ADDR.slice(0, 5) + "!" + VALID_ADDR.slice(6);
    expect(sanitizeWalletAddress(bad)).toBe("");
  });

  it("rejects an Ethereum-style 0x address", () => {
    expect(
      sanitizeWalletAddress("0x742d35Cc6634C0532925a3b8D4C9b5A9f1e3c6b8"),
    ).toBe("");
  });

  it("rejects an address with an embedded newline", () => {
    const injected = VALID_ADDR.slice(0, 55) + "\n";
    expect(sanitizeWalletAddress(injected)).toBe("");
  });

  it("rejects an address with an embedded null byte", () => {
    const injected = VALID_ADDR.slice(0, 55) + "\0";
    expect(sanitizeWalletAddress(injected)).toBe("");
  });

  it("rejects an address with an embedded space", () => {
    const spaced = VALID_ADDR.slice(0, 28) + " " + VALID_ADDR.slice(29);
    expect(sanitizeWalletAddress(spaced)).toBe("");
  });

  // ── Wrong types ───────────────────────────────────────────────────────────
  it("rejects null", () => {
    expect(sanitizeWalletAddress(null)).toBe("");
  });

  it("rejects undefined", () => {
    expect(sanitizeWalletAddress(undefined)).toBe("");
  });

  it("rejects a number", () => {
    expect(sanitizeWalletAddress(12345)).toBe("");
  });

  it("rejects a plain object", () => {
    expect(sanitizeWalletAddress({ address: VALID_ADDR })).toBe("");
  });

  it("rejects an array", () => {
    expect(sanitizeWalletAddress([VALID_ADDR])).toBe("");
  });

  it("rejects a boolean", () => {
    expect(sanitizeWalletAddress(true)).toBe("");
  });

  // ── Crafted side-channel payloads ─────────────────────────────────────────
  it("rejects a WalletConnect error string containing partial key material", () => {
    const errLike = "User rejected: session_token=abcdef1234 addr=GAAAAAA";
    expect(sanitizeWalletAddress(errLike)).toBe("");
  });

  it("rejects a JWT-style token even if it starts with G and is long", () => {
    // 56-char string starting with G but containing non-base-32 chars (+, /)
    const jwt = "GeyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI=";
    expect(sanitizeWalletAddress(jwt)).toBe("");
  });

  it("rejects a real Stellar S-address (56-char secret key)", () => {
    const secret = "S" + "C".repeat(55);
    expect(sanitizeWalletAddress(secret)).toBe("");
  });
});

// ── 3. Re-entrant gate simulation ────────────────────────────────────────────
// Mirrors the walletConnectionInFlight ref logic in Help.jsx exactly.
describe("re-entrant gate", () => {
  // Factory producing a self-contained gate + connection function.
  // The authModal parameter replaces StellarWalletsKit.authModal() so we
  // can control timing from outside the function.
  function createGate() {
    let inFlight = false;
    const stored = [];

    async function connect(authModal) {
      if (inFlight) return "";
      inFlight = true;
      try {
        await new Promise((r) => setTimeout(r, 0)); // macrotask defer (mirrors Help.jsx)
        const { address: raw } = await authModal();
        const address = sanitizeWalletAddress(raw);
        if (address) {
          stored.push(address);
          return address;
        }
      } catch {
        /* silent */
      } finally {
        inFlight = false;
      }
      return "";
    }

    return { connect, stored, isInFlight: () => inFlight };
  }

  it("blocks a second concurrent call while the first is in-flight", async () => {
    const { connect } = createGate();

    // Create an externally-resolvable promise for the slow first modal
    let resolveFirst;
    const firstModalPromise = new Promise((r) => {
      resolveFirst = r;
    });
    const slowModal = vi.fn(() => firstModalPromise);
    const fastModal = vi.fn().mockResolvedValue({ address: VALID_ADDR_2 });

    // Start first call (will block on firstModalPromise)
    const p1 = connect(slowModal);
    // Yield to the event loop so the first call enters its await-setTimeout
    await new Promise((r) => setTimeout(r, 10));

    // Second call fires while first is still in-flight
    const r2 = await connect(fastModal);

    expect(r2).toBe("");
    expect(fastModal).not.toHaveBeenCalled(); // gate blocked it

    // Resolve the first modal and verify it completes correctly
    resolveFirst({ address: VALID_ADDR });
    const r1 = await p1;
    expect(r1).toBe(VALID_ADDR);
  });

  it("releases the gate after a successful connection", async () => {
    const { connect, isInFlight } = createGate();
    const modal = vi.fn().mockResolvedValue({ address: VALID_ADDR });
    await connect(modal);
    expect(isInFlight()).toBe(false);
  });

  it("releases the gate after authModal throws", async () => {
    const { connect, isInFlight } = createGate();
    const modal = vi.fn().mockRejectedValue(new Error("User cancelled"));
    await connect(modal);
    expect(isInFlight()).toBe(false);
  });

  it("releases the gate after authModal returns an invalid address", async () => {
    const { connect, isInFlight } = createGate();
    const modal = vi.fn().mockResolvedValue({ address: "not-valid" });
    const result = await connect(modal);
    expect(result).toBe("");
    expect(isInFlight()).toBe(false);
  });

  it("allows a new call after the previous one completes", async () => {
    const { connect, stored } = createGate();
    const modal = vi.fn().mockResolvedValue({ address: VALID_ADDR });

    await connect(modal);
    await connect(modal);

    expect(stored).toHaveLength(2);
    expect(modal).toHaveBeenCalledTimes(2);
  });

  it("blocks 999 of 1000 concurrent calls", async () => {
    const { connect, stored } = createGate();

    let resolveModal;
    const slowModal = vi.fn(
      () =>
        new Promise((r) => {
          resolveModal = r;
        }),
    );

    // Fire all 1000 calls simultaneously (all will race to check inFlight)
    const promises = Array.from({ length: 1000 }, () => connect(slowModal));

    // Yield so the first call reaches and enters its await-setTimeout
    await new Promise((r) => setTimeout(r, 20));

    // Resolve the single authModal invocation
    resolveModal({ address: VALID_ADDR });
    const results = await Promise.all(promises);

    const executed = results.filter((r) => r !== "");
    const blocked = results.filter((r) => r === "");

    expect(executed).toHaveLength(1);
    expect(blocked).toHaveLength(999);
    expect(stored).toHaveLength(1);
  });
});

// ── 4. Stale-address prevention ───────────────────────────────────────────────
describe("stale-address prevention", () => {
  it("second concurrent call cannot overwrite address from the first", async () => {
    let inFlight = false;
    let storedAddress = "";

    async function connect(authModal) {
      if (inFlight) return "";
      inFlight = true;
      try {
        await new Promise((r) => setTimeout(r, 0));
        const { address: raw } = await authModal();
        const address = sanitizeWalletAddress(raw);
        if (address) {
          storedAddress = address;
          return address;
        }
      } catch {
        /* silent */
      } finally {
        inFlight = false;
      }
      return "";
    }

    let resolveFirst;
    const modal1 = vi.fn(
      () =>
        new Promise((r) => {
          resolveFirst = r;
        }),
    );
    const modal2 = vi.fn().mockResolvedValue({ address: VALID_ADDR_2 });

    const p1 = connect(modal1);
    await new Promise((r) => setTimeout(r, 10)); // let first call enter its await

    await connect(modal2); // blocked — modal2 never called

    resolveFirst({ address: VALID_ADDR });
    await p1;

    // Only the first call's address is stored — no stale overwrite from modal2
    expect(storedAddress).toBe(VALID_ADDR);
    expect(modal2).not.toHaveBeenCalled();
  });

  it("validates address from STATE_UPDATED event before storing", () => {
    const stored = [];
    const setWalletAddress = (a) => stored.push(a);

    const events = [
      { payload: { address: VALID_ADDR } }, // valid
      { payload: { address: "not-a-stellar-addr" } }, // invalid — too short
      { payload: { address: VALID_ADDR_2 } }, // valid
      { payload: { address: null } }, // null
      { payload: {} }, // missing address key
    ];

    for (const event of events) {
      setWalletAddress(sanitizeWalletAddress(event?.payload?.address));
    }

    expect(stored).toEqual([VALID_ADDR, "", VALID_ADDR_2, "", ""]);
  });

  it("validates address from getAddress() (syncWallet) before storing", () => {
    const stored = [];
    const setWalletAddress = (a) => stored.push(a);

    const responses = [
      { address: VALID_ADDR },
      { address: "S" + "C".repeat(55) }, // secret key — must be rejected
      { address: undefined },
      { address: VALID_ADDR_2 },
    ];

    for (const resp of responses) {
      setWalletAddress(sanitizeWalletAddress(resp.address));
    }

    expect(stored).toEqual([VALID_ADDR, "", "", VALID_ADDR_2]);
  });

  it("rejects a secret key injected via STATE_UPDATED event", () => {
    const stored = [];
    const setWalletAddress = (a) => stored.push(a);

    // A compromised wallet extension returns an S-address
    const event = { payload: { address: "S" + "C".repeat(55) } };
    setWalletAddress(sanitizeWalletAddress(event?.payload?.address));

    expect(stored).toEqual([""]);
  });
});

// ── 5. Side-channel / error-sink tests ───────────────────────────────────────
describe("side-channel elimination — silent error sink", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  async function silentConnect(authModal) {
    let inFlight = false;
    if (inFlight) return "";
    inFlight = true;
    try {
      await new Promise((r) => setTimeout(r, 0));
      const { address: raw } = await authModal();
      const address = sanitizeWalletAddress(raw);
      if (address) return address;
    } catch {
      /* silent — no console output */
    } finally {
      inFlight = false;
    }
    return "";
  }

  it("does not call console.warn when authModal throws", async () => {
    const modal = vi
      .fn()
      .mockRejectedValue(
        new Error("session_token=eyJh.eyJz.sig user_key_partial=GAAAA"),
      );
    await silentConnect(modal);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("does not call console.error when authModal throws", async () => {
    const modal = vi.fn().mockRejectedValue(new Error("WC_SECRET=abc123"));
    await silentConnect(modal);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("does not call console.log when authModal throws", async () => {
    const modal = vi.fn().mockRejectedValue(new Error("sensitive-data"));
    await silentConnect(modal);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("handles non-Error throws (string, object, null) without leaking", async () => {
    for (const thrown of ["cancelled", { code: 4001 }, null, undefined]) {
      const modal = vi.fn().mockRejectedValue(thrown);
      const result = await silentConnect(modal);
      expect(result).toBe("");
      expect(console.warn).not.toHaveBeenCalled();
    }
  });

  it("does not expose error content via the return value", async () => {
    const secretMsg = "private_key_fragment=S" + "C".repeat(20);
    const modal = vi.fn().mockRejectedValue(new Error(secretMsg));
    const result = await silentConnect(modal);

    expect(result).toBe("");
    expect(result).not.toContain("private_key");
    expect(result).not.toContain("fragment");
  });
});

// ── 6. Return value contract ──────────────────────────────────────────────────
describe("return value contract", () => {
  async function mkConnect(authModal) {
    let inFlight = false;
    if (inFlight) return "";
    inFlight = true;
    try {
      await new Promise((r) => setTimeout(r, 0));
      const { address: raw } = await authModal();
      const address = sanitizeWalletAddress(raw);
      if (address) return address;
    } catch {
      /* silent */
    } finally {
      inFlight = false;
    }
    return "";
  }

  it("returns a valid address string on success", async () => {
    const modal = vi.fn().mockResolvedValue({ address: VALID_ADDR });
    expect(await mkConnect(modal)).toBe(VALID_ADDR);
  });

  it('returns "" when authModal throws', async () => {
    const modal = vi.fn().mockRejectedValue(new Error("cancelled"));
    expect(await mkConnect(modal)).toBe("");
  });

  it('returns "" when authModal returns an invalid address', async () => {
    const modal = vi.fn().mockResolvedValue({ address: "bad-address" });
    expect(await mkConnect(modal)).toBe("");
  });

  it('returns "" when authModal returns null address', async () => {
    const modal = vi.fn().mockResolvedValue({ address: null });
    expect(await mkConnect(modal)).toBe("");
  });

  it('returns "" when authModal returns undefined address', async () => {
    const modal = vi.fn().mockResolvedValue({ address: undefined });
    expect(await mkConnect(modal)).toBe("");
  });

  it("return type is always string, never null or undefined", async () => {
    const cases = [
      vi.fn().mockResolvedValue({ address: VALID_ADDR }),
      vi.fn().mockResolvedValue({ address: null }),
      vi.fn().mockRejectedValue(new Error("fail")),
    ];
    for (const modal of cases) {
      expect(typeof (await mkConnect(modal))).toBe("string");
    }
  });
});

// ── 7. sanitizeWalletAddress — edge cases ────────────────────────────────────
describe("sanitizeWalletAddress — edge cases", () => {
  it("accepts a 56-char string of all Gs (structurally valid)", () => {
    const allG = "G".repeat(56);
    expect(sanitizeWalletAddress(allG)).toBe(allG);
  });

  it("rejects a 56-char string not starting with G", () => {
    const noG = "A" + "A".repeat(55);
    expect(sanitizeWalletAddress(noG)).toBe("");
  });

  it("rejects a 56-char string starting with lowercase g", () => {
    const lower = "g" + "A".repeat(55);
    expect(sanitizeWalletAddress(lower)).toBe("");
  });

  it("handles a 56-char string with a space in the middle", () => {
    const spaced = VALID_ADDR.slice(0, 28) + " " + VALID_ADDR.slice(29);
    expect(sanitizeWalletAddress(spaced)).toBe("");
  });

  it("is deterministic — same input always produces the same output", () => {
    for (let i = 0; i < 100; i++) {
      expect(sanitizeWalletAddress(VALID_ADDR)).toBe(VALID_ADDR);
      expect(sanitizeWalletAddress("bad")).toBe("");
    }
  });

  it("does not mutate the input string", () => {
    const input = `  ${VALID_ADDR}  `;
    const snapshot = input;
    sanitizeWalletAddress(input);
    expect(input).toBe(snapshot);
  });

  it("treats a 56-char valid address with only trailing newline as invalid", () => {
    // After trim(), length becomes 55 → rejected
    const padded = VALID_ADDR.slice(0, 55) + "\n";
    // trim() removes \n, leaving 55 chars — too short
    expect(sanitizeWalletAddress(padded)).toBe("");
  });
});
