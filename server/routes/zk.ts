import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { normalizeBase64 } from "../base64Utils.js";
import { proverLimiter } from "../middleware/rateLimiter.js";
import { AppError } from "../middleware/errorHandler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Prover singleton ──────────────────────────────────────────────────────────

interface NoirInstance {
  execute(
    inputs: Record<string, unknown>,
  ): Promise<{ witness: unknown; returnValue: unknown }>;
}

interface BackendInstance {
  instantiate(): Promise<void>;
  generateProof(
    witness: unknown,
  ): Promise<{ proof: Uint8Array; publicInputs?: unknown }>;
  destroy?(): Promise<void>;
}

let _noir: NoirInstance | null = null;
let _backend: BackendInstance | null = null;
let _ready = false;
let _readyPromise: Promise<void> | null = null;

async function ensureProver(): Promise<void> {
  if (_ready) return;
  if (!_readyPromise) {
    _readyPromise = initProver();
  }
  return _readyPromise;
}

async function initProver(): Promise<void> {
  const { Noir } = (await import("@noir-lang/noir_js")) as {
    Noir: new (circuit: unknown) => NoirInstance;
  };
  const { UltraHonkBackend } = (await import("@aztec/bb.js")) as unknown as {
    UltraHonkBackend: new (
      bytecode: string,
      opts: { threads: number },
    ) => BackendInstance;
  };
  const { cpus } = await import("os");

  // Walk up two directories from server/routes/ to reach the project root
  const circuitPath = join(
    __dirname,
    "..",
    "..",
    "circuits",
    "target",
    "aegis.json",
  );
  const circuit = JSON.parse(readFileSync(circuitPath, "utf-8")) as {
    bytecode: string;
  };
  circuit.bytecode = normalizeBase64(circuit.bytecode);

  _noir = new Noir(circuit);
  _backend = new UltraHonkBackend(circuit.bytecode, {
    threads: Math.max(1, cpus().length - 1),
  });

  console.log("[prover] Warming CRS...");
  await _backend.instantiate();
  _ready = true;
  console.log("[prover] Ready");
}

// ── Route handlers ────────────────────────────────────────────────────────────

function healthHandler(_req: Request, res: Response): void {
  res.json({ status: _ready ? "ready" : "warming", ready: _ready });
}

async function proveHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { inputs } = req.body as { inputs?: Record<string, unknown> };

    if (!inputs || typeof inputs !== "object") {
      throw new AppError(
        400,
        "Missing or invalid inputs field in request body",
      );
    }

    await ensureProver();

    if (!_noir || !_backend) {
      throw new AppError(503, "ZK prover is not ready — please retry");
    }

    const start = Date.now();

    const { witness, returnValue } = await _noir.execute(inputs);
    const proofResult = await _backend.generateProof(witness);
    const { proof } = proofResult;

    const nullifier =
      typeof returnValue === "string" ? returnValue : String(returnValue);

    console.log(
      `[prover] Proof generated in ${((Date.now() - start) / 1000).toFixed(1)}s`,
    );

    // ISP-053: Only return proof and nullifier; never return full profile PII
    // in verification responses. Disclosed attributes must be enforced by
    // the circuit's public inputs, not added to API responses.
    res.json({
      success: true,
      proof: Buffer.from(proof).toString("hex"),
      nullifier,
    });
  } catch (err) {
    next(err);
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export const zkRouter = Router();

zkRouter.get("/health", healthHandler);
zkRouter.post("/prove", proverLimiter, proveHandler);
