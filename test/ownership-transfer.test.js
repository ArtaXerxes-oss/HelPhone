import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Ownership Transfer — frontend binding tests
//
// Tests for proposeTransfer / acceptTransfer / revokeTransfer / getPendingOwner
// in src/lib/contract.ts. Uses the same mock pattern as contract-functions.test.js:
// only the Stellar RPC server and assembleTransaction are faked; real SDK
// TransactionBuilder/Operation code exercises the actual argument encoding.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({ servers: [] }));

// Use the same FAKE_PK from contract-functions.test.js as the "new owner" —
// it is a valid G... key the SDK will accept.
const FAKE_ADMIN = "GB6Q7N7EHW5H6HZKAIIO4R2VTB7JEBX5XN4FOXXT6YTDA36Z7ALA656J";
const FAKE_NEW_OWNER =
  "GB6Q7N7EHW5H6HZKAIIO4R2VTB7JEBX5XN4FOXXT6YTDA36Z7ALA656J"; // same key, different role in tests

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal();

  class Server {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.simulateTransaction = vi.fn();
      this.getAccount = vi.fn();
      this.sendTransaction = vi.fn();
      this.getTransaction = vi.fn();
      state.servers.push(this);
    }
  }

  function assembleTransaction(rawTx) {
    return { build: () => rawTx };
  }

  return {
    ...actual,
    rpc: { ...actual.rpc, Server, assembleTransaction },
    Keypair: {
      ...actual.Keypair,
      random: () => ({
        publicKey: () => FAKE_ADMIN,
        sign: (data) => data,
      }),
    },
  };
});

import { Account } from "@stellar/stellar-sdk";
import {
  proposeTransfer,
  acceptTransfer,
  revokeTransfer,
  getPendingOwner,
} from "../src/lib/contract.js";

const TX_HASH = "ownershiphash42";

function makeWallet(address = FAKE_ADMIN) {
  return {
    account: { address },
    signTransaction: vi.fn(async (xdr) => xdr),
  };
}

function mockSuccessfulSubmit({ returnValue } = {}) {
  const server = state.servers.at(-1);
  server.getAccount.mockResolvedValue(new Account(FAKE_ADMIN, "200"));
  server.simulateTransaction.mockResolvedValue({});
  server.sendTransaction.mockResolvedValue({
    status: "PENDING",
    hash: TX_HASH,
  });
  server.getTransaction.mockResolvedValue({
    status: "SUCCESS",
    hash: TX_HASH,
    ...(returnValue !== undefined ? { returnValue } : {}),
  });
  return server;
}

// ── getPendingOwner ─────────────────────────────────────────────────────────

describe("getPendingOwner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when simulate result has no retval", async () => {
    const server = state.servers.at(-1);
    server.simulateTransaction.mockResolvedValue({ result: null });
    const result = await getPendingOwner();
    expect(result).toBeNull();
  });

  it("calls simulateTransaction for the get_pending_owner function", async () => {
    const server = state.servers.at(-1);
    server.simulateTransaction.mockResolvedValue({ result: null });
    await getPendingOwner();
    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
    const tx = server.simulateTransaction.mock.calls[0][0];
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("invokeHostFunction");
  });
});

// ── proposeTransfer ─────────────────────────────────────────────────────────

describe("proposeTransfer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds, simulates, signs and submits propose_transfer", async () => {
    const server = mockSuccessfulSubmit();
    const wallet = makeWallet(FAKE_ADMIN);

    await proposeTransfer(FAKE_ADMIN, FAKE_NEW_OWNER, wallet);

    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
    expect(server.getTransaction).toHaveBeenCalledWith(TX_HASH);

    // Verify transaction contains one invokeHostFunction operation
    const tx = server.simulateTransaction.mock.calls[0][0];
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("invokeHostFunction");
  });

  it("throws a friendly error on simulation contract error code 2", async () => {
    const server = state.servers.at(-1);
    server.getAccount.mockResolvedValue(new Account(FAKE_ADMIN, "200"));
    server.simulateTransaction.mockResolvedValue({
      error: "Error(Contract, #2)",
    });

    const err = await proposeTransfer(
      FAKE_ADMIN,
      FAKE_NEW_OWNER,
      makeWallet(FAKE_ADMIN),
    ).catch((e) => e);

    expect(err.message).toContain("current contract owner can propose");
    expect(err.contractCode).toBe(2);
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });
});

// ── acceptTransfer ──────────────────────────────────────────────────────────

describe("acceptTransfer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds, simulates, signs and submits accept_transfer", async () => {
    const server = state.servers.at(-1);
    server.getAccount.mockResolvedValue(new Account(FAKE_NEW_OWNER, "100"));
    server.simulateTransaction.mockResolvedValue({});
    server.sendTransaction.mockResolvedValue({
      status: "PENDING",
      hash: TX_HASH,
    });
    server.getTransaction.mockResolvedValue({
      status: "SUCCESS",
      hash: TX_HASH,
    });

    const wallet = makeWallet(FAKE_NEW_OWNER);
    await acceptTransfer(FAKE_NEW_OWNER, wallet);

    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
    const tx = server.simulateTransaction.mock.calls[0][0];
    expect(tx.operations[0].type).toBe("invokeHostFunction");
  });

  it("throws a friendly error for NoPendingTransfer (code 5)", async () => {
    const server = state.servers.at(-1);
    server.getAccount.mockResolvedValue(new Account(FAKE_NEW_OWNER, "100"));
    server.simulateTransaction.mockResolvedValue({
      error: "Error(Contract, #5)",
    });

    const err = await acceptTransfer(
      FAKE_NEW_OWNER,
      makeWallet(FAKE_NEW_OWNER),
    ).catch((e) => e);

    expect(err.message).toContain("There is no pending ownership transfer");
    expect(err.contractCode).toBe(5);
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("throws a friendly error when wrong address tries to accept (code 2)", async () => {
    const server = state.servers.at(-1);
    server.getAccount.mockResolvedValue(new Account(FAKE_ADMIN, "100"));
    server.simulateTransaction.mockResolvedValue({
      error: "Error(Contract, #2)",
    });

    const err = await acceptTransfer(FAKE_ADMIN, makeWallet(FAKE_ADMIN)).catch(
      (e) => e,
    );

    expect(err.message).toContain("nominated new owner can accept");
    expect(err.contractCode).toBe(2);
  });
});

// ── revokeTransfer ──────────────────────────────────────────────────────────

describe("revokeTransfer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds, simulates, signs and submits revoke_transfer", async () => {
    const server = mockSuccessfulSubmit();
    const wallet = makeWallet(FAKE_ADMIN);

    await revokeTransfer(FAKE_ADMIN, wallet);

    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
    const tx = server.simulateTransaction.mock.calls[0][0];
    expect(tx.operations[0].type).toBe("invokeHostFunction");
  });

  it("throws a friendly error when no pending transfer to revoke (code 5)", async () => {
    const server = state.servers.at(-1);
    server.getAccount.mockResolvedValue(new Account(FAKE_ADMIN, "200"));
    server.simulateTransaction.mockResolvedValue({
      error: "Error(Contract, #5)",
    });

    const err = await revokeTransfer(FAKE_ADMIN, makeWallet(FAKE_ADMIN)).catch(
      (e) => e,
    );

    expect(err.message).toContain("There is no pending ownership transfer");
    expect(err.contractCode).toBe(5);
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("throws a friendly error when unrelated address tries to revoke (code 2)", async () => {
    const server = state.servers.at(-1);
    server.getAccount.mockResolvedValue(new Account(FAKE_ADMIN, "200"));
    server.simulateTransaction.mockResolvedValue({
      error: "Error(Contract, #2)",
    });

    const err = await revokeTransfer(FAKE_ADMIN, makeWallet(FAKE_ADMIN)).catch(
      (e) => e,
    );

    expect(err.message).toContain("current owner or nominated new owner");
    expect(err.contractCode).toBe(2);
  });
});
