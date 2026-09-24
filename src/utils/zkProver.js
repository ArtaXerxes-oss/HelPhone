/**
 * Client-side recursive proof aggregation helpers (spike #605, ADR-005).
 *
 * Folds N `responder_credential` UltraHonk proofs into one
 * `recursive_verifier` proof. Everything that talks to Barretenberg / Noir
 * is loaded lazily and injectable, so the pure parts (input assembly,
 * VK hashing, resource budgeting) are unit-testable without WASM.
 *
 * Not wired into the app: `src/workers/zk-worker.js` still proves the
 * single-location `aegis` circuit. See docs/adr/ADR-005-zk-proof-aggregation.md.
 *
 * Pinned to nargo 1.0.0-beta.9 + bb.js 0.87.x (see circuits/recursive_verifier).
 */

export const HONK_PROOF_FIELDS = 456;
export const HONK_VK_FIELDS = 112;
export const INNER_PUBLIC_INPUTS = 5; // commitment, min_level, now_epoch, incident_id, nullifier
export const WASM_PAGE_BYTES = 65536;

/**
 * WASM memory ceilings bb.js actually enforces (see bb.js
 * `getDefaultMaximumMemoryPages`): 4 GiB (wasm32 limit) everywhere except
 * iOS browsers, where it caps at 1 GiB because Safari kills larger tabs.
 */
export const WASM_MEMORY_CEILING = {
  default: 2 ** 16 * WASM_PAGE_BYTES,
  ios: 2 ** 14 * WASM_PAGE_BYTES,
};

/**
 * Device classes used to extrapolate the desktop measurements. The
 * slowdown factors are ASSUMPTIONS (single-core throughput relative to the
 * measured machine), not measurements; the ADR states them as such.
 */
export const DEVICE_PROFILES = {
  desktop: { label: "High-end desktop (8 threads)", threads: 8, memoryCeiling: WASM_MEMORY_CEILING.default, tabBudget: 4 * 2 ** 30, cpuSlowdown: 0.5 },
  benchmark: { label: "Measured machine (i5-4300U, 4 threads)", threads: 4, memoryCeiling: WASM_MEMORY_CEILING.default, tabBudget: 4 * 2 ** 30, cpuSlowdown: 1 },
  midMobile: { label: "Mid-range Android (4 threads, 4 GB RAM)", threads: 4, memoryCeiling: WASM_MEMORY_CEILING.default, tabBudget: 1.5 * 2 ** 30, cpuSlowdown: 2 },
  budgetMobile: { label: "Budget Android (2 usable threads, 2-3 GB RAM)", threads: 2, memoryCeiling: WASM_MEMORY_CEILING.default, tabBudget: 0.8 * 2 ** 30, cpuSlowdown: 4 },
  iosSafari: { label: "iPhone Safari (1 GiB WASM cap)", threads: 4, memoryCeiling: WASM_MEMORY_CEILING.ios, tabBudget: WASM_MEMORY_CEILING.ios, cpuSlowdown: 1.5 },
};

const hex32 = (bytes) => "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Splits a raw UltraHonk proof (32-byte big-endian words) into field strings. */
export function proofBytesToFields(proof) {
  if (!(proof instanceof Uint8Array) || proof.length % 32 !== 0)
    throw new Error("UltraHonk proof must be a Uint8Array of 32-byte words");
  const out = new Array(proof.length / 32);
  for (let i = 0; i < out.length; i++) out[i] = hex32(proof.subarray(i * 32, i * 32 + 32));
  return out;
}

/**
 * Poseidon2 sponge (width 4, rate 3) over VK fields — the host-side mirror
 * of `hash_vk` in circuits/recursive_verifier/src/main.nr.
 * `permute` is bb.js `Barretenberg#poseidon2Permutation` (Fr[] → Fr[]) or
 * any function over bigint[4] → bigint[4]; values are handled as bigint.
 */
export async function hashVkFields(vkFields, permute, { toFr = (x) => x, fromFr = (x) => BigInt(x.toString()) } = {}) {
  const P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
  const add = (a, b) => (a + b) % P;
  let state = [0n, 0n, 0n, (BigInt(vkFields.length) << 64n) % P];
  let k = 0;
  const run = async () => {
    const outFr = await permute(state.map(toFr));
    state = outFr.map(fromFr);
  };
  for (const f of vkFields) {
    state[k] = add(state[k], BigInt(f));
    if (++k === 3) {
      await run();
      k = 0;
    }
  }
  if (k !== 0) await run();
  return "0x" + state[0].toString(16).padStart(64, "0");
}

/**
 * Validates N inner proofs and assembles the recursive_verifier ABI inputs.
 * Everything checked here is also enforced in-circuit; checking first avoids
 * spending tens of seconds proving something that will fail.
 *
 * @param {{ vkFields: string[], vkHash: string,
 *           innerProofs: { proof: Uint8Array, publicInputs: string[] }[] }} args
 */
export function buildAggregationInputs({ vkFields, vkHash, innerProofs }) {
  if (vkFields.length !== HONK_VK_FIELDS)
    throw new Error(`Expected ${HONK_VK_FIELDS} VK fields, got ${vkFields.length}`);
  if (!innerProofs.length) throw new Error("Nothing to aggregate");
  const norm = (v) => BigInt(v);
  const [first] = innerProofs;
  const shared = first.publicInputs.slice(1, 4).map(norm);
  const seen = new Set();
  const commitments = [];
  const nullifiers = [];
  const proofs = innerProofs.map(({ proof, publicInputs }, i) => {
    if (publicInputs.length !== INNER_PUBLIC_INPUTS)
      throw new Error(`Proof ${i}: expected ${INNER_PUBLIC_INPUTS} public inputs, got ${publicInputs.length}`);
    const fields = proofBytesToFields(proof);
    if (fields.length !== HONK_PROOF_FIELDS)
      throw new Error(`Proof ${i}: expected ${HONK_PROOF_FIELDS} fields, got ${fields.length} (was it made with { recursive: true }?)`);
    publicInputs.slice(1, 4).forEach((v, j) => {
      if (norm(v) !== shared[j]) throw new Error(`Proof ${i}: min_level/now_epoch/incident_id differ from proof 0`);
    });
    const nullifier = norm(publicInputs[4]);
    if (seen.has(nullifier)) throw new Error(`Proof ${i}: duplicate responder nullifier`);
    seen.add(nullifier);
    commitments.push(publicInputs[0]);
    nullifiers.push(publicInputs[4]);
    return fields;
  });
  return {
    verification_key: vkFields,
    proofs,
    inner_vk_hash: vkHash,
    credential_commitments: commitments,
    nullifiers,
    min_level: first.publicInputs[1],
    now_epoch: first.publicInputs[2],
    incident_id: first.publicInputs[3],
  };
}

/**
 * Extrapolates a measured proving run to a device profile.
 *
 * Proving time is scaled by the profile's CPU slowdown and by thread count
 * using the measured single- vs multi-thread speed-up; memory is compared
 * against both the WASM ceiling and the tab budget.
 *
 * @param {{ provingMs1T: number, provingMsMT: number, measuredThreads: number,
 *           peakMemoryBytes: number }} measured
 * @param {keyof DEVICE_PROFILES | object} device
 */
export function estimateOnDevice(measured, device) {
  const profile = typeof device === "string" ? DEVICE_PROFILES[device] : device;
  if (!profile) throw new Error(`Unknown device profile: ${device}`);
  const { provingMs1T, provingMsMT, measuredThreads, peakMemoryBytes } = measured;
  // Amdahl fit from the two measured points: t(n) = t1 * (s + (1 - s) / n).
  const ratio = provingMsMT / provingMs1T;
  const serial = measuredThreads > 1 ? Math.min(1, Math.max(0, (ratio - 1 / measuredThreads) / (1 - 1 / measuredThreads))) : 1;
  const threads = Math.max(1, profile.threads);
  const provingMs = provingMs1T * (serial + (1 - serial) / threads) * profile.cpuSlowdown;
  const fitsWasm = peakMemoryBytes <= profile.memoryCeiling;
  const fitsTab = peakMemoryBytes <= profile.tabBudget;
  return {
    device: profile.label,
    estProvingMs: Math.round(provingMs),
    serialFraction: +serial.toFixed(2),
    peakMemoryMB: Math.round(peakMemoryBytes / 2 ** 20),
    fitsWasmCeiling: fitsWasm,
    fitsTabBudget: fitsTab,
    feasible: fitsWasm && fitsTab,
  };
}

/**
 * Lazily-loaded prover for the inner and outer circuits.
 *
 * @param {object} options
 * @param {object} options.innerCircuit compiled responder_credential.json
 * @param {object} options.outerCircuit compiled recursive_verifier.json
 * @param {number} [options.threads]
 * @param {{ initial?: number, maximum?: number }} [options.memory] WASM pages
 * @param {() => Promise<object>} [options.loadBb] resolves the bb.js module
 * @param {() => Promise<object>} [options.loadNoir] resolves @noir-lang/noir_js
 */
export function createAggregationProver({ innerCircuit, outerCircuit, threads, memory, loadBb, loadNoir } = {}) {
  const importBb = loadBb || (() => import("@aztec/bb.js"));
  const importNoir = loadNoir || (() => import("@noir-lang/noir_js"));
  const opts = { ...(threads ? { threads } : {}), ...(memory ? { memory } : {}) };
  let mods = null;
  let bb = null;
  let innerBackend = null;
  let outerBackend = null;
  let vk = null;
  const vkBytesCache = new Map();

  const load = async () => {
    if (!mods) {
      const [bbMod, noirMod] = await Promise.all([importBb(), importNoir()]);
      mods = { ...bbMod, Noir: noirMod.Noir };
    }
    return mods;
  };

  return {
    /** Poseidon2 commitment an authority would publish for a credential. */
    async credentialCommitment({ secret, level, expiresAt, salt }) {
      const { Barretenberg, Fr } = await load();
      bb = bb || (await Barretenberg.new(opts));
      const [c] = await bb.poseidon2Permutation([secret, level, expiresAt, salt].map((v) => new Fr(BigInt(v))));
      return c.toString();
    },

    /** Proves one responder_credential instance (recursion-friendly flavour). */
    async proveInner(inputs) {
      const { Noir, UltraHonkBackend } = await load();
      innerBackend = innerBackend || new UltraHonkBackend(innerCircuit.bytecode, opts, { recursive: true });
      const { witness } = await new Noir(innerCircuit).execute(inputs);
      return innerBackend.generateProof(witness);
    },

    /** Inner VK as fields + its Poseidon2 hash (cached). */
    async innerVk() {
      if (vk) return vk;
      const { Barretenberg, Fr, RawBuffer, UltraHonkBackend } = await load();
      innerBackend = innerBackend || new UltraHonkBackend(innerCircuit.bytecode, opts, { recursive: true });
      // Don't use generateRecursiveProofArtifacts(): in bb.js 0.87.x it passes
      // the VK as a plain Uint8Array, which gets a second length prefix, so
      // every field is shifted by 4 bytes and in-circuit verification fails
      // ("Builder failure when we have real witnesses"). generateProof() wraps
      // the same buffer in RawBuffer; do the same.
      const vkBytes = await innerBackend.getVerificationKey();
      const vkAsFields = (await innerBackend.api.acirVkAsFieldsUltraHonk(new RawBuffer(vkBytes))).map(String);
      bb = bb || (await Barretenberg.new(opts));
      const hash = await hashVkFields(vkAsFields, (s) => bb.poseidon2Permutation(s), { toFr: (x) => new Fr(x) });
      vk = { fields: vkAsFields, hash };
      return vk;
    },

    /** Folds inner proofs into one outer proof. */
    async aggregate(innerProofs, { keccak = false } = {}) {
      const { Noir, UltraHonkBackend } = await load();
      const { fields, hash } = await this.innerVk();
      const inputs = buildAggregationInputs({ vkFields: fields, vkHash: hash, innerProofs });
      outerBackend = outerBackend || new UltraHonkBackend(outerCircuit.bytecode, opts, { recursive: false });
      const { witness } = await new Noir(outerCircuit).execute(inputs);
      return outerBackend.generateProof(witness, keccak ? { keccak: true } : undefined);
    },

    /**
     * Verification keys, cached. bb.js `verifyProof()` regenerates the VK
     * from the circuit on every call, which costs far more than verifying
     * (tens of seconds for the outer circuit); a real verifier holds the VK.
     */
    async verificationKey(which, { keccak = false } = {}) {
      const key = `${which}:${keccak}`;
      if (!vkBytesCache.has(key)) {
        const backend = which === "inner" ? innerBackend : outerBackend;
        vkBytesCache.set(key, await backend.getVerificationKey(keccak ? { keccak: true } : undefined));
      }
      return vkBytesCache.get(key);
    },

    async verifyInner(proofData) {
      return verifyWithVk(innerBackend, await this.verificationKey("inner"), proofData, false);
    },

    async verifyOuter(proofData, { keccak = false } = {}) {
      return verifyWithVk(outerBackend, await this.verificationKey("outer", { keccak }), proofData, keccak);
    },

    async destroy() {
      await Promise.all([innerBackend?.destroy(), outerBackend?.destroy(), bb?.destroy()]);
      innerBackend = outerBackend = bb = null;
    },
  };

  async function verifyWithVk(backend, vkBytes, { proof, publicInputs }, keccak) {
    const { RawBuffer } = await load();
    const withInputs = new Uint8Array(publicInputs.length * 32 + proof.length);
    publicInputs.forEach((f, i) => withInputs.set(fieldToBytes(f), i * 32));
    withInputs.set(proof, publicInputs.length * 32);
    const verify = keccak ? backend.api.acirVerifyUltraKeccakHonk : backend.api.acirVerifyUltraHonk;
    return verify.call(backend.api, withInputs, new RawBuffer(vkBytes));
  }
}

/** Hex/decimal field string → 32-byte big-endian word. */
export function fieldToBytes(field) {
  let v = BigInt(field);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
