import { describe, expect, it } from "vitest";
import { compareStorageLayouts, estimateSorobanStorageBudget } from "../src/services/sorobanStorageBudget.js";

describe("Soroban storage budget estimator", () => {
  it("estimates read, write, and rent fees per entry", () => {
    const budget = estimateSorobanStorageBudget([
      { key: "incident", bytes: 900, reads: 1, writes: 1, ttlLedgers: 10, persistent: true },
      { key: "ack_bitmap", bytes: 1300, reads: 2, writes: 1, ttlLedgers: 20, persistent: false },
    ], {
      feeConfig: {
        transactionBaseFee: 100,
        readEntryFee: 10,
        readByteFee: 1,
        writeEntryFee: 20,
        writeByteFee: 2,
        rentFeePerKbPerLedger: 3,
      },
    });

    expect(budget.entries).toBe(2);
    expect(budget.persistentBytes).toBe(900);
    expect(budget.temporaryBytes).toBe(1300);
    expect(budget.rentFee).toBe(150);
    expect(budget.transactionFee).toBeGreaterThan(budget.rentFee);
    expect(budget.byEntry).toHaveLength(2);
  });

  it("compares packed and normalized layouts", () => {
    const result = compareStorageLayouts({
      normalized: [
        { key: "incident", bytes: 512, writes: 1, ttlLedgers: 100 },
        { key: "ack", bytes: 512, writes: 10, ttlLedgers: 100 },
      ],
      packed: [
        { key: "bucket", bytes: 640, writes: 1, ttlLedgers: 100 },
        { key: "ack_agg", bytes: 180, writes: 10, ttlLedgers: 100 },
      ],
    });

    expect(result.packed.bytes).toBeLessThan(result.normalized.bytes);
  });
});
