import { describe, it, expect } from "vitest";
import {
  createSecretRotationManager,
  fingerprint,
  ROTATION_TARGETS,
  RotationError,
} from "../server/lib/secretRotationManager.js";
import {
  createAuditSink,
  createRuntimeConfig,
  reloadRuntimeConfig,
  runtimeConfig,
  secretsFromEnv,
} from "../server/lib/runtimeConfig.js";

const INITIAL = {
  mapToken: "pk.initial-map-token-0001",
  dbUser: "helphone",
  dbPassword: "initial-db-password",
  redisPassword: "initial-redis-pass",
  proverUrl: "https://prover-old.example.com/v1",
};

const NEXT = {
  mapToken: "pk.rotated-map-token-0002",
  dbPassword: "rotated-db-password",
  proverUrl: "https://prover-new.example.com/v1",
};

const eventTypes = (events) => events.map((e) => e.type);
const allText = (value) => JSON.stringify(value);

describe("fingerprint", () => {
  it("is one-way, stable and includes only a digest prefix + length", () => {
    const secret = "initial-db-password";
    const f = fingerprint(secret);
    expect(f).toBe(`sha256:${f.slice(7, 19)}:${secret.length}`);
    expect(f).toMatch(/^sha256:[0-9a-f]{12}:\d+$/);
    expect(f).toBe(fingerprint("initial-db-password"));
    expect(f).not.toContain("initial-db-password");
  });
});

describe("createSecretRotationManager", () => {
  function setup(overrides = {}) {
    const events = [];
    let time = 1_000_000;
    const manager = createSecretRotationManager({
      initial: INITIAL,
      overlapMs: 1000,
      now: () => time,
      audit: (e) => events.push(e),
      ...overrides,
    });
    return {
      manager,
      events,
      advance(ms) {
        time += ms;
      },
      get time() {
        return time;
      },
    };
  }

  it("initialises all targets and never serialises a value", () => {
    const { manager, events } = setup();
    expect(manager.version).toBe(1);
    expect(manager.activeValue("mapToken")).toBe(INITIAL.mapToken);
    expect(eventTypes(events)).toEqual(["rotation.initialized"]);
    expect(allText(manager.status())).not.toContain(INITIAL.mapToken);
    expect(allText(manager)).not.toContain(INITIAL.dbPassword);
    expect(allText(events)).not.toContain(INITIAL.mapToken);
    expect(ROTATION_TARGETS).toContain("redisPassword");
  });

  it("accepts both values during overlap and rejects the old one afterwards", async () => {
    const { manager, events, advance, time } = setup();
    const result = await manager.rotate(NEXT);
    expect(result.ok).toBe(true);
    expect(result.closesAt).toBe(time + 1000);

    expect(manager.verify("mapToken", NEXT.mapToken)).toBe(true);
    expect(manager.verify("mapToken", INITIAL.mapToken)).toBe(true);
    expect(manager.verify("dbPassword", INITIAL.dbPassword)).toBe(true);
    expect(manager.verify("dbPassword", NEXT.dbPassword)).toBe(true);
    expect(manager.acceptedValues("proverUrl")).toHaveLength(2);

    advance(1001);
    expect(manager.verify("mapToken", INITIAL.mapToken)).toBe(false);
    expect(manager.verify("mapToken", NEXT.mapToken)).toBe(true);
    expect(manager.acceptedValues("proverUrl")).toHaveLength(1);

    const closed = await manager.prune();
    expect(closed.map((c) => c.key)).toEqual(["mapToken", "dbPassword", "proverUrl"]);
    expect(eventTypes(events)).toContain("rotation.overlap.closed");
    // Idempotent.
    expect(await manager.prune()).toEqual([]);
  });

  it("rejects a batch with one invalid value without rotating anything", async () => {
    const { manager, events } = setup();
    const before = manager.activeValues();
    await expect(
      manager.rotate({ ...NEXT, dbPassword: "short" }),
    ).rejects.toMatchObject({ code: "INVALID_VALUE" });
    expect(manager.activeValues()).toEqual(before);
    expect(eventTypes(events)).toEqual(["rotation.initialized"]);
    expect(allText(events)).not.toContain("short");
  });

  it("rejects a partial batch when requireAll is set", async () => {
    const { manager } = setup();
    await expect(manager.rotate(NEXT, { requireAll: true })).rejects.toMatchObject({
      code: "PARTIAL_ROTATION_REJECTED",
    });
    expect(manager.version).toBe(1);
  });

  it("rejects unknown targets and empty batches", async () => {
    const { manager } = setup();
    await expect(manager.rotate({ notATarget: "x" })).rejects.toMatchObject({
      code: "UNKNOWN_TARGET",
    });
    await expect(manager.rotate({})).rejects.toMatchObject({ code: "EMPTY_ROTATION" });
  });

  it("fails closed when the audit sink throws", async () => {
    const { manager } = setup({
      audit() {
        throw new Error("audit sink down");
      },
    });
    const before = manager.activeValues();
    await expect(manager.rotate(NEXT)).rejects.toBeInstanceOf(RotationError);
    await expect(manager.rotate(NEXT)).rejects.toMatchObject({ code: "AUDIT_FAILED" });
    expect(manager.activeValues()).toEqual(before);
  });

  it("serialises concurrent rotations and increments versions monotonically", async () => {
    const { manager } = setup();
    const [a, b] = await Promise.all([
      manager.rotate({ mapToken: "pk.first-rotation-001" }),
      manager.rotate({ dbPassword: "second-rotation-password" }),
    ]);
    expect([a.version, b.version].sort()).toEqual([2, 3]);
    expect(manager.version).toBe(3);
    expect(manager.verify("mapToken", "pk.first-rotation-001")).toBe(true);
    expect(manager.verify("dbPassword", "second-rotation-password")).toBe(true);
  });

  it("audits a successful rotation with fingerprints only", async () => {
    const { manager, events } = setup();
    await manager.rotate(NEXT, { reason: "staging-drill" });
    const committed = events.find((e) => e.type === "rotation.committed");
    expect(committed.reason).toBe("staging-drill");
    expect(committed.targets.sort()).toEqual(Object.keys(NEXT).sort());
    expect(committed.fingerprints.mapToken).toBe(fingerprint(NEXT.mapToken));
    expect(committed.previousFingerprints.mapToken).toBe(fingerprint(INITIAL.mapToken));
    expect(allText(committed)).not.toContain(NEXT.mapToken);
    expect(allText(committed)).not.toContain(INITIAL.mapToken);
  });
});

describe("createAuditSink", () => {
  it("caps history and strips ad-hoc value fields", async () => {
    const logged = [];
    const sink = createAuditSink({
      historySize: 2,
      logger: { info: (line) => logged.push(line) },
    });
    await sink.record({ type: "rotation.committed", version: 2, value: "super-secret", targets: ["mapToken"] });
    await sink.record({ type: "rotation.committed", version: 3 });
    await sink.record({ type: "rotation.committed", version: 4 });
    expect(sink.history()).toHaveLength(2);
    expect(allText(sink.history())).not.toContain("super-secret");
    expect(allText(logged)).not.toContain("super-secret");
    sink.clear();
    expect(sink.history()).toEqual([]);
  });
});

describe("runtime config reload", () => {
  it("reads secrets from env-like objects using aliases", () => {
    const secrets = secretsFromEnv({
      VITE_MAPBOX_TOKEN: "pk.env-map-token-0001",
      POSTGRES_PASSWORD: "env-db-password",
      REDIS_PASSWORD: "env-redis-password",
      ZK_PROVER_URL: "https://env-prover.example.com",
    });
    expect(secrets.mapToken).toBe("pk.env-map-token-0001");
    expect(secrets.dbPassword).toBe("env-db-password");
    expect(secrets.redisPassword).toBe("env-redis-password");
    expect(secrets.proverUrl).toBe("https://env-prover.example.com");
  });

  it("live getters update on reload and stay unchanged on rejection", async () => {
    const events = [];
    const config = createRuntimeConfig({
      initial: INITIAL,
      overlapMs: 50,
      audit: (e) => events.push(e),
    });
    expect(config.mapToken).toBe(INITIAL.mapToken);
    expect(config.proverUrl).toBe(INITIAL.proverUrl);

    const result = await config.reload(NEXT);
    expect(result.ok).toBe(true);
    expect(config.mapToken).toBe(NEXT.mapToken);
    expect(config.dbPassword).toBe(NEXT.dbPassword);
    expect(config.proverUrl).toBe(NEXT.proverUrl);
    expect(config.verify("mapToken", INITIAL.mapToken)).toBe(true);

    await expect(config.reload({ mapToken: "pk.bad" })).rejects.toMatchObject({
      code: "INVALID_VALUE",
    });
    expect(config.mapToken).toBe(NEXT.mapToken);
    expect(allText(config.status())).not.toContain(NEXT.mapToken);
    expect(allText(events)).not.toContain(NEXT.mapToken);
  });

  it("module-level runtime config exposes redacted status", () => {
    const status = runtimeConfig.status();
    expect(status).toHaveProperty("overlapMs");
    expect(status).toHaveProperty("version");
    for (const slot of Object.values(status.slots)) {
      expect(slot).not.toHaveProperty("value");
      expect(slot.fingerprint).toMatch(/^sha256:/);
    }
  });

  it("reloadRuntimeConfig reads the supplied env atomically", async () => {
    const env = {
      VITE_MAPBOX_TOKEN: "pk.reload-map-token-01",
      DB_PASSWORD: "reload-db-password",
      REDIS_PASSWORD: "reload-redis-password",
      PROVER_URL: "https://reload.example.com",
    };
    const result = await reloadRuntimeConfig(env, { reason: "test-drill" });
    expect(result.ok).toBe(true);
    expect(result.targets.sort()).toEqual(Object.keys(secretsFromEnv(env)).sort());
    expect(runtimeConfig.mapToken).toBe(env.VITE_MAPBOX_TOKEN);
    expect(runtimeConfig.proverUrl).toBe(env.PROVER_URL);
    expect(runtimeConfig.verify("dbPassword", env.DB_PASSWORD)).toBe(true);
  });
});
