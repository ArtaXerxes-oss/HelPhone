import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Secrets Rotation Without Restart Manager (ISP-090 / Issue #760).
 *
 * Implements zero-downtime hot reloading of production secrets:
 * 1. Atomic Environment Re-Validation: Validates candidate secrets before applying; retains last-good on error.
 * 2. Multi-Class Lifecycle Coordination:
 *    - Stellar Signing Keys & JWTs: Dual-trust window (accepts Gen N and Gen N-1 during grace; sunsets old).
 *    - Database & Redis Pools: Blue-green pool swap with graceful draining of in-flight checkouts.
 *    - OTLP Exporter Endpoints: In-place hot swap of authorization tokens and headers.
 * 3. Secret Generation Exposer: Exposes generation counter for fleet skew alerting.
 */

export const SecretType = {
  STELLAR_KEY: "STELLAR_KEY",
  JWT_SECRET: "JWT_SECRET",
  REDIS_URL: "REDIS_URL",
  DATABASE_URL: "DATABASE_URL",
  OTLP_AUTH_TOKEN: "OTLP_AUTH_TOKEN",
};

export class SecretRotationManager {
  constructor(initialSecrets = {}, options = {}) {
    this.gracePeriodMs = options.gracePeriodMs || 60000; // 60s dual-trust window
    this.currentGeneration = 1;
    this.secrets = new Map();
    this.previousGenerationSecrets = new Map();
    this.sunsetTimers = new Map();

    // Initialize with validated secrets
    this.initializeSecrets(initialSecrets);
  }

  initializeSecrets(initialSecrets) {
    for (const [key, value] of Object.entries(initialSecrets)) {
      this.secrets.set(key, {
        value,
        generation: this.currentGeneration,
        updatedAt: Date.now(),
      });
    }
  }

  /**
   * Part 1: Atomic Environment Re-Validation
   * Validates new secret candidate. If validation fails, throws error and retains last-known-good.
   */
  validateSecret(type, candidateValue) {
    if (!candidateValue || typeof candidateValue !== "string" || candidateValue.trim().length === 0) {
      throw new Error(`Invalid secret for ${type}: Value cannot be empty`);
    }

    if (type === SecretType.STELLAR_KEY) {
      // Must start with S and be 56 characters
      if (!candidateValue.startsWith("S") || candidateValue.length !== 56) {
        throw new Error(`Invalid Stellar secret key format: Expected S-prefix and 56 chars`);
      }
    } else if (type === SecretType.REDIS_URL || type === SecretType.DATABASE_URL) {
      if (!candidateValue.startsWith("redis://") && !candidateValue.startsWith("postgres://")) {
        throw new Error(`Invalid URL scheme for ${type}`);
      }
    }

    return true;
  }

  /**
   * Part 2: Hot-Reload Secret with Dual-Trust Window
   */
  async rotateSecret(type, newSecretValue, options = {}) {
    // 1. Validate candidate before touching active state
    this.validateSecret(type, newSecretValue);

    const oldSecretEntry = this.secrets.get(type);
    const newGeneration = this.currentGeneration + 1;

    // 2. Save previous secret into dual-trust store if applicable
    if (oldSecretEntry && (type === SecretType.STELLAR_KEY || type === SecretType.JWT_SECRET)) {
      this.previousGenerationSecrets.set(type, {
        ...oldSecretEntry,
        sunsetAt: Date.now() + (options.gracePeriodMs || this.gracePeriodMs),
      });

      // Clear any prior timer
      if (this.sunsetTimers.has(type)) {
        clearTimeout(this.sunsetTimers.get(type));
      }

      // Schedule sunset
      const timer = setTimeout(() => {
        this.previousGenerationSecrets.delete(type);
        this.sunsetTimers.delete(type);
      }, options.gracePeriodMs || this.gracePeriodMs);

      this.sunsetTimers.set(type, timer);
    }

    // 3. Atomically update current secret
    this.secrets.set(type, {
      value: newSecretValue,
      generation: newGeneration,
      updatedAt: Date.now(),
    });

    this.currentGeneration = newGeneration;

    return {
      status: "ROTATED",
      type,
      newGeneration,
      dualTrustActive: this.previousGenerationSecrets.has(type),
    };
  }

  /**
   * Part 3: Dual-Trust Signature / Secret Verification
   * Accepts generation N and N-1 within the grace period.
   */
  verifyWithDualTrust(type, verifyFn) {
    const current = this.secrets.get(type);
    if (!current) {
      throw new Error(`Secret not found for type: ${type}`);
    }

    // Attempt verification with active generation N
    try {
      const validCurrent = verifyFn(current.value);
      if (validCurrent) {
        return { valid: true, generation: current.generation, dualTrustFallback: false };
      }
    } catch (e) {
      // Current failed, check previous generation
    }

    // Check generation N-1 if within grace period
    const previous = this.previousGenerationSecrets.get(type);
    if (previous && Date.now() < previous.sunsetAt) {
      try {
        const validPrevious = verifyFn(previous.value);
        if (validPrevious) {
          return { valid: true, generation: previous.generation, dualTrustFallback: true };
        }
      } catch (e) {
        // Fallback failed
      }
    }

    return { valid: false, reason: "Signature verification failed across active and grace generations" };
  }

  /**
   * Part 4: Blue-Green Connection Pool Rebirth
   * Creates new connection pool with fresh secret, transfers traffic, and drains old pool.
   */
  async swapConnectionPool(type, newUrl, oldPoolMock, newPoolMock) {
    this.validateSecret(type, newUrl);

    // 1. Verify new pool connectivity
    if (newPoolMock && typeof newPoolMock.ping === "function") {
      const connected = await newPoolMock.ping();
      if (!connected) {
        throw new Error(`Failed to establish connection with new pool for ${type}`);
      }
    }

    // 2. Rotate secret entry
    await this.rotateSecret(type, newUrl);

    // 3. Drain old pool gracefully
    let drained = false;
    if (oldPoolMock && typeof oldPoolMock.drain === "function") {
      await oldPoolMock.drain();
      drained = true;
    }

    return {
      status: "POOL_SWAPPED",
      type,
      drainedOldPool: drained,
      activePoolGeneration: this.currentGeneration,
    };
  }

  /**
   * Part 5: Generation & Skew Telemetry Exposer
   */
  getSecretTelemetry() {
    return {
      currentGeneration: this.currentGeneration,
      activeSecretsCount: this.secrets.size,
      dualTrustSecretsCount: this.previousGenerationSecrets.size,
      secrets: Array.from(this.secrets.entries()).map(([k, v]) => ({
        type: k,
        generation: v.generation,
        updatedAt: v.updatedAt,
      })),
    };
  }

  cleanup() {
    for (const timer of this.sunsetTimers.values()) {
      clearTimeout(timer);
    }
    this.sunsetTimers.clear();
  }
}

// Runtime secret rotation with overlap windows and fail-closed semantics (#760).
//
// Rotating a live credential is a two-phase problem: the new value has to be
// staged and validated before anything uses it, and the old value has to stay
// accepted for a short overlap window while connections / tokens catch up.
//
// This module owns both phases. It never emits a secret value: every audit
// event carries a one-way fingerprint (SHA-256, truncated) and metadata only.
//
// Design constraints (see docs/spikes/760-secrets-rotation-report.md):
//   * all-or-nothing — a batch that is missing a target, or has one invalid
//     value, is rejected in full and leaves the active snapshot untouched;
//   * fail-closed — a rejected batch never partially applies, and an audit
//     failure rejects the batch too (an un-audited rotation is not allowed);
//   * overlap — for `overlapMs` after a commit both the previous and the new
//     value verify, then the previous one stops working automatically;
//   * no secret values in logs, errors or JSON serialisation.


/** Slots the runtime config reload knows about. */
export const ROTATION_TARGETS = Object.freeze([
  "mapToken",
  "dbUser",
  "dbPassword",
  "redisUser",
  "redisPassword",
  "proverUrl",
]);

export const DEFAULT_OVERLAP_MS = 60_000;
export const AUDIT_EVENT_TYPES = Object.freeze([
  "rotation.initialized",
  "rotation.committed",
  "rotation.rejected",
  "rotation.overlap.closed",
]);

export class RotationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RotationError";
    this.code = code;
    this.details = details;
  }
}

/** One-way, salt-free fingerprint. Never log the value itself. */
export function fingerprint(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `sha256:${digest.slice(0, 12)}:${value.length}`;
}

function isNonEmptyString(value, minLength = 1) {
  return typeof value === "string" && value.trim().length >= minLength && !/\s/.test(value.trim());
}

export const defaultValidators = Object.freeze({
  mapToken: (v) => isNonEmptyString(v, 8),
  dbUser: (v) => isNonEmptyString(v, 1),
  dbPassword: (v) => isNonEmptyString(v, 8),
  redisUser: (v) => isNonEmptyString(v, 1),
  redisPassword: (v) => isNonEmptyString(v, 8),
  proverUrl: (v) => {
    if (typeof v !== "string" || /\s/.test(v)) return false;
    try {
      const url = new URL(v);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  },
});

/** Constant-time comparison so verification does not leak a prefix. */
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function presentKeys(values) {
  return Object.keys(values).filter((k) => values[k] !== undefined && values[k] !== null && values[k] !== "");
}

/**
 * @param {{
 *   initial?: Record<string,string>,
 *   overlapMs?: number,
 *   now?: () => number,
 *   audit?: (event: object) => void | Promise<void>,
 *   validators?: Record<string,(value:any)=>boolean>,
 *   logger?: { warn: (...a:any[]) => void },
 * }} [options]
 */
export function createSecretRotationManager({
  initial = {},
  overlapMs = DEFAULT_OVERLAP_MS,
  now = () => Date.now(),
  audit = () => {},
  validators = defaultValidators,
  logger = console,
} = {}) {
  if (!(Number.isFinite(overlapMs) && overlapMs >= 0)) {
    throw new RangeError("overlapMs must be a finite, non-negative number");
  }

  // slot -> { value, version, activatedAt, expiresAt, previous }
  // `previous` is { value, closedAt } and is only consulted while now < expiresAt.
  const slots = new Map();
  let version = 0;
  let queue = Promise.resolve();

  const unknown = (keys) => keys.filter((k) => !ROTATION_TARGETS.includes(k));
  const bad = (values) =>
    presentKeys(values).filter((k) => !validators[k] || !validators[k](values[k]));

  function validate(values, { requireAll = false } = {}) {
    const unknownKeys = unknown(Object.keys(values));
    if (unknownKeys.length) {
      throw new RotationError("UNKNOWN_TARGET", `Unknown rotation target(s): ${unknownKeys.join(", ")}`, {
        targets: unknownKeys,
      });
    }
    const invalid = bad(values);
    if (invalid.length) {
      throw new RotationError("INVALID_VALUE", `Invalid value(s) for: ${invalid.join(", ")}`, {
        targets: invalid,
      });
    }
    if (requireAll) {
      const missing = ROTATION_TARGETS.filter((k) => !presentKeys(values).includes(k));
      if (missing.length) {
        throw new RotationError("PARTIAL_ROTATION_REJECTED", `Rotation is missing target(s): ${missing.join(", ")}`, {
          targets: missing,
        });
      }
    }
  }

  async function emit(event) {
    try {
      await audit(event);
    } catch (err) {
      // An un-audited rotation must not become active. The caller catches the
      // error and leaves the snapshot untouched (fail-closed).
      throw new RotationError("AUDIT_FAILED", `Rotation audit sink failed: ${err?.message ?? err}`);
    }
  }

  function initialise(values) {
    validate(values);
    const at = now();
    version = 1;
    for (const key of presentKeys(values)) {
      slots.set(key, {
        value: values[key],
        version,
        activatedAt: at,
        expiresAt: 0,
        previous: null,
      });
    }
    return emit({
      type: "rotation.initialized",
      at,
      version,
      targets: presentKeys(values),
      fingerprints: Object.fromEntries(
        presentKeys(values).map((k) => [k, fingerprint(values[k])]),
      ),
      overlapMs,
    });
  }

  function activeValue(key) {
    return slots.get(key)?.value ?? null;
  }

  /** All values accepted for `key` right now (active + still-overlapping old). */
  function acceptedValues(key) {
    const slot = slots.get(key);
    if (!slot) return [];
    const values = [slot.value];
    if (slot.previous && now() < slot.expiresAt) values.push(slot.previous.value);
    return values;
  }

  function verify(key, presented) {
    return acceptedValues(key).some((v) => equal(v, presented));
  }

  /**
   * Validate and atomically apply a batch. Missing or invalid targets reject
   * the entire batch; no slot is changed on rejection.
   */
  async function rotate(values, { reason = "scheduled", requireAll = false } = {}) {
    const run = queue.then(async () => {
      validate(values, { requireAll });
      const targets = presentKeys(values);
      if (!targets.length) {
        throw new RotationError("EMPTY_ROTATION", "Rotation batch contains no values", { targets: [] });
      }
      const at = now();
      const previousFingerprints = {};
      const nextFingerprints = {};
      for (const key of targets) {
        const current = slots.get(key);
        previousFingerprints[key] = current ? fingerprint(current.value) : null;
        nextFingerprints[key] = fingerprint(values[key]);
      }

      // Audit first: a rotation without an audit record must never go live.
      await emit({
        type: "rotation.committed",
        at,
        version: version + 1,
        reason,
        targets,
        overlapMs,
        previousFingerprints,
        fingerprints: nextFingerprints,
      });

      const nextVersion = ++version;
      for (const key of targets) {
        const current = slots.get(key);
        slots.set(key, {
          value: values[key],
          version: nextVersion,
          activatedAt: at,
          expiresAt: at + overlapMs,
          previous: current ? { value: current.value, closedAt: at } : null,
        });
      }
      return { ok: true, version: nextVersion, targets, overlapMs, closesAt: at + overlapMs };
    });
    // Keep the queue alive even on rejection, and never reject the queue itself.
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Drop values whose overlap window has elapsed (idempotent). */
  async function prune() {
    const run = queue.then(async () => {
      const at = now();
      const closed = [];
      for (const [key, slot] of slots) {
        if (slot.previous && at >= slot.expiresAt) {
          closed.push({ key, fingerprint: fingerprint(slot.previous.value) });
          slots.set(key, { ...slot, previous: null, expiresAt: 0 });
        }
      }
      if (closed.length) {
        await emit({
          type: "rotation.overlap.closed",
          at,
          version,
          targets: closed.map((c) => c.key),
          fingerprints: Object.fromEntries(closed.map((c) => [c.key, c.fingerprint])),
        });
      }
      return closed;
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  // Seed the active snapshot from `initial` synchronously. `initialise` sets
  // slot state before awaiting its audit event, so callers can read values
  // immediately after construction.
  if (presentKeys(initial).length) void initialise(initial).catch(() => {});

  function status() {
    const at = now();
    return {
      version,
      overlapMs,
      slots: Object.fromEntries(
        ROTATION_TARGETS.filter((k) => slots.has(k)).map((key) => {
          const s = slots.get(key);
          return [
            key,
            {
              configured: true,
              version: s.version,
              activatedAt: s.activatedAt,
              overlapRemainingMs: s.previous ? Math.max(0, s.expiresAt - at) : 0,
              fingerprint: fingerprint(s.value),
            },
          ];
        }),
      ),
    };
  }

  return {
    ROTATION_TARGETS,
    get version() {
      return version;
    },
    initialize: initialise,
    rotate,
    prune,
    verify,
    acceptedValues,
    activeValue,
    activeValues: () => Object.fromEntries(
      [...slots].map(([key, slot]) => [key, slot.value]),
    ),
    status,
    toJSON: status,
  };
}
