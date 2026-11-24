import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import {
  SUSTAINABILITY_FEE_BPS,
  computeSustainabilityFee,
  normalizeSustainabilityStats,
  normalizeMaintainerGrant,
  getSustainabilityStats,
} from "../src/lib/contract";
import { SustainabilityPanel } from "../src/pages/VaultDashboard.jsx";

// #587 — Open source sustainability reserve (contracts/helphone_dao).
// On-chain behaviour is covered by `cargo test` in contracts/helphone_dao;
// these tests pin the frontend decoding + fee math to the contract's.

describe("computeSustainabilityFee", () => {
  it("takes 1% and rounds down like the contract's i128 math", () => {
    expect(SUSTAINABILITY_FEE_BPS).toBe(100);
    expect(computeSustainabilityFee(250_000)).toBe(2_500n);
    expect(computeSustainabilityFee(199n)).toBe(1n);
    expect(computeSustainabilityFee(99)).toBe(0n);
  });

  it("returns 0 for non-positive amounts", () => {
    expect(computeSustainabilityFee(0)).toBe(0n);
    expect(computeSustainabilityFee(-500)).toBe(0n);
  });
});

describe("normalizeSustainabilityStats", () => {
  it("maps scValToNative output (BigInt i128 / u32) to numbers", () => {
    const stats = normalizeSustainabilityStats({
      token: "CTOKEN",
      fee_bps: 100,
      reserve: 60_000n,
      total_collected: 100_000n,
      total_disbursed: 40_000n,
      grants_proposed: 3,
      grants_disbursed: 1,
      maintainers_funded: 1,
    });
    expect(stats).toEqual({
      token: "CTOKEN",
      feeBps: 100,
      reserve: 60_000,
      totalCollected: 100_000,
      totalDisbursed: 40_000,
      grantsProposed: 3,
      grantsDisbursed: 1,
      maintainersFunded: 1,
    });
  });

  it("returns null for a missing result and zero-fills absent fields", () => {
    expect(normalizeSustainabilityStats(null)).toBeNull();
    expect(normalizeSustainabilityStats({ token: undefined }).reserve).toBe(0);
  });
});

describe("normalizeMaintainerGrant", () => {
  it("decodes the unit-enum status and u64/i128 fields", () => {
    const grant = normalizeMaintainerGrant({
      proposal_id: 7n,
      maintainer: "GMAINTAINER",
      package: "npm:@stellar/stellar-sdk",
      amount: 40_000n,
      status: ["Disbursed"],
      disbursed_at: 1_700_000_000n,
    });
    expect(grant).toEqual({
      proposalId: 7,
      maintainer: "GMAINTAINER",
      package: "npm:@stellar/stellar-sdk",
      amount: 40_000,
      status: "Disbursed",
      disbursedAt: 1_700_000_000,
    });
    expect(
      normalizeMaintainerGrant({ status: ["Pending"], disbursed_at: 0n })
        .status,
    ).toBe("Pending");
  });
});

describe("getSustainabilityStats", () => {
  it("returns null without a deployed DAO contract", async () => {
    expect(await getSustainabilityStats()).toBeNull();
  });
});

describe("SustainabilityPanel", () => {
  it("renders reserve and grant statistics", () => {
    render(
      createElement(SustainabilityPanel, {
        stats: {
          token: "CTOKEN",
          feeBps: 100,
          reserve: 600_000_000,
          totalCollected: 1_000_000_000,
          totalDisbursed: 400_000_000,
          grantsProposed: 3,
          grantsDisbursed: 1,
          maintainersFunded: 1,
        },
      }),
    );
    expect(screen.getByText("OPEN SOURCE SUSTAINABILITY")).toBeInTheDocument();
    expect(screen.getByText("60.00")).toBeInTheDocument();
    expect(screen.getByText("40.00")).toBeInTheDocument();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    expect(screen.getByText("1.00%")).toBeInTheDocument();
  });

  it("explains how to enable the panel when the DAO is not deployed", () => {
    render(createElement(SustainabilityPanel, { stats: null }));
    expect(
      screen.getByText(/VITE_HELPHONE_DAO_CONTRACT_ID/),
    ).toBeInTheDocument();
  });
});
