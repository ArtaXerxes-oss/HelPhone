// Runtime configuration backed by the #760 rotation manager.
//
// The server used to snapshot every credential at module load. That makes a
// rotation a deploy. Here the getters read the active version on every access,
// so a successful rotate()/reload() is visible immediately and a rejected one
// changes nothing (fail-closed). Getters never log values.

import {
  createSecretRotationManager,
  fingerprint,
  ROTATION_TARGETS,
  DEFAULT_OVERLAP_MS,
} from "./secretRotationManager.js";

export const SECRET_ENV_KEYS = Object.freeze({
  mapToken: ["VITE_MAPBOX_TOKEN", "MAPBOX_TOKEN"],
  dbUser: ["DB_USER", "POSTGRES_USER"],
  dbPassword: ["DB_PASSWORD", "POSTGRES_PASSWORD"],
  redisUser: ["REDIS_USER"],
  redisPassword: ["REDIS_PASSWORD", "REDIS_URL_PASSWORD"],
  proverUrl: ["PROVER_URL", "ZK_PROVER_URL"],
});

/** Read the currently configured secrets from an env-like object. */
export function secretsFromEnv(env = process.env) {
  const out = {};
  for (const [target, keys] of Object.entries(SECRET_ENV_KEYS)) {
    for (const key of keys) {
      const value = env[key];
      if (typeof value === "string" && value.length > 0) {
        out[target] = value;
        break;
      }
    }
  }
  return out;
}

export function createAuditSink({ historySize = 200, logger = null } = {}) {
  const history = [];
  return {
    async record(event) {
      // Defensive: callers must never be able to smuggle a value into an audit
      // event by adding an ad-hoc field.
      const safe = {
        type: event.type,
        at: event.at,
        version: event.version,
        reason: event.reason,
        targets: ROTATION_TARGETS.filter((k) => event.targets?.includes(k)),
        overlapMs: event.overlapMs,
        fingerprints: event.fingerprints ?? event.previousFingerprints ?? null,
        previousFingerprints: event.previousFingerprints ?? null,
        error: typeof event.error === "string" ? event.error.slice(0, 200) : undefined,
      };
      history.push(safe);
      if (history.length > historySize) history.shift();
      logger?.info?.(JSON.stringify(safe));
    },
    history: () => history.slice(),
    clear: () => {
      history.length = 0;
    },
  };
}

/**
 * @param {{ initial?: object, overlapMs?: number, audit?: Function,
 *   now?: () => number, env?: object }} [options]
 */
export function createRuntimeConfig({
  initial = secretsFromEnv(),
  overlapMs = Number(process.env.SECRET_OVERLAP_MS) || DEFAULT_OVERLAP_MS,
  audit = createAuditSink().record,
  now,
} = {}) {
  const sink = audit;
  const manager = createSecretRotationManager({
    initial,
    overlapMs,
    audit: sink,
    ...(now ? { now } : {}),
  });
  return {
    manager,
    get mapToken() {
      return manager.activeValue("mapToken");
    },
    get dbUser() {
      return manager.activeValue("dbUser");
    },
    get dbPassword() {
      return manager.activeValue("dbPassword");
    },
    get redisUser() {
      return manager.activeValue("redisUser");
    },
    get redisPassword() {
      return manager.activeValue("redisPassword");
    },
    get proverUrl() {
      return manager.activeValue("proverUrl");
    },
    /** Values for constructing clients. Treat as sensitive. */
    snapshot: () => manager.activeValues(),
    /** Verify a presented credential against active + overlapping values. */
    verify: (target, presented) => manager.verify(target, presented),
    status: () => manager.status(),
    /** Atomic, audited, all-or-nothing reload. */
    reload: (next, options) => manager.rotate(next, options),
    prune: () => manager.prune(),
    toJSON: () => manager.status(),
  };
}

export const runtimeAudit = createAuditSink({
  logger: process.env.NODE_ENV === "test" ? null : console,
});
export const runtimeConfig = createRuntimeConfig({
  audit: runtimeAudit.record,
});

/** Reload from process.env (SIGUSR2 / admin endpoint). */
export async function reloadRuntimeConfig(env = process.env, options = {}) {
  return runtimeConfig.reload(secretsFromEnv(env), { reason: "runtime-reload", ...options });
}

/**
 * Install a signal handler that reloads credentials in place. Returns a
 * disposer so tests / shutdown can remove it.
 */
export function startRuntimeConfigReload({
  signals = ["SIGUSR2"],
  env = process.env,
  onReload = reloadRuntimeConfig,
  processRef = globalThis.process,
} = {}) {
  const handlers = new Map();
  for (const signal of signals) {
    const handler = () => {
      onReload(env)
        .then((r) => runtimeAudit.record({
          type: "rotation.reload.completed",
          at: Date.now(),
          version: r.version,
          targets: r.targets,
        }))
        .catch((err) => runtimeAudit.record({
          type: "rotation.reload.failed",
          at: Date.now(),
          error: err?.message ?? String(err),
        }));
    };
    processRef.on(signal, handler);
    handlers.set(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) processRef.off(signal, handler);
  };
}

export { fingerprint, ROTATION_TARGETS };
