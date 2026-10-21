#!/usr/bin/env node
/**
 * Spike #605 — recursive UltraHonk proof aggregation benchmark (ADR-005).
 *
 *  1. Circuit sizes (backend gates) of responder_credential and of
 *     recursive_verifier folding N = 1, 2, 5 proofs.
 *  2. Five inner responder proofs (recursion-friendly flavour).
 *  3. Outer aggregation proofs for each N and thread count, each in a fresh
 *     child process so peak RSS (WASM memory never shrinks) is isolated.
 *  4. Verification latency with a cached VK: one aggregated proof vs N inner.
 *  5. The iOS 1 GiB WASM cap (memory.maximum = 2^14 pages).
 *  6. EVM artefacts: keccak-flavour outer proof + Solidity verifier size.
 *
 * Build the circuits first:  NARGO=/path/to/nargo bash circuits/recursive_verifier/build.sh 5
 *                            (and with 1, 2 for the scaling rows)
 * Usage:
 *   node scripts/spikes/zk_aggregation_benchmark.js [--threads 4]
 *        [--skip-single-thread] [--out docs/spikes/results/zk-aggregation.json]
 *        [--artifacts dir]   keep HonkVerifier.sol + keccak proof (default: a temp dir)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

import {
  DEVICE_PROFILES,
  HONK_PROOF_FIELDS,
  createAggregationProver,
  estimateOnDevice,
} from "../../src/utils/zkProver.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SELF = fileURLToPath(import.meta.url);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const log = (...a) => console.error("[zk]", ...a);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const INNER = join(ROOT, "circuits/responder_credential/target/responder_credential.json");
const outerPath = (n) => join(ROOT, `circuits/recursive_verifier/target/recursive_verifier${n === 5 ? "" : `_n${n}`}.json`);
const mb = (b) => Math.round(b / 2 ** 20);

// Proofs travel between processes as JSON.
const encodeProof = (p) => ({ proof: Buffer.from(p.proof).toString("base64"), publicInputs: p.publicInputs });
const decodeProof = (p) => ({ proof: new Uint8Array(Buffer.from(p.proof, "base64")), publicInputs: p.publicInputs });

// ── Child mode: one outer proof, isolated ───────────────────────────────────

async function child() {
  const job = readJson(arg("job"));
  const rss0 = process.memoryUsage().rss;
  const prover = createAggregationProver({
    innerCircuit: readJson(INNER),
    outerCircuit: readJson(outerPath(job.n)),
    threads: job.threads,
    memory: job.maxPages ? { maximum: job.maxPages } : undefined,
  });
  const inner = job.innerProofs.slice(0, job.n).map(decodeProof);
  const out = { n: job.n, threads: job.threads, maxPages: job.maxPages ?? null, keccak: Boolean(job.keccak) };
  try {
    await prover.innerVk(); // warm backend + VK outside the timed region
    const t0 = performance.now();
    const proof = await prover.aggregate(inner, { keccak: job.keccak });
    out.provingMs = Math.round(performance.now() - t0);
    out.proofBytes = proof.proof.length;
    out.publicInputs = proof.publicInputs.length;
    const tv = performance.now();
    await prover.verificationKey("outer", { keccak: job.keccak });
    out.vkGenMs = Math.round(performance.now() - tv);
    const verifyMs = [];
    let ok = true;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      ok = ok && (await prover.verifyOuter(proof, { keccak: job.keccak }));
      verifyMs.push(performance.now() - t);
    }
    out.verified = ok;
    out.verifyMs = { first: Math.round(verifyMs[0]), warmMedian: Math.round(verifyMs.slice(1).sort((a, b) => a - b)[2]) };
    if (job.solidity) {
      const { UltraHonkBackend } = await import("@aztec/bb.js");
      const backend = new UltraHonkBackend(readJson(outerPath(job.n)).bytecode, { threads: job.threads });
      const vk = await backend.getVerificationKey({ keccak: true });
      const sol = await backend.getSolidityVerifier(vk);
      out.solidityVerifierBytes = sol.length;
      if (job.solidityOut) {
        writeFileSync(job.solidityOut, sol);
        // Input for scripts/spikes/zk_verifier_gas.js (EVM gas + op counts).
        writeFileSync(job.solidityOut.replace(/\.sol$/, ".proof.json"), JSON.stringify(encodeProof(proof)));
      }
      await backend.destroy();
    }
  } catch (err) {
    out.error = String(err && err.message ? err.message : err).split("\n")[0];
  } finally {
    await prover.destroy().catch(() => {});
  }
  out.peakRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
  out.baselineRssMB = mb(rss0);
  process.stdout.write(JSON.stringify(out));
}

function runChild(job, tmp) {
  const jobPath = join(tmp, `job-${job.n}-${job.threads}-${job.maxPages ?? "d"}-${job.keccak ? "k" : "p"}.json`);
  writeFileSync(jobPath, JSON.stringify(job));
  const r = spawnSync(process.execPath, [SELF, "--child", "--job", jobPath], { encoding: "utf8", maxBuffer: 64 * 2 ** 20, timeout: 45 * 60 * 1000 });
  if (r.status !== 0 && !r.stdout) return { ...job, innerProofs: undefined, error: (r.stderr || `exit ${r.status}`).split("\n").filter(Boolean).slice(-1)[0] };
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { n: job.n, threads: job.threads, error: `unparseable child output (signal ${r.signal})` };
  }
}

// ── Parent mode ─────────────────────────────────────────────────────────────

async function main() {
  const threads = Number(arg("threads", Math.min(os.cpus().length, 8)));
  const outFile = arg("out", null);
  const skip1T = Boolean(arg("skip-single-thread", false));
  const results = {
    spike: "#605",
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1),
      bbjs: readJson(join(ROOT, "node_modules/@aztec/bb.js/package.json")).version,
      noirJs: readJson(join(ROOT, "node_modules/@noir-lang/noir_js/package.json")).version,
    },
  };
  const available = [1, 2, 5].filter((n) => existsSync(outerPath(n)));
  if (!existsSync(INNER) || !available.includes(5)) throw new Error("Build circuits first: bash circuits/recursive_verifier/build.sh 5");

  // 1. Circuit sizes
  const { Barretenberg, UltraHonkBackend } = await import("@aztec/bb.js");
  const bb = await Barretenberg.new({ threads });
  const size = async (path, recursive) => {
    const backend = new UltraHonkBackend(readJson(path).bytecode, { threads: 1 });
    const [gates, dyadic] = await bb.acirGetCircuitSizes(backend.acirUncompressedBytecode, recursive, true);
    return { gates, dyadicSize: dyadic, log2: Math.log2(dyadic) };
  };
  results.circuits = { responder_credential: await size(INNER, true) };
  for (const n of available) results.circuits[`recursive_verifier_n${n}`] = await size(outerPath(n), false);
  await bb.destroy();
  log("circuit sizes", results.circuits);

  // 2. Inner proofs
  const prover = createAggregationProver({ innerCircuit: readJson(INNER), outerCircuit: readJson(outerPath(5)), threads });
  const incident = { min_level: 2, now_epoch: 1900000000, incident_id: 604605 };
  const innerProofs = [];
  const innerMs = [];
  for (let i = 0; i < 5; i++) {
    const cred = { secret: 1000n + BigInt(i) * 7919n, level: 2 + (i % 3), expiresAt: 2000000000, salt: 0xabcn + BigInt(i) };
    const commitment = await prover.credentialCommitment(cred);
    const t0 = performance.now();
    const proof = await prover.proveInner({
      responder_secret: cred.secret.toString(),
      cert_level: cred.level,
      expires_at: cred.expiresAt,
      authority_salt: cred.salt.toString(),
      credential_commitment: commitment,
      ...incident,
    });
    innerMs.push(Math.round(performance.now() - t0));
    innerProofs.push(proof);
  }
  const tvk = performance.now();
  await prover.verificationKey("inner");
  const innerVkGenMs = Math.round(performance.now() - tvk);
  const verifyInnerMs = [];
  for (const p of innerProofs) {
    const t = performance.now();
    if (!(await prover.verifyInner(p))) throw new Error("inner proof failed to verify");
    verifyInnerMs.push(performance.now() - t);
  }
  const vk = await prover.innerVk();
  await prover.destroy();
  results.inner = {
    provingMs: innerMs,
    proofFields: innerProofs[0].proof.length / 32,
    expectedProofFields: HONK_PROOF_FIELDS,
    publicInputs: innerProofs[0].publicInputs.length,
    verifyMsEach: verifyInnerMs.map((v) => Math.round(v)),
    verifyAllFiveMs: Math.round(verifyInnerMs.reduce((a, b) => a + b, 0)),
    vkGenMs: innerVkGenMs,
    vkFields: vk.fields.length,
  };
  log("inner", results.inner);

  // 3-6. Outer proofs in isolated children
  // --artifacts keeps HonkVerifier.sol + its proof for zk_verifier_gas.js.
  const tmp = arg("artifacts", null) ? resolve(ROOT, arg("artifacts")) : mkdtempSync(join(os.tmpdir(), "hp-zk-"));
  mkdirSync(tmp, { recursive: true });
  const encoded = innerProofs.map(encodeProof);
  // Folding 2+ proofs exceeds the 4 GiB wasm32 ceiling (N=2 peaks ~3.9 GB
  // RSS then traps); those rows record the failure. The single-thread,
  // iOS-cap and EVM rows therefore use N=1.
  const jobs = [];
  for (const n of available) jobs.push({ n, threads });
  if (!skip1T) jobs.push({ n: 1, threads: 1 });
  jobs.push({ n: 1, threads, maxPages: 2 ** 14 }); // iOS 1 GiB cap
  jobs.push({ n: 1, threads, keccak: true, solidity: true, solidityOut: join(tmp, "HonkVerifier.sol") });
  results.outer = [];
  for (const job of jobs) {
    if (!available.includes(job.n)) continue;
    log(`outer n=${job.n} threads=${job.threads}${job.maxPages ? ` maxPages=${job.maxPages}` : ""}${job.keccak ? " keccak" : ""} …`);
    const r = runChild({ ...job, innerProofs: encoded }, tmp);
    log("  →", r);
    results.outer.push(r);
  }

  // Device extrapolation for the largest N that proved (needs both thread counts).
  const mt = results.outer.find((r) => r.n === 1 && r.threads === threads && !r.maxPages && !r.keccak && !r.error);
  const st = results.outer.find((r) => r.n === 1 && r.threads === 1 && !r.error);
  if (mt && st) {
    const measured = { provingMs1T: st.provingMs, provingMsMT: mt.provingMs, measuredThreads: threads, peakMemoryBytes: mt.peakRssMB * 2 ** 20 };
    results.deviceEstimates = Object.keys(DEVICE_PROFILES).map((d) => estimateOnDevice(measured, d));
    log("device estimates", results.deviceEstimates);
  }

  if (outFile) {
    const p = resolve(ROOT, outFile);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(results, null, 2) + "\n");
    log(`wrote ${outFile}`);
  }
}

if (process.argv.includes("--child")) await child();
else await main();
