import { createElement as h } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { nativeToScVal, StrKey } from "@stellar/stellar-sdk";
import {
  classifyOracleError,
  ORACLE_ERROR_MESSAGES,
} from "../src/lib/treasury.ts";
import { OracleQuoteForm } from "../src/components/TreasuryPanel.jsx";

// #543 — Oracle quote client, error mapping and the dashboard quote form.

const state = vi.hoisted(() => ({ servers: [] }));
const FAKE_PK = "GB6Q7N7EHW5H6HZKAIIO4R2VTB7JEBX5XN4FOXXT6YTDA36Z7ALA656J";

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal();
  class Server {
    constructor() {
      this.simulateTransaction = vi.fn();
      state.servers.push(this);
    }
  }
  return {
    ...actual,
    rpc: { ...actual.rpc, Server },
    Keypair: { ...actual.Keypair, random: () => ({ publicKey: () => FAKE_PK, sign: (d) => d }) },
  };
});

const DAO = StrKey.encodeContract(Buffer.alloc(32, 9));
const XLM = StrKey.encodeContract(Buffer.alloc(32, 1));
const USDC = StrKey.encodeContract(Buffer.alloc(32, 2));

describe("classifyOracleError", () => {
  it.each([
    ["Error(Contract, #13)", "not-configured"],
    ["HostError: Error(Contract, #14)", "stale"],
    ["Error(Contract, #15)", "unavailable"],
    ["Error(Contract, #16)", "invalid"],
    ["Error(Contract, #17)", "invalid"],
    ["Error(Contract, #18)", "invalid"],
    ["Error(Contract, #99)", "unknown"],
    ["boom", "unknown"],
  ])("%s -> %s", (msg, kind) => {
    expect(classifyOracleError(new Error(msg))).toBe(kind);
    expect(classifyOracleError(msg)).toBe(kind);
  });
  it("handles nullish input", () => {
    expect(classifyOracleError(undefined)).toBe("unknown");
  });
  it("has a message for every kind", () => {
    for (const kind of ["stale", "unavailable", "invalid", "not-configured", "unknown"])
      expect(ORACLE_ERROR_MESSAGES[kind]).toBeTruthy();
  });
});

describe("contract.ts — getOracleQuote", () => {
  let lib;
  let server;
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("VITE_HELPHONE_DAO_ID", DAO);
    lib = await import("../src/lib/contract.ts");
    server = state.servers.at(-1);
  });

  it("returns the converted amount from quote_conversion", async () => {
    server.simulateTransaction.mockResolvedValue({
      result: { retval: nativeToScVal(1_200_000_000n, { type: "i128" }) },
    });
    const q = await lib.getOracleQuote(XLM, USDC, 10_000_000_000);
    expect(q).toEqual({ fromToken: XLM, toToken: USDC, amountIn: 10_000_000_000, amountOut: 1_200_000_000 });
    const tx = server.simulateTransaction.mock.calls[0][0];
    expect(tx.operations[0].func.invokeContract().functionName().toString()).toBe("quote_conversion");
  });

  it("surfaces a stale-feed simulation error as a friendly message", async () => {
    server.simulateTransaction.mockResolvedValue({ error: "HostError: Error(Contract, #14)" });
    await expect(lib.getOracleQuote(XLM, USDC, 1)).rejects.toThrow(/more than 1 hour old/);
  });

  it("maps thrown RPC errors the same way", async () => {
    server.simulateTransaction.mockRejectedValue(new Error("Error(Contract, #15)"));
    await expect(lib.getOracleQuote(XLM, USDC, 1)).rejects.toThrow(/no price/);
  });

  it("errors when the simulation has no result", async () => {
    server.simulateTransaction.mockResolvedValue({});
    await expect(lib.getOracleQuote(XLM, USDC, 1)).rejects.toThrow(/Could not fetch/);
  });

  it("requires the DAO contract id", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_HELPHONE_DAO_ID", "");
    const bare = await import("../src/lib/contract.ts");
    await expect(bare.getOracleQuote(XLM, USDC, 1)).rejects.toThrow(/not configured/);
  });
});

describe("<OracleQuoteForm />", () => {
  const fill = (from, to, amount) => {
    fireEvent.change(screen.getByLabelText("From token"), { target: { value: from } });
    fireEvent.change(screen.getByLabelText("To token"), { target: { value: to } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: amount } });
    fireEvent.submit(screen.getByRole("form", { name: "Oracle conversion quote" }));
  };

  it("requests a quote in stroops and shows the converted amount", async () => {
    const getQuote = vi.fn().mockResolvedValue({ amountIn: 10_000_000_000, amountOut: 1_200_000_000 });
    render(h(OracleQuoteForm, { getQuote }));
    fill(` ${XLM} `, USDC, "1000");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("120.00"));
    expect(getQuote).toHaveBeenCalledWith(XLM, USDC, 10_000_000_000);
    cleanup();
  });

  it("validates input before calling the oracle", () => {
    const getQuote = vi.fn();
    render(h(OracleQuoteForm, { getQuote }));
    fill("", USDC, "5");
    expect(screen.getByRole("alert").textContent).toMatch(/positive amount/);
    fill(XLM, USDC, "0");
    expect(getQuote).not.toHaveBeenCalled();
    cleanup();
  });

  it("shows oracle failures (e.g. stale price) to the user", async () => {
    const getQuote = vi.fn().mockRejectedValue(new Error(ORACLE_ERROR_MESSAGES.stale));
    render(h(OracleQuoteForm, { getQuote }));
    fill(XLM, USDC, "1");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/1 hour old/));
    cleanup();
  });

  it("falls back to a generic message for errors without text", async () => {
    render(h(OracleQuoteForm, { getQuote: vi.fn().mockRejectedValue({}) }));
    fill(XLM, USDC, "1");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Could not fetch/));
    cleanup();
  });
});
