import { createElement as h } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { nativeToScVal, StrKey, Account } from "@stellar/stellar-sdk";
import {
  STROOPS,
  toAmount,
  formatStroops,
  disbursementUsage,
  toAssetRow,
} from "../src/lib/treasury.ts";
import { TreasuryPanel } from "../src/components/TreasuryPanel.jsx";

// #541 — Treasury helpers, dashboard panel, and contract client reads.

const state = vi.hoisted(() => ({ servers: [] }));
const FAKE_PK = "GB6Q7N7EHW5H6HZKAIIO4R2VTB7JEBX5XN4FOXXT6YTDA36Z7ALA656J";

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal();
  class Server {
    constructor() {
      this.simulateTransaction = vi.fn();
      this.getAccount = vi.fn();
      this.sendTransaction = vi.fn();
      this.getTransaction = vi.fn();
      state.servers.push(this);
    }
  }
  return {
    ...actual,
    rpc: { ...actual.rpc, Server, assembleTransaction: (tx) => ({ build: () => tx }) },
    Keypair: { ...actual.Keypair, random: () => ({ publicKey: () => FAKE_PK, sign: (d) => d }) },
  };
});

const AEGIS = StrKey.encodeContract(Buffer.alloc(32, 7));
const ASSET_A = StrKey.encodeContract(Buffer.alloc(32, 1));
const ASSET_B = StrKey.encodeContract(Buffer.alloc(32, 2));

describe("treasury helpers", () => {
  it("toAmount converts bigint/number and maps the no-cap sentinel to Infinity", () => {
    expect(toAmount(5n)).toBe(5);
    expect(toAmount((1n << 127n) - 1n)).toBe(Infinity);
    expect(toAmount("12")).toBe(12);
    expect(toAmount(undefined)).toBe(0);
  });

  it("formatStroops renders 7-decimal amounts and infinity", () => {
    expect(formatStroops(500_000_000)).toBe("50.00");
    expect(formatStroops(12_345_678, 4)).toBe("1.2346");
    expect(formatStroops(Infinity)).toBe("∞");
  });

  it("disbursementUsage reports pct, remaining and exhaustion", () => {
    expect(disbursementUsage(1000, 250)).toEqual({ unlimited: false, pct: 25, remaining: 750, exhausted: false });
    expect(disbursementUsage(1000, 1000)).toMatchObject({ pct: 100, remaining: 0, exhausted: true });
    expect(disbursementUsage(1000, 5000)).toMatchObject({ pct: 100, remaining: 0, exhausted: true });
    expect(disbursementUsage(0, 0)).toMatchObject({ pct: 100, exhausted: true });
    expect(disbursementUsage(Infinity, 99)).toEqual({ unlimited: true, pct: 0, remaining: Infinity, exhausted: false });
  });

  it("toAssetRow normalizes raw contract values", () => {
    expect(
      toAssetRow("CX", { reserve: 10n, limit: (1n << 127n) - 1n, spent: 2n, remaining: 8n, weight: 2500 }),
    ).toEqual({ asset: "CX", reserve: 10, dailyLimit: Infinity, spentToday: 2, remainingToday: 8, targetWeightBps: 2500 });
  });
});

describe("<TreasuryPanel />", () => {
  const row = (o = {}) => ({
    asset: ASSET_A,
    reserve: 5 * STROOPS,
    dailyLimit: 10 * STROOPS,
    spentToday: 4 * STROOPS,
    remainingToday: 6 * STROOPS,
    targetWeightBps: 0,
    ...o,
  });

  it("shows loading, then empty state", () => {
    const { rerender } = render(h(TreasuryPanel, { rows: [], loading: true }));
    expect(screen.getByRole("status").textContent).toMatch(/Loading/);
    rerender(h(TreasuryPanel, { rows: [] }));
    expect(screen.getByText("No treasury assets yet.")).toBeTruthy();
    cleanup();
  });

  it("renders reserves with daily usage and target weights", () => {
    render(h(TreasuryPanel, { rows: [row({ targetWeightBps: 2500 }), row({ asset: ASSET_B, dailyLimit: Infinity })] }));
    const rows = screen.getAllByTestId("treasury-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("5.00");
    expect(rows[0].textContent).toContain("4.00 / 10.00 today");
    expect(rows[0].textContent).toContain("target 25.0%");
    expect(screen.getAllByRole("progressbar")[0].getAttribute("aria-valuenow")).toBe("40");
    expect(rows[1].textContent).toContain("No daily cap");
    cleanup();
  });

  it("flags an exhausted daily limit", () => {
    render(h(TreasuryPanel, { rows: [row({ spentToday: 10 * STROOPS })] }));
    expect(screen.getByTestId("treasury-row").textContent).toContain("daily limit reached");
    cleanup();
  });
});

describe("contract.ts — treasury reads", () => {
  let contractLib;
  let server;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("VITE_AEGIS_VAULT_ID", AEGIS);
    contractLib = await import("../src/lib/contract.ts");
    server = state.servers.at(-1);
  });

  const respond = (byFn) =>
    server.simulateTransaction.mockImplementation(async (tx) => {
      const fn = tx.operations[0].func.invokeContract().functionName().toString();
      return { result: { retval: byFn[fn]() } };
    });

  it("getTreasurySnapshot assembles one row per asset", async () => {
    respond({
      treasury_assets: () => nativeToScVal([ASSET_A, ASSET_B].map((a) => nativeToScVal(a, { type: "address" }))),
      treasury_reserve: () => nativeToScVal(100n, { type: "i128" }),
      daily_limit: () => nativeToScVal(500n, { type: "i128" }),
      spent_today: () => nativeToScVal(200n, { type: "i128" }),
      remaining_today: () => nativeToScVal(300n, { type: "i128" }),
      target_weight: () => nativeToScVal(5000, { type: "u32" }),
    });
    const rows = await contractLib.getTreasurySnapshot();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      asset: ASSET_A,
      reserve: 100,
      dailyLimit: 500,
      spentToday: 200,
      remainingToday: 300,
      targetWeightBps: 5000,
    });
  });

  it("getTreasuryRebalancePlan converts signed i128 results", async () => {
    respond({ rebalance_plan: () => nativeToScVal([50n, -50n].map((v) => nativeToScVal(v, { type: "i128" }))) });
    expect(await contractLib.getTreasuryRebalancePlan([1, 1])).toEqual([50, -50]);
  });

  it("returns empty results when a simulation has no result", async () => {
    server.simulateTransaction.mockResolvedValue({});
    expect(await contractLib.getTreasurySnapshot()).toEqual([]);
    expect(await contractLib.getTreasuryRebalancePlan([1])).toEqual([]);
  });

  it("setTreasuryDailyLimit builds, signs and submits set_daily_limit", async () => {
    server.getAccount.mockResolvedValue(new Account(FAKE_PK, "100"));
    server.simulateTransaction.mockResolvedValue({});
    server.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "h" });
    server.getTransaction.mockResolvedValue({ status: "SUCCESS", hash: "h" });
    const wallet = { getAddress: async () => ({ address: FAKE_PK }), signTransaction: vi.fn(async (xdr) => xdr) };
    await contractLib.setTreasuryDailyLimit(ASSET_A, 1000, wallet);
    const tx = server.simulateTransaction.mock.calls[0][0];
    expect(tx.operations[0].func.invokeContract().functionName().toString()).toBe("set_daily_limit");
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
  });

  it("setTreasuryDailyLimit requires a wallet address", async () => {
    await expect(contractLib.setTreasuryDailyLimit(ASSET_A, 1, {})).rejects.toThrow(/Wallet address/);
  });
});

describe("contract.ts — treasury without a configured vault", () => {
  it("returns empty data and refuses writes", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_AEGIS_VAULT_ID", "");
    const lib = await import("../src/lib/contract.ts");
    expect(await lib.getTreasurySnapshot()).toEqual([]);
    expect(await lib.getTreasuryRebalancePlan([1])).toEqual([]);
    await expect(lib.setTreasuryDailyLimit("C", 1, {})).rejects.toThrow(/not configured/);
  });
});
