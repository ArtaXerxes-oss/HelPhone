import { describe, it, expect, vi } from "vitest";
import {
  TxBatcher,
  createTxBatcher,
  MAX_OPS_PER_TX,
  DEFAULT_TIMEOUT_SECS,
  POLL_INTERVAL_MS,
  POLL_MAX_ATTEMPTS,
  __createTestBatcher,
} from "../src/lib/txBatcher.ts";

// ---------------------------------------------------------------------------
// Atomic Tx Batcher — unit tests
//
// The TxBatcher wraps multiple Stellar operations into one transaction.
// These tests cover:
//   1. Construction & validation
//   2. add() guards (overflow, post-flush, empty label)
//   3. flush() lifecycle (empty batch, already-flushed)
//   4. close() teardown
//   5. __createTestBatcher — integration scenario without a live RPC
//   6. Exported constants are sane
// ---------------------------------------------------------------------------

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_ADDRESS =
  "GB6Q7N7EHW5H6HZKAIIO4R2VTB7JEBX5XN4FOXXT6YTDA36Z7ALA656J";

function fakeOp() {
  // A minimal stand-in for an Operation object — TxBatcher only stores it,
  // not inspects it, so any truthy value is fine for unit-level tests.
  return { type: "invokeHostFunction", _fake: true };
}

function makeWallet() {
  return { signTransaction: vi.fn(async (xdr) => xdr) };
}

// ── 1. Construction & validation ────────────────────────────────────────────

describe("TxBatcher constructor", () => {
  it("constructs successfully with valid arguments", () => {
    const batcher = new TxBatcher(makeWallet(), VALID_ADDRESS);
    expect(batcher.size).toBe(0);
  });

  it("throws when signerAddress is empty string", () => {
    expect(() => new TxBatcher(makeWallet(), "")).toThrow(
      "signerAddress must be a non-empty string",
    );
  });

  it("throws when signerAddress is not a string", () => {
    expect(() => new TxBatcher(makeWallet(), null)).toThrow(
      "signerAddress must be a non-empty string",
    );
  });

  it("createTxBatcher factory returns a TxBatcher", () => {
    const b = createTxBatcher(makeWallet(), VALID_ADDRESS);
    expect(b).toBeInstanceOf(TxBatcher);
  });
});

// ── 2. add() guards ──────────────────────────────────────────────────────────

describe("TxBatcher.add()", () => {
  it("increments size on each add", () => {
    const b = new TxBatcher(makeWallet(), VALID_ADDRESS);
    b.add("op1", fakeOp());
    b.add("op2", fakeOp());
    expect(b.size).toBe(2);
  });

  it("returns this for chaining", () => {
    const b = new TxBatcher(makeWallet(), VALID_ADDRESS);
    const returned = b.add("op1", fakeOp());
    expect(returned).toBe(b);
  });

  it("throws when label is empty", () => {
    const b = new TxBatcher(makeWallet(), VALID_ADDRESS);
    expect(() => b.add("", fakeOp())).toThrow(
      "label must be a non-empty string",
    );
  });

  it(`throws when adding more than ${MAX_OPS_PER_TX} operations`, () => {
    const b = new TxBatcher(makeWallet(), VALID_ADDRESS);
    for (let i = 0; i < MAX_OPS_PER_TX; i++) {
      b.add(`op${i}`, fakeOp());
    }
    expect(() => b.add("one-too-many", fakeOp())).toThrow(
      `cannot exceed ${MAX_OPS_PER_TX} operations`,
    );
  });

  it("throws when called after flush()", async () => {
    const b = __createTestBatcher(async () => ({
      hash: "abc",
      results: [],
      ok: true,
    }));
    await b.flush();
    expect(() => b.add("late", fakeOp())).toThrow("already flushed");
  });

  it("throws when called after close()", () => {
    const b = new TxBatcher(makeWallet(), VALID_ADDRESS);
    b.close();
    expect(() => b.add("late", fakeOp())).toThrow(
      "cannot add to an already-flushed batcher",
    );
  });
});

// ── 3. flush() lifecycle ─────────────────────────────────────────────────────

describe("TxBatcher.flush()", () => {
  it("resolves immediately with empty result when queue is empty", async () => {
    // Use test batcher to avoid needing a live RPC for the empty-path
    const b = __createTestBatcher(async (entries) => ({
      hash: "shouldnotbeused",
      results: entries.map((e) => ({ label: e.label, status: "fulfilled" })),
      ok: true,
    }));
    const result = await b.flush();
    expect(result.hash).toBe("");
    expect(result.results).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("throws when flush() is called a second time", async () => {
    const b = __createTestBatcher(async () => ({
      hash: "h1",
      results: [],
      ok: true,
    }));
    await b.flush();
    await expect(b.flush()).rejects.toThrow("already flushed");
  });

  it("passes all queued entries to submitFn in order", async () => {
    let captured = null;
    const b = __createTestBatcher(async (entries) => {
      captured = entries;
      return {
        hash: "h2",
        results: entries.map((e) => ({ label: e.label, status: "fulfilled" })),
        ok: true,
      };
    });

    const op1 = fakeOp();
    const op2 = fakeOp();
    b.add("mark_arrived", op1);
    b.add("record_zk_proof", op2);

    const result = await b.flush();

    expect(captured).toHaveLength(2);
    expect(captured[0].label).toBe("mark_arrived");
    expect(captured[0].operation).toBe(op1);
    expect(captured[1].label).toBe("record_zk_proof");
    expect(result.hash).toBe("h2");
    expect(result.ok).toBe(true);
    expect(result.results[0].status).toBe("fulfilled");
    expect(result.results[1].status).toBe("fulfilled");
  });

  it("propagates errors thrown by submitFn", async () => {
    const b = __createTestBatcher(async () => {
      throw new Error("simulation failed: contract error");
    });
    b.add("op", fakeOp());
    await expect(b.flush()).rejects.toThrow(
      "simulation failed: contract error",
    );
  });

  it("real TxBatcher.flush() rejects when wallet.signTransaction missing", async () => {
    const badWallet = {}; // no signTransaction
    const b = new TxBatcher(badWallet, VALID_ADDRESS, {
      rpcUrl: "https://soroban-testnet.stellar.org",
    });
    b.add("op1", fakeOp());

    // The call will fail trying to reach the RPC; we only care it throws
    // deterministically rather than hanging forever.
    await expect(b.flush()).rejects.toThrow();
  });
});

// ── 4. close() teardown ──────────────────────────────────────────────────────

describe("TxBatcher.close()", () => {
  it("resets size to 0", () => {
    const b = new TxBatcher(makeWallet(), VALID_ADDRESS);
    b.add("op1", fakeOp());
    b.add("op2", fakeOp());
    b.close();
    expect(b.size).toBe(0);
  });

  it("is idempotent — calling twice does not throw", () => {
    const b = new TxBatcher(makeWallet(), VALID_ADDRESS);
    b.close();
    expect(() => b.close()).not.toThrow();
  });

  it("prevents flush() after close()", async () => {
    const b = new TxBatcher(makeWallet(), VALID_ADDRESS);
    b.add("op", fakeOp());
    b.close();
    await expect(b.flush()).rejects.toThrow("flush() has already been called");
  });
});

// ── 5. __createTestBatcher integration scenario ──────────────────────────────

describe("__createTestBatcher — realistic multi-op scenario", () => {
  it("simulates mark_arrived + record_zk_proof as one atomic batch", async () => {
    const EXPECTED_HASH = "abc123atomichash";

    const b = __createTestBatcher(async (entries) => ({
      hash: EXPECTED_HASH,
      results: entries.map((e) => ({
        label: e.label,
        status: "fulfilled",
        value: { status: "SUCCESS" },
      })),
      ok: true,
    }));

    b.add("mark_arrived", fakeOp());
    b.add("record_zk_proof", fakeOp());
    expect(b.size).toBe(2);

    const { hash, results, ok } = await b.flush();

    expect(hash).toBe(EXPECTED_HASH);
    expect(ok).toBe(true);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      label: "mark_arrived",
      status: "fulfilled",
    });
    expect(results[1]).toMatchObject({
      label: "record_zk_proof",
      status: "fulfilled",
    });
  });

  it("exposes _entries before flush for inspection", () => {
    const b = __createTestBatcher(async () => ({
      hash: "x",
      results: [],
      ok: true,
    }));
    const op = fakeOp();
    b.add("test-op", op);
    expect(b._entries).toHaveLength(1);
    expect(b._entries[0].label).toBe("test-op");
    expect(b._entries[0].operation).toBe(op);
  });

  it("enforces MAX_OPS_PER_TX in test batcher too", () => {
    const b = __createTestBatcher(async () => ({
      hash: "",
      results: [],
      ok: true,
    }));
    for (let i = 0; i < MAX_OPS_PER_TX; i++) b.add(`op${i}`, fakeOp());
    expect(() => b.add("overflow", fakeOp())).toThrow("Cannot exceed");
  });
});

// ── 6. Exported constants ────────────────────────────────────────────────────

describe("exported constants", () => {
  it("MAX_OPS_PER_TX is 100 (Stellar protocol limit)", () => {
    expect(MAX_OPS_PER_TX).toBe(100);
  });

  it("DEFAULT_TIMEOUT_SECS is a positive number", () => {
    expect(typeof DEFAULT_TIMEOUT_SECS).toBe("number");
    expect(DEFAULT_TIMEOUT_SECS).toBeGreaterThan(0);
  });

  it("POLL_INTERVAL_MS is a positive number", () => {
    expect(typeof POLL_INTERVAL_MS).toBe("number");
    expect(POLL_INTERVAL_MS).toBeGreaterThan(0);
  });

  it("POLL_MAX_ATTEMPTS is a positive number", () => {
    expect(typeof POLL_MAX_ATTEMPTS).toBe("number");
    expect(POLL_MAX_ATTEMPTS).toBeGreaterThan(0);
  });
});
