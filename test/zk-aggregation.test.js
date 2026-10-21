// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  DEVICE_PROFILES,
  HONK_PROOF_FIELDS,
  HONK_VK_FIELDS,
  WASM_MEMORY_CEILING,
  buildAggregationInputs,
  createAggregationProver,
  estimateOnDevice,
  fieldToBytes,
  hashVkFields,
  proofBytesToFields,
} from "../src/utils/zkProver.js";

// ---------------------------------------------------------------------------
// ZK aggregation spike (#605): the pure host-side pieces of recursive proof
// aggregation. Real proving/verification is exercised by
// scripts/spikes/zk_aggregation_benchmark.js (bb.js WASM, minutes per run).
// ---------------------------------------------------------------------------

const P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

function fakeProof(seed) {
  const bytes = new Uint8Array(HONK_PROOF_FIELDS * 32);
  bytes[31] = seed; // first field = seed
  return bytes;
}

const pi = (commitment, nullifier, shared = ["0x02", "0x71415580", "0x093a8d"]) => [
  commitment,
  ...shared,
  nullifier,
];

describe("fieldToBytes", () => {
  it("encodes big-endian 32-byte words", () => {
    const b = fieldToBytes("0x0102");
    expect(b).toHaveLength(32);
    expect([b[30], b[31]]).toEqual([1, 2]);
    expect(proofBytesToFields(fieldToBytes("0xabc"))[0]).toBe("0x" + "0".repeat(61) + "abc");
  });
});

describe("proofBytesToFields", () => {
  it("splits 32-byte big-endian words into hex fields", () => {
    const bytes = new Uint8Array(64);
    bytes[31] = 1;
    bytes[32] = 0xff;
    const [a, b] = proofBytesToFields(bytes);
    expect(BigInt(a)).toBe(1n);
    expect(b.startsWith("0xff")).toBe(true);
    expect(b).toHaveLength(66);
  });

  it("rejects buffers that are not whole fields", () => {
    expect(() => proofBytesToFields(new Uint8Array(33))).toThrow(/32-byte/);
    expect(() => proofBytesToFields([1, 2])).toThrow();
  });
});

describe("hashVkFields (host mirror of hash_vk in main.nr)", () => {
  it("absorbs rate-3 blocks, pads the tail and seeds the capacity with the length", async () => {
    const calls = [];
    // Toy permutation: records input, returns a recognisable state.
    const permute = async (state) => {
      calls.push(state.slice());
      return state.map((v, i) => (v + BigInt(i + 1)) % P);
    };
    const out = await hashVkFields(["1", "2", "3", "4"], permute);
    expect(calls).toHaveLength(2); // one full block + one partial
    expect(calls[0]).toEqual([1n, 2n, 3n, 4n << 64n]);
    // second block adds field 4 into lane 0 of the permuted state
    expect(calls[1][0]).toBe(2n + 4n);
    expect(BigInt(out)).toBe(calls[1][0] + 1n);
  });

  it("does not permute an extra time when the input fills whole blocks", async () => {
    let n = 0;
    await hashVkFields(["1", "2", "3"], async (s) => {
      n++;
      return s;
    });
    expect(n).toBe(1);
  });
});

describe("buildAggregationInputs", () => {
  const vkFields = Array.from({ length: HONK_VK_FIELDS }, (_, i) => `0x${(i + 1).toString(16)}`);
  const inner = [1, 2, 3].map((i) => ({ proof: fakeProof(i), publicInputs: pi(`0xc${i}`, `0xa${i}`) }));

  it("maps inner proofs onto the recursive_verifier ABI", () => {
    const inputs = buildAggregationInputs({ vkFields, vkHash: "0x1234", innerProofs: inner });
    expect(inputs.proofs).toHaveLength(3);
    expect(inputs.proofs[0]).toHaveLength(HONK_PROOF_FIELDS);
    expect(BigInt(inputs.proofs[2][0])).toBe(3n);
    expect(inputs.credential_commitments).toEqual(["0xc1", "0xc2", "0xc3"]);
    expect(inputs.nullifiers).toEqual(["0xa1", "0xa2", "0xa3"]);
    expect(inputs).toMatchObject({ inner_vk_hash: "0x1234", min_level: "0x02", incident_id: "0x093a8d" });
  });

  it("rejects mixed incidents, duplicate responders and wrong shapes before proving", () => {
    const mixed = [...inner, { proof: fakeProof(4), publicInputs: pi("0xc4", "0xa4", ["0x02", "0x71415580", "0x01"]) }];
    expect(() => buildAggregationInputs({ vkFields, vkHash: "0x1", innerProofs: mixed })).toThrow(/incident_id/);

    const dup = [...inner, { proof: fakeProof(5), publicInputs: pi("0xc5", "0x00a1") }];
    expect(() => buildAggregationInputs({ vkFields, vkHash: "0x1", innerProofs: dup })).toThrow(/duplicate/);

    const short = [{ proof: new Uint8Array(32 * 440), publicInputs: pi("0xc", "0xa") }];
    expect(() => buildAggregationInputs({ vkFields, vkHash: "0x1", innerProofs: short })).toThrow(/recursive: true/);

    expect(() => buildAggregationInputs({ vkFields: vkFields.slice(1), vkHash: "0x1", innerProofs: inner })).toThrow(/VK fields/);
    expect(() => buildAggregationInputs({ vkFields, vkHash: "0x1", innerProofs: [] })).toThrow(/Nothing/);
    const badPi = [{ proof: fakeProof(1), publicInputs: ["0x1"] }];
    expect(() => buildAggregationInputs({ vkFields, vkHash: "0x1", innerProofs: badPi })).toThrow(/public inputs/);
  });
});

describe("estimateOnDevice", () => {
  const measured = { provingMs1T: 40_000, provingMsMT: 16_000, measuredThreads: 4, peakMemoryBytes: 1.2 * 2 ** 30 };

  it("fits an Amdahl curve through the single- and multi-thread runs", () => {
    const bench = estimateOnDevice(measured, "benchmark");
    expect(bench.estProvingMs).toBe(16_000); // reproduces the measured point
    expect(bench.serialFraction).toBeCloseTo(0.2, 2);
  });

  it("flags memory ceilings per device", () => {
    expect(estimateOnDevice(measured, "desktop").feasible).toBe(true);
    const ios = estimateOnDevice(measured, "iosSafari");
    expect(ios.fitsWasmCeiling).toBe(false);
    expect(ios.feasible).toBe(false);
    expect(estimateOnDevice(measured, "budgetMobile").fitsTabBudget).toBe(false);
    expect(WASM_MEMORY_CEILING.ios).toBe(2 ** 30);
  });

  it("scales time by CPU class and thread count", () => {
    const budget = estimateOnDevice(measured, DEVICE_PROFILES.budgetMobile);
    expect(budget.estProvingMs).toBeGreaterThan(estimateOnDevice(measured, "midMobile").estProvingMs);
    expect(() => estimateOnDevice(measured, "toaster")).toThrow(/Unknown/);
  });
});

describe("createAggregationProver (injected backends)", () => {
  it("orchestrates witness → inner proofs → VK hash → outer proof", async () => {
    const log = [];
    class Fr {
      constructor(v) {
        this.v = BigInt(v) % P;
      }
      toString() {
        return "0x" + this.v.toString(16);
      }
    }
    class RawBuffer extends Uint8Array {}
    const vkAsFields = Array.from({ length: HONK_VK_FIELDS }, (_, i) => "0x" + (i + 7).toString(16));
    let n = 0;
    class UltraHonkBackend {
      constructor(bytecode, opts, circuitOpts) {
        this.bytecode = bytecode;
        log.push(["backend", bytecode, circuitOpts]);
      }
      async generateProof(witness, opts) {
        log.push(["prove", this.bytecode, opts]);
        n++;
        return { proof: fakeProof(n), publicInputs: pi(`0xc${n}`, `0xa${n}`) };
      }
      async getVerificationKey() {
        this.api = {
          acirVkAsFieldsUltraHonk: async (buf) => (buf instanceof RawBuffer ? vkAsFields : []),
          acirVerifyUltraHonk: async (proof, vk) => vk instanceof RawBuffer && proof.length === 5 * 32 + HONK_PROOF_FIELDS * 32,
        };
        return new Uint8Array(8);
      }
      async verifyProof() {
        return true;
      }
      async destroy() {}
    }
    const Barretenberg = {
      new: async () => ({
        poseidon2Permutation: async (s) => s.map((x, i) => new Fr(x.v + BigInt(i))),
        destroy: async () => {},
      }),
    };
    class Noir {
      constructor(circuit) {
        this.circuit = circuit;
      }
      async execute(inputs) {
        log.push(["execute", this.circuit.bytecode, Object.keys(inputs).length]);
        return { witness: new Uint8Array([1]) };
      }
    }
    const prover = createAggregationProver({
      innerCircuit: { bytecode: "inner" },
      outerCircuit: { bytecode: "outer" },
      threads: 2,
      loadBb: async () => ({ Barretenberg, Fr, RawBuffer, UltraHonkBackend }),
      loadNoir: async () => ({ Noir }),
    });
    const commitment = await prover.credentialCommitment({ secret: 1, level: 2, expiresAt: 3, salt: 4 });
    expect(BigInt(commitment)).toBe(1n);
    const inner = [];
    for (let i = 0; i < 3; i++) inner.push(await prover.proveInner({ any: i }));
    const outer = await prover.aggregate(inner, { keccak: true });
    expect(outer.proof).toBeInstanceOf(Uint8Array);
    expect(await prover.verifyInner(inner[0])).toBe(true); // proof re-joined with its 5 public inputs
    expect(log.filter(([k, b]) => k === "backend" && b === "inner")[0][2]).toEqual({ recursive: true });
    expect(log.at(-1)).toEqual(["prove", "outer", { keccak: true }]);
    expect((await prover.innerVk()).hash).toMatch(/^0x[0-9a-f]{64}$/);
    await prover.destroy();
  });
});
