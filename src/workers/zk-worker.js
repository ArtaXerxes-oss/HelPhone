let _noir = null;
let _backend = null;
let _Noir = null;
let _UltraHonkBackend = null;
let _circuitArtifact = null;
let _humanityCircuitArtifact = null;
let _humanityNoir = null;
let _humanityBackend = null;

const PROVER_INIT_TIMEOUT_MS = 2 * 60 * 1000;
const PROOF_TIMEOUT_MS = 5 * 60 * 1000;

const BB_LOG_PATTERNS = [
  { pattern: /Fetching bb wasm/i, label: "Loading Barretenberg WASM" },
  { pattern: /Compiling bb wasm/i, label: "Compiling Barretenberg WASM" },
  {
    pattern: /Compilation of bb wasm complete/i,
    label: "Barretenberg WASM ready",
  },
  {
    pattern: /Initializing bb wasm/i,
    label: "Starting Barretenberg prover worker",
  },
  {
    pattern: /Creating .* worker threads/i,
    label: "Starting Barretenberg worker threads",
  },
  {
    pattern: /Falling back to one thread/i,
    label: "Using single-thread prover mode",
  },
];


// ── WASM Linear Memory Pool (performance hardening: 512MB cap, buffer recycling) ──
const MAX_MEMORY_BYTES = 512 * 1024 * 1024;
const BUCKET_SIZES = [4 * 1024, 16 * 1024, 64 * 1024, 256 * 1024, 1 * 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];
function bucketFor(size) { for (const b of BUCKET_SIZES) if (size <= b) return b; return Math.ceil(size / (64 * 1024)) * 64 * 1024; }
class WorkerMemoryPool {
  constructor() {
    this.pools = new Map();
    for (const b of BUCKET_SIZES) this.pools.set(b, []);
    this.active = new Set();
    this.totalAllocated = 0;
  }
  allocate(size) {
    const bucket = bucketFor(size);
    if (this.totalAllocated + bucket > MAX_MEMORY_BYTES) throw new Error('Worker WASM memory cap 512MB exceeded');
    let buf = this.pools.get(bucket)?.pop();
    if (buf) { /* reuse */ } else { buf = new ArrayBuffer(bucket); }
    this.active.add(buf);
    this.totalAllocated += bucket;
    return buf;
  }
  release(bufOrView) {
    if (!bufOrView) return;
    const ab = bufOrView.buffer || bufOrView;
    if (!this.active.has(ab)) return;
    this.active.delete(ab);
    this.totalAllocated -= ab.byteLength;
    try { new Uint8Array(ab).fill(0); } catch {}
    const bucket = ab.byteLength;
    if (!this.pools.has(bucket)) this.pools.set(bucket, []);
    this.pools.get(bucket).push(ab);
  }
  stats() { return { totalAllocated: this.totalAllocated, pooled: [...this.pools.values()].reduce((a, b) => a + b.length, 0), active: this.active.size }; }
}
const memPool = new WorkerMemoryPool();

function createBarretenbergLogger(onLog) {
  const seen = new Set();
  return (message) => {
    const text = String(message || "");
    const match = BB_LOG_PATTERNS.find(({ pattern }) => pattern.test(text));
    if (match && !seen.has(match.label)) {
      seen.add(match.label);
      onLog(match.label);
    }
  };
}

function getThreadCount() {
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") return 1;
  const available =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4;
  return Math.max(1, Math.min(available, 8));
}

async function getCircuitArtifact() {
  if (_circuitArtifact) return _circuitArtifact;
  const circuitModule = await import("../../circuits/target/aegis.json");
  const circuit = circuitModule.default || circuitModule;
  _circuitArtifact = {
    ...circuit,
    bytecode: normalizeBase64(circuit.bytecode, "ZK circuit bytecode"),
    debug_symbols: circuit.debug_symbols
      ? normalizeBase64(circuit.debug_symbols, "ZK circuit debug symbols")
      : circuit.debug_symbols,
  };
  return _circuitArtifact;
}

async function getHumanityCircuitArtifact() {
  if (_humanityCircuitArtifact) return _humanityCircuitArtifact;
  const circuitModule = await import("../../circuits/target/humanity.json");
  const circuit = circuitModule.default || circuitModule;
  _humanityCircuitArtifact = {
    ...circuit,
    bytecode: normalizeBase64(circuit.bytecode, "Humanity ZK circuit bytecode"),
    debug_symbols: circuit.debug_symbols
      ? normalizeBase64(
          circuit.debug_symbols,
          "Humanity ZK circuit debug symbols",
        )
      : circuit.debug_symbols,
  };
  return _humanityCircuitArtifact;
}

function normalizeBase64(input, label = "Base64 value") {
  if (typeof input !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  let value = input.trim();
  const commaIndex = value.indexOf(",");
  if (
    commaIndex !== -1 &&
    /^data:.*;base64/i.test(value.slice(0, commaIndex))
  ) {
    value = value.slice(commaIndex + 1);
  }

  value = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`${label} contains invalid Base64 characters.`);
  }

  const remainder = value.length % 4;
  if (remainder === 1) {
    throw new Error(`${label} has an invalid Base64 length.`);
  }
  if (remainder > 0) {
    value += "=".repeat(4 - remainder);
  }

  return value;
}

async function init(onLog = () => {}) {
  if (_noir && _backend) return;
  if (typeof globalThis.Buffer === "undefined") {
    const { Buffer } = await import("buffer");
    globalThis.Buffer = Buffer;
  }
  if (!_Noir) {
    ({ Noir: _Noir } = await import("@noir-lang/noir_js"));
  }
  if (!_UltraHonkBackend) {
    ({ UltraHonkBackend: _UltraHonkBackend } = await import("@aztec/bb.js"));
  }
  const artifact = await getCircuitArtifact();
  _backend = new _UltraHonkBackend(
    artifact.bytecode,
    { threads: getThreadCount(), logger: createBarretenbergLogger(onLog) },
    { recursive: false },
  );
  _noir = new _Noir(artifact);
}

async function initHumanity(onLog = () => {}) {
  if (_humanityNoir && _humanityBackend) return;
  if (typeof globalThis.Buffer === "undefined") {
    const { Buffer } = await import("buffer");
    globalThis.Buffer = Buffer;
  }
  if (!_Noir) {
    ({ Noir: _Noir } = await import("@noir-lang/noir_js"));
  }
  if (!_UltraHonkBackend) {
    ({ UltraHonkBackend: _UltraHonkBackend } = await import("@aztec/bb.js"));
  }
  const artifact = await getHumanityCircuitArtifact();
  _humanityBackend = new _UltraHonkBackend(
    artifact.bytecode,
    { threads: getThreadCount(), logger: createBarretenbergLogger(onLog) },
    { recursive: false },
  );
  _humanityNoir = new _Noir(artifact);
}

async function runWithProgress(
  label,
  task,
  { onLog, timeoutMs, firstProgressMs = 8000, progressEveryMs = 15000, progressMessage },
) {
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  let done = false;
  let progressInterval = null;
  let timeoutId = null;

  const firstProgress = setTimeout(() => {
    if (done) return;
    onLog(progressMessage(elapsedSeconds(startedAt)));
    progressInterval = setInterval(() => {
      if (!done) onLog(progressMessage(elapsedSeconds(startedAt)));
    }, progressEveryMs);
  }, firstProgressMs);

  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      if (!done) {
        reject(
          new Error(
            `${label} timed out after ${Math.round(timeoutMs / 1000)} seconds. Check your connection to crs.aztec.network and try again.`,
          ),
        );
      }
    }, timeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve().then(task), timeout]);
  } finally {
    done = true;
    clearTimeout(firstProgress);
    if (timeoutId) clearTimeout(timeoutId);
    if (progressInterval) clearInterval(progressInterval);
  }
}

function elapsedSeconds(startedAt) {
  const now =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  return Math.round((now - startedAt) / 1000);
}

async function resetBackend() {
  const backend = _backend;
  _backend = null;
  if (backend && typeof backend.destroy === "function") {
    try {
      await backend.destroy();
    } catch (_) {}
  }
}

async function resetHumanityBackend() {
  const backend = _humanityBackend;
  _humanityBackend = null;
  if (backend && typeof backend.destroy === "function") {
    try {
      await backend.destroy();
    } catch (_) {}
  }
}

async function warmProver(onLog = () => {}) {
  if (isProverReady()) return;
  await init(onLog);
  onLog("Downloading CRS (cached after first run)");
  await _backend.instantiate();
  onLog("Prover ready");
}

function isProverReady() {
  return (
    _backend !== null &&
    _noir !== null &&
    _backend &&
    typeof _backend.generateProof === "function"
  );
}

self.onmessage = async (event) => {
  const data = event.data || {};
  // Support both legacy {type: 'prove'} and {action: 'prove'} protocols plus upstream actions
  const isProve = data.type === 'prove' || data.action === 'prove';
  if (isProve) {
    const id = data.id;
    const inputs = data.inputs || data.payload?.inputs;
    const progress = (msg) => self.postMessage({ type: 'progress', id, action: 'log', message: msg });
    let witnessBuf = null;
    let proofBuf = null;
    try {
      const onLog = progress;
      await warmProver(onLog);
      witnessBuf = memPool.allocate(256 * 1024);
      proofBuf = memPool.allocate(4 * 1024 * 1024);
      progress('Executing witness');
      // Ensure init
      if (!_noir || !_backend) await init(onLog);
      const artifact = await getCircuitArtifact();
      // Re-use init if needed (already warmed)
      const { witness, returnValue } = await _noir.execute(inputs);
      progress('Generating proof');
      const { proof } = await _backend.generateProof(witness);
      const proofBytes = proof instanceof Uint8Array ? proof : new Uint8Array(proof);
      self.postMessage({ type: 'done', id, action: 'proveComplete', proof: proofBytes, publicInputs: returnValue, memStats: memPool.stats() }, [proofBytes.buffer]);
    } catch (error) {
      self.postMessage({ type: 'error', id: data.id, action: 'error', error: error.message || String(error) });
    } finally {
      if (witnessBuf) memPool.release(witnessBuf);
      if (proofBuf) memPool.release(proofBuf);
    }
    return;
  }

  const { id, action, payload } = data;
  try {
    switch (action) {
      case "warmProver": {
        const onLog = (msg) => {
          self.postMessage({ id, action: "log", message: msg });
        };
        await warmProver(onLog);
        self.postMessage({ id, action: "warmProverComplete", success: true });
        break;
      }

      case "isProverReady": {
        const ready = isProverReady();
        self.postMessage({ id, action: "isProverReadyResult", ready });
        break;
      }

      case "initHumanity": {
        const onLog = (msg) => {
          self.postMessage({ id, action: "log", message: msg });
        };
        await initHumanity(onLog);
        self.postMessage({ id, action: "initHumanityComplete", success: true });
        break;
      }

      default:
        self.postMessage({
          id,
          action: "error",
          error: `Unknown action: ${action}`,
        });
    }
  } catch (error) {
    self.postMessage({
      id,
      action: "error",
      error: error.message || String(error),
    });
  }
};
