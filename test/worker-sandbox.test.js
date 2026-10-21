// Browser sandbox isolation for untrusted Web Worker scripts.
//
// Covers the three layers independently (origin isolation, in-worker
// lockdown, message sanitization) with injected fakes for the Worker and the
// sandboxed-iframe relay, so the suite never touches a real DOM frame.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOT_ERROR_MESSAGE,
  BOOT_MESSAGE,
  INTERNAL_CHANNEL,
  buildSandboxFrameHtml,
  buildWorkerBootstrap,
  clusterWorkerInboundSchema,
  clusterWorkerOutboundSchema,
  collectTransferables,
  createSandboxedWorker,
  genericWorkerMessageSchema,
  installWorkerLockdown,
  isInternalMessage,
  maskCode,
  prepareWorkerSandbox,
  rewriteWorkerConstructors,
  selectWorkerSchemas,
  validateMessage,
  zkWorkerInboundSchema,
  zkWorkerOutboundSchema,
} from "../src/lib/workerSandbox.ts";

const ZK_URL = "https://helphone.test/assets/zk-worker-abc123.js";
const CLUSTER_URL = "/src/workers/clusterWorker.js?worker_file&type=module";

let warn;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Worker double: records launches, deliveries and errors. */
function workerFactory() {
  const workers = [];
  const create = (url, init) => {
    const worker = {
      url,
      init,
      terminated: false,
      onmessage: null,
      onerror: null,
      sent: [],
      postMessage(data, transfer) {
        this.sent.push({ data, transfer });
      },
      terminate() {
        this.terminated = true;
      },
      emit(data) {
        this.onmessage?.({ data });
      },
      fail(message) {
        this.onerror?.({ message });
      },
    };
    workers.push(worker);
    return worker;
  };
  return { workers, create };
}

/** Sandboxed-iframe relay double. */
function makeFrame(opts = {}) {
  const listeners = { message: [], error: [] };
  const frame = {
    origin: "null",
    createdWith: null,
    posts: [],
    terminated: false,
    create(bootstrap, name) {
      frame.createdWith = { bootstrap, name };
      if (opts.neverReady) return new Promise(() => {});
      if (opts.createError) return Promise.reject(new Error(opts.createError));
      return Promise.resolve();
    },
    post(data, transfer) {
      frame.posts.push({ data, transfer });
    },
    terminate() {
      frame.terminated = true;
    },
    onMessage(fn) {
      listeners.message.push(fn);
    },
    onError(fn) {
      listeners.error.push(fn);
    },
    emit(data) {
      for (const fn of listeners.message) fn(data);
    },
    fail(message) {
      for (const fn of listeners.error) fn(new Error(message));
    },
  };
  return frame;
}

// ---------------------------------------------------------------------------
// Layer 2: in-worker lockdown
// ---------------------------------------------------------------------------

describe("installWorkerLockdown", () => {
  it("revokes storage, ad-hoc script loading and parent/DOM globals", () => {
    const realm = {
      localStorage: { getItem: () => "x" },
      sessionStorage: {},
      indexedDB: {},
      caches: {},
      BroadcastChannel: class {},
      SharedWorker: class {},
      importScripts() {},
      window: {},
      parent: {},
      top: {},
      frames: {},
      opener: {},
      self: {},
      navigator: { hardwareConcurrency: 8 },
    };
    const report = installWorkerLockdown(realm);

    expect(report.applied).toBe(true);
    expect(report.revoked).toEqual(
      expect.arrayContaining([
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "caches",
        "importScripts",
        "window",
        "parent",
        "top",
        "frames",
        "opener",
      ]),
    );
    expect(realm.localStorage).toBeUndefined();
    expect(realm.window).toBeUndefined();
    expect("document" in realm).toBe(false);
    expect(report.blocked).toContain("document");
    expect(report.revoked).not.toContain("document");
    // Untouched globals stay available for the worker itself.
    expect(realm.navigator.hardwareConcurrency).toBe(8);
    expect(realm.self).toEqual({});
  });

  it("is idempotent", () => {
    const realm = { localStorage: {} };
    const first = installWorkerLockdown(realm);
    const second = installWorkerLockdown(realm);
    expect(second).toBe(first);
  });

  it("refuses to touch a window-like realm", () => {
    const realm = { document: {}, localStorage: { secret: 1 } };
    const report = installWorkerLockdown(realm);
    expect(report.applied).toBe(false);
    expect(report.revoked).toEqual([]);
    expect(realm.localStorage).toEqual({ secret: 1 });
    expect(realm.document).toEqual({});
  });

  it("makes an undeletable key throw instead of leaking it", () => {
    const realm = new Proxy(
      { sessionStorage: { token: "abc" } },
      {
        deleteProperty() {
          throw new Error("protected");
        },
      },
    );
    const report = installWorkerLockdown(realm);
    expect(report.guarded).toContain("sessionStorage");
    expect(() => realm.sessionStorage).toThrow(/revoked/);
  });

  it("reports keys that could not be removed at all", () => {
    const realm = {};
    Object.defineProperty(realm, "opener", { value: {}, configurable: false, writable: false });
    const report = installWorkerLockdown(realm);
    expect(report.unrevocable).toContain("opener");
    expect(realm.opener).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Layer 1: bootstrap blob
// ---------------------------------------------------------------------------

describe("buildWorkerBootstrap", () => {
  it("runs the lockdown before importing the worker module", () => {
    const source = buildWorkerBootstrap(ZK_URL);
    expect(source).toContain("installWorkerLockdown");
    expect(source).toContain(`import(${JSON.stringify(ZK_URL)})`);
    expect(source.indexOf("installWorkerLockdown")).toBeLessThan(source.indexOf("import("));
    expect(source).toContain(`${JSON.stringify(INTERNAL_CHANNEL)}: ${JSON.stringify(BOOT_MESSAGE)}`);
    expect(source).toContain(BOOT_ERROR_MESSAGE);
    // Self contained: no module-scope bindings may be referenced.
    expect(source).not.toMatch(/\bimport\s+[{"']/);
  });

  it("tags control messages so they never reach application code", () => {
    expect(isInternalMessage({ [INTERNAL_CHANNEL]: BOOT_MESSAGE })).toBe(true);
    expect(isInternalMessage({ type: "progress", id: 1 })).toBe(false);
    expect(isInternalMessage(null)).toBe(false);
    expect(isInternalMessage("boot")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 3: message sanitization
// ---------------------------------------------------------------------------

describe("zk worker schemas", () => {
  it("accepts the requests the app sends", () => {
    expect(validateMessage(zkWorkerInboundSchema, { id: 1, action: "warmProver" }).ok).toBe(true);
    expect(validateMessage(zkWorkerInboundSchema, { id: 2, action: "isProverReady" }).ok).toBe(true);
    expect(
      validateMessage(zkWorkerInboundSchema, { id: 3, type: "prove", inputs: { a: 1 } }).ok,
    ).toBe(true);
    expect(
      validateMessage(zkWorkerInboundSchema, { id: 4, action: "initHumanity", payload: { inputs: {} } })
        .ok,
    ).toBe(true);
  });

  it("rejects malformed, unidentified or over-specified requests", () => {
    expect(validateMessage(zkWorkerInboundSchema, { action: "warmProver" })).toMatchObject({ ok: false });
    expect(validateMessage(zkWorkerInboundSchema, { id: 1 })).toMatchObject({ ok: false });
    expect(validateMessage(zkWorkerInboundSchema, { id: 1.5, action: "prove" })).toMatchObject({
      ok: false,
    });
    expect(validateMessage(zkWorkerInboundSchema, { id: 1, action: "prove", extra: true })).toMatchObject(
      { ok: false },
    );
    expect(validateMessage(zkWorkerInboundSchema, "prove")).toMatchObject({ ok: false });
  });

  it("accepts every outbound message shape the worker emits", () => {
    const shapes = [
      { type: "progress", id: 1, action: "log", message: "Executing witness" },
      {
        type: "done",
        id: 1,
        action: "proveComplete",
        proof: new Uint8Array(8),
        publicInputs: [1n, 2n],
        profiling: {
          provingMs: 12.5,
          heapDeltaBytes: 4096,
          memStats: { totalAllocated: 1024, pooled: 0, active: 1 },
        },
      },
      { type: "error", id: 1, action: "error", error: "boom" },
      { id: 1, action: "warmProverComplete", success: true },
      { id: 1, action: "isProverReadyResult", ready: false },
      { id: 1, action: "initHumanityComplete", success: true },
      { id: 1, action: "log", message: "Prover ready" },
      { id: 1, action: "error", error: "Unknown action: nope" },
    ];
    for (const shape of shapes) {
      const label = JSON.stringify(shape, (key, value) => (typeof value === "bigint" ? String(value) : value));
      expect(validateMessage(zkWorkerOutboundSchema, shape), label).toMatchObject({ ok: true });
    }
  });

  it("rejects a proof payload with the wrong binary type or a missing profile", () => {
    expect(
      validateMessage(zkWorkerOutboundSchema, {
        type: "done",
        id: 1,
        action: "proveComplete",
        proof: "not-bytes",
        publicInputs: [],
        profiling: { provingMs: 1, heapDeltaBytes: 1, memStats: { totalAllocated: 0, pooled: 0, active: 0 } },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateMessage(zkWorkerOutboundSchema, {
        type: "done",
        id: 1,
        action: "proveComplete",
        proof: new Uint8Array(2),
        publicInputs: [],
        profiling: { provingMs: 1, heapDeltaBytes: 1 },
      }),
    ).toMatchObject({ ok: false });
    expect(validateMessage(zkWorkerOutboundSchema, { type: "nope", id: 1 })).toMatchObject({ ok: false });
  });

  it("reports the offending path", () => {
    const result = validateMessage(zkWorkerInboundSchema, { id: 1, action: "prove", inputs: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("inputs");
  });
});

describe("cluster worker schemas", () => {
  const params = {
    originX: 0,
    originY: 0,
    cellSize: 10,
    fixedScale: 1024,
    gridW: 64,
    gridH: 64,
    maxPoints: 1000,
  };

  it("accepts typed-array and plain-array jobs", () => {
    expect(
      validateMessage(clusterWorkerInboundSchema, { id: 0, points: new Float32Array([1, 2]), params }).ok,
    ).toBe(true);
    expect(validateMessage(clusterWorkerInboundSchema, { id: 1, points: [1, 2], params }).ok).toBe(true);
  });

  it("rejects NaN geometry and missing params", () => {
    expect(
      validateMessage(clusterWorkerInboundSchema, { id: 0, points: [], params: { ...params, originX: NaN } }),
    ).toMatchObject({ ok: false });
    expect(validateMessage(clusterWorkerInboundSchema, { id: 0, points: [] })).toMatchObject({ ok: false });
  });

  it("accepts transferred results and error replies, rejects foreign grids", () => {
    const ok = {
      id: 0,
      computeMs: 1.5,
      grid: {
        cellCount: new Uint32Array(4),
        cellSum: new Float64Array(4),
        cellRadius: new Float32Array(4),
      },
    };
    expect(validateMessage(clusterWorkerOutboundSchema, ok)).toMatchObject({ ok: true });
    expect(validateMessage(clusterWorkerOutboundSchema, { id: 0, error: "bad points" })).toMatchObject({
      ok: true,
    });
    expect(validateMessage(clusterWorkerOutboundSchema, { ...ok, grid: { ...ok.grid, cellCount: [] } })).toMatchObject(
      { ok: false },
    );
  });
});

describe("generic worker schema", () => {
  it("accepts ordinary telemetry payloads", () => {
    expect(validateMessage(genericWorkerMessageSchema, { type: "stats", stats: { fps: 60, frames: 3 } })).toMatchObject(
      { ok: true },
    );
    expect(validateMessage(genericWorkerMessageSchema, { type: "resize", width: 800, height: 600 })).toMatchObject(
      { ok: true },
    );
  });

  it("rejects prototype-pollution keys", () => {
    const payload = JSON.parse('{"type":"stats","__proto__":{"polluted":true}}');
    expect(Object.prototype.hasOwnProperty.call(payload, "__proto__")).toBe(true);
    expect(validateMessage(genericWorkerMessageSchema, payload)).toMatchObject({ ok: false });
    expect(
      validateMessage(genericWorkerMessageSchema, { constructor: { prototype: {} } }),
    ).toMatchObject({ ok: false });
  });

  it("rejects absurdly nested payloads", () => {
    let deep = { leaf: true };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(validateMessage(genericWorkerMessageSchema, deep)).toMatchObject({ ok: false });
  });

  it("does not choke on typed arrays or host objects", () => {
    expect(validateMessage(genericWorkerMessageSchema, { pixels: new Uint8ClampedArray(16) })).toMatchObject({
      ok: true,
    });
    const host = {};
    Object.defineProperty(host, "throwing", {
      enumerable: true,
      get() {
        throw new Error("nope");
      },
    });
    expect(validateMessage(genericWorkerMessageSchema, host)).toMatchObject({ ok: true });
  });
});

describe("selectWorkerSchemas", () => {
  it("picks the protocol from the emitted worker file name", () => {
    expect(selectWorkerSchemas(ZK_URL)).toMatchObject({ boundary: "zk" });
    expect(selectWorkerSchemas(CLUSTER_URL)).toMatchObject({ boundary: "cluster" });
    expect(selectWorkerSchemas("/assets/canvas-worker-9f.js")).toMatchObject({ boundary: "generic" });
  });
});

// ---------------------------------------------------------------------------
// Transferables
// ---------------------------------------------------------------------------

describe("collectTransferables", () => {
  it("collects buffers behind typed arrays, without duplicates", () => {
    const proof = new Uint8Array(8);
    const shared = new Float32Array(4);
    const found = collectTransferables({ proof, alsoProof: proof, nested: [{ grid: shared }] });
    expect(found).toHaveLength(2);
    expect(found).toContain(proof.buffer);
    expect(found).toContain(shared.buffer);
  });

  it("collects non-ArrayBuffer transferables (OffscreenCanvas etc.)", () => {
    const canvasLike = {};
    Object.defineProperty(canvasLike, Symbol.toStringTag, { value: "OffscreenCanvas" });
    expect(collectTransferables({ canvas: canvasLike })).toContain(canvasLike);
    expect(collectTransferables({ n: 1, s: "x" })).toEqual([]);
  });

  it("survives cyclic and deeply nested payloads", () => {
    const cyclic = { self: null };
    cyclic.self = cyclic;
    expect(() => collectTransferables(cyclic)).not.toThrow();
    let deep = { leaf: new Uint8Array(1) };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(() => collectTransferables(deep)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Build integration
// ---------------------------------------------------------------------------

describe("rewriteWorkerConstructors", () => {
  it("swaps the constructor and injects the launcher import", () => {
    const input = [
      'export function spawn() {',
      '  return new Worker(new URL("../workers/zk-worker.js", import.meta.url), { type: "module" });',
      "}",
      "",
    ].join("\n");
    const out = rewriteWorkerConstructors(input, "/src/lib/worker-manager.js");
    expect(out).toContain("createSandboxedWorker(new URL(");
    expect(out).not.toContain("new Worker(");
    expect(out).toMatch(/^import \{ createSandboxedWorker \} from "\/src\/lib\/workerSandbox\.ts";/);
    // The Vite worker chunking argument must survive untouched.
    expect(out).toContain('new URL("../workers/zk-worker.js", import.meta.url)');
    expect(out).toContain('{ type: "module" }');
  });

  it("leaves comments and string literals alone", () => {
    const input = ['// new Worker(example)', 'const note = "new Worker(example)";', "const w = new Worker(url);", ""].join(
      "\n",
    );
    const out = rewriteWorkerConstructors(input, "/src/lib/example.js");
    expect(out).toContain("// new Worker(example)");
    expect(out).toContain('"new Worker(example)"');
    expect(out.match(/createSandboxedWorker\(/g)).toHaveLength(1);
  });

  it("returns null when there is nothing to rewrite, or already rewritten", () => {
    expect(rewriteWorkerConstructors("export const x = 1;\n", "/src/lib/x.js")).toBeNull();
    expect(rewriteWorkerConstructors("// only a comment mentions new Worker\n", "/src/lib/x.js")).toBeNull();
    const once = rewriteWorkerConstructors("new Worker(url);\n", "/src/lib/x.js");
    expect(once).toContain("createSandboxedWorker(url)");
    expect(rewriteWorkerConstructors(once, "/src/lib/x.js")).toBeNull();
  });

  it("masks code so the search cannot see through comments", () => {
    const masked = maskCode('/* new Worker(a) */ // new Worker(b)\nconst s = "new Worker(c)";\nnew Worker(d);');
    expect(masked).not.toContain("new Worker(a)");
    expect(masked).not.toContain("new Worker(b)");
    expect(masked).not.toContain('"new Worker(c)"');
    expect(masked).toContain("new Worker(d);");
  });
});

// ---------------------------------------------------------------------------
// The handle: launch, validate, relay, degrade
// ---------------------------------------------------------------------------

describe("SandboxedWorker (same-origin transport)", () => {
  it("launches a module worker named for diagnostics", () => {
    const factory = workerFactory();
    const w = createSandboxedWorker(ZK_URL, { origin: "same-origin", createWorker: factory.create });
    expect(factory.workers).toHaveLength(1);
    expect(factory.workers[0].init).toMatchObject({ type: "module", name: "helphone-worker" });
    expect(factory.workers[0].url).toBeTruthy();
    expect(w.originMode).toBe("same-origin");
    w.terminate();
  });

  it("forwards schema-valid messages and drops invalid ones", () => {
    const factory = workerFactory();
    const violations = [];
    const w = createSandboxedWorker(ZK_URL, {
      origin: "same-origin",
      createWorker: factory.create,
      onViolation: (v) => violations.push(v),
    });
    const transfer = new ArrayBuffer(4);
    w.postMessage({ id: 1, action: "warmProver" });
    w.postMessage({ action: "warmProver" }); // no id
    w.postMessage({ id: 2, action: "prove", inputs: { a: 1 } }, [transfer]);

    expect(factory.workers[0].sent.map((m) => m.data.id)).toEqual([1, 2]);
    expect(factory.workers[0].sent[1].transfer).toEqual([transfer]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ code: "inbound-schema", boundary: "zk", direction: "inbound", count: 1 });
    expect(w.violations).toHaveLength(1);
    w.terminate();
  });

  it("consumes the boot handshake without leaking it to the app", () => {
    const factory = workerFactory();
    const w = createSandboxedWorker(ZK_URL, { origin: "same-origin", createWorker: factory.create });
    const seen = [];
    w.onmessage = (event) => seen.push(event.data);

    factory.workers[0].emit({ [INTERNAL_CHANNEL]: BOOT_MESSAGE, lockdown: { applied: true } });
    expect(w.isBooted).toBe(true);
    expect(seen).toHaveLength(0);

    factory.workers[0].emit({ type: "progress", id: 1, action: "log", message: "Executing witness" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "progress", message: "Executing witness" });
    w.terminate();
  });

  it("drops malformed worker output and records why", () => {
    const factory = workerFactory();
    const w = createSandboxedWorker(ZK_URL, { origin: "same-origin", createWorker: factory.create });
    const seen = [];
    w.onmessage = (event) => seen.push(event.data);

    factory.workers[0].emit({ type: "done", id: 1, action: "proveComplete", proof: "base64?" });
    factory.workers[0].emit({ type: "unknown", id: 2 });
    expect(seen).toHaveLength(0);
    expect(w.violations.map((v) => v.code)).toEqual(["outbound-schema", "outbound-schema"]);
    expect(w.violations[0]).toMatchObject({ boundary: "zk", direction: "outbound", messageId: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("outbound-schema"));
    w.terminate();
  });

  it("sanitizes workers without a dedicated protocol", () => {
    const factory = workerFactory();
    const w = createSandboxedWorker("/assets/canvas-worker-9f.js", {
      origin: "same-origin",
      createWorker: factory.create,
    });
    const seen = [];
    w.onmessage = (event) => seen.push(event.data);

    w.postMessage({ type: "init", width: 100, height: 80, dpr: 2 });
    expect(factory.workers[0].sent[0].data).toMatchObject({ type: "init" });

    const poisoned = JSON.parse('{"type":"overlays","__proto__":{"x":1}}');
    w.postMessage(poisoned);
    expect(factory.workers[0].sent).toHaveLength(1);

    factory.workers[0].emit({ type: "stats", stats: { fps: 60 } });
    factory.workers[0].emit({ type: "stats", stats: JSON.parse('{"__proto__":{"fps":0}}') });
    expect(seen).toHaveLength(1);
    expect(w.violations.map((v) => v.code)).toEqual(["inbound-schema", "outbound-schema"]);
    w.terminate();
  });

  it("supports addEventListener/removeEventListener and terminate", () => {
    const factory = workerFactory();
    const w = createSandboxedWorker(ZK_URL, { origin: "same-origin", createWorker: factory.create });
    const seen = [];
    const listener = (event) => seen.push(event.data);
    w.addEventListener("message", listener);
    factory.workers[0].emit({ id: 1, action: "isProverReadyResult", ready: true });
    expect(seen).toHaveLength(1);

    w.removeEventListener("message", listener);
    factory.workers[0].emit({ id: 2, action: "isProverReadyResult", ready: false });
    expect(seen).toHaveLength(1);

    const errors = [];
    w.addEventListener("error", (event) => errors.push(event.message));
    factory.workers[0].fail("worker script failed");
    expect(errors[0]).toContain("worker script failed");

    w.terminate();
    expect(factory.workers[0].terminated).toBe(true);
    w.postMessage({ id: 9, action: "prove" });
    expect(factory.workers[0].sent).toHaveLength(0);
  });
});

describe("SandboxedWorker (opaque iframe transport)", () => {
  it("creates the worker inside the frame and flushes queued messages", async () => {
    const frame = makeFrame();
    const w = createSandboxedWorker(ZK_URL, {
      createFrame: () => frame,
      connectTimeoutMs: 500,
      bootTimeoutMs: 500,
    });
    expect(w.originMode).toBe("opaque");
    w.postMessage({ id: 1, action: "isProverReady" });
    expect(frame.posts).toHaveLength(0); // held until the frame connects

    await tick();
    expect(frame.createdWith.name).toBe("helphone-worker");
    expect(frame.createdWith.bootstrap).toContain("installWorkerLockdown");
    expect(frame.createdWith.bootstrap).toContain(ZK_URL);
    expect(frame.posts).toHaveLength(1);
    expect(frame.posts[0].data).toMatchObject({ id: 1, action: "isProverReady" });

    frame.emit({ [INTERNAL_CHANNEL]: BOOT_MESSAGE, lockdown: { applied: true } });
    expect(w.isBooted).toBe(true);
    expect(w.violations).toHaveLength(0);
    w.terminate();
    expect(frame.terminated).toBe(true);
  });

  it("relays both directions and forwards transferables", async () => {
    const frame = makeFrame();
    const w = createSandboxedWorker(ZK_URL, { createFrame: () => frame, connectTimeoutMs: 500, bootTimeoutMs: 500 });
    const seen = [];
    w.onmessage = (event) => seen.push(event.data);

    const proofBuffer = new ArrayBuffer(8);
    w.postMessage({ id: 1, type: "prove", inputs: { a: 1 } }, [proofBuffer]);
    await tick();
    expect(frame.posts[0].transfer).toEqual([proofBuffer]);

    frame.emit({ type: "progress", id: 1, action: "log", message: "Generating proof" });
    expect(seen).toEqual([{ type: "progress", id: 1, action: "log", message: "Generating proof" }]);

    frame.emit({ type: "progress", id: 1, action: "log" });
    expect(seen).toHaveLength(1);
    expect(w.violations.map((v) => v.code)).toEqual(["outbound-schema"]);
    w.terminate();
  });

  it("degrades to a same-origin worker when the frame never connects", async () => {
    const factory = workerFactory();
    const frame = makeFrame({ neverReady: true });
    const w = createSandboxedWorker(ZK_URL, {
      createFrame: () => frame,
      createWorker: factory.create,
      connectTimeoutMs: 10,
      bootTimeoutMs: 500,
    });
    w.postMessage({ id: 1, action: "warmProver" });
    expect(w.originMode).toBe("opaque");

    await tick(40);
    expect(w.originMode).toBe("same-origin");
    expect(frame.terminated).toBe(true);
    expect(factory.workers).toHaveLength(1);
    expect(factory.workers[0].sent[0].data).toMatchObject({ id: 1, action: "warmProver" });
    expect(w.violations.map((v) => v.code)).toEqual(["frame-timeout"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("degraded to same-origin"));
    w.terminate();
  });

  it("degrades when the frame connects but the worker never boots", async () => {
    const factory = workerFactory();
    const frame = makeFrame();
    const w = createSandboxedWorker(ZK_URL, {
      createFrame: () => frame,
      createWorker: factory.create,
      connectTimeoutMs: 500,
      bootTimeoutMs: 10,
    });
    await tick(40);
    expect(w.originMode).toBe("same-origin");
    expect(w.violations.map((v) => v.code)).toEqual(["boot-failure"]);
    w.terminate();
  });

  it("degrades when the bootstrap cannot import the worker module", async () => {
    const factory = workerFactory();
    const frame = makeFrame();
    const w = createSandboxedWorker(ZK_URL, {
      createFrame: () => frame,
      createWorker: factory.create,
      connectTimeoutMs: 500,
      bootTimeoutMs: 500,
    });
    await tick();
    frame.emit({ [INTERNAL_CHANNEL]: BOOT_ERROR_MESSAGE, message: "CORS policy blocked the module" });
    expect(w.originMode).toBe("same-origin");
    expect(w.violations.map((v) => v.code)).toEqual(["boot-failure"]);
    expect(w.violations[0].reason).toContain("CORS policy");
    w.terminate();
  });

  it("never degrades when the caller demanded an opaque origin", async () => {
    const errors = [];
    const frame = makeFrame({ neverReady: true });
    const w = createSandboxedWorker(ZK_URL, {
      origin: "opaque",
      createFrame: () => frame,
      connectTimeoutMs: 10,
      bootTimeoutMs: 10,
      onViolation: () => {},
    });
    w.onerror = (event) => errors.push(event.message);
    await tick(40);
    expect(w.originMode).toBe("opaque");
    expect(errors).toHaveLength(1);
    expect(w.violations.map((v) => v.code)).toEqual(["frame-timeout"]);
  });

  it("reports a frame that fails outright", async () => {
    const errors = [];
    const frame = makeFrame({ createError: "frame script blocked" });
    const w = createSandboxedWorker(ZK_URL, {
      origin: "opaque",
      createFrame: () => frame,
      connectTimeoutMs: 500,
      bootTimeoutMs: 500,
      onViolation: () => {},
    });
    w.onerror = (event) => errors.push(event.message);
    await tick(10);
    expect(errors[0]).toContain("frame script blocked");
    expect(w.violations.map((v) => v.code)).toContain("boot-failure");
  });

  it("queues at most 64 messages while connecting", async () => {
    const frame = makeFrame({ neverReady: true });
    const w = createSandboxedWorker(ZK_URL, {
      createFrame: () => frame,
      createWorker: workerFactory().create,
      connectTimeoutMs: 500,
      bootTimeoutMs: 500,
    });
    for (let i = 0; i < 70; i++) w.postMessage({ id: i, action: "isProverReady" });
    expect(w.violations.map((v) => v.code)).toContain("queue-overflow");
    w.terminate();
  });
});

// ---------------------------------------------------------------------------
// Frame document + environment probe
// ---------------------------------------------------------------------------

describe("buildSandboxFrameHtml", () => {
  it("relays messages and re-transfers transferables", () => {
    const html = buildSandboxFrameHtml();
    expect(html).toContain('data.kind === "create"');
    expect(html).toContain('data.kind === "message"');
    expect(html).toContain('data.kind === "terminate"');
    expect(html).toContain("new Worker(");
    expect(html).toContain("__collect");
    expect(html).not.toContain("nonce=");
  });

  it("carries the embedding document's CSP nonce", () => {
    expect(buildSandboxFrameHtml("abc+DEF/123=")).toContain('nonce="abc+DEF/123="');
    // A nonce must never break out of the attribute.
    expect(buildSandboxFrameHtml('"><script>alert(1)</script>')).not.toContain("alert(1)");
  });
});

describe("prepareWorkerSandbox", () => {
  it("reports what this environment can do", () => {
    vi.stubGlobal("Worker", undefined);
    const support = prepareWorkerSandbox(document);
    expect(support).toEqual({ opaqueOrigin: false, blobUrls: expect.any(Boolean) });
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// Build integration: the Vite plugin
// ---------------------------------------------------------------------------

const SPAWN_SOURCE =
  'export const spawn = () => new Worker(new URL("../workers/x.js", import.meta.url), { type: "module" });\n';

describe("workerSandboxVitePlugin", () => {
  it("is wired into the Vite config as a post plugin", async () => {
    const mod = await import("../vite.config.ts");
    const configFactory = mod.default;
    const config =
      typeof configFactory === "function" ? configFactory({ command: "serve", mode: "test" }) : configFactory;
    const plugins = config.plugins.flat(Infinity).filter(Boolean);
    const plugin = plugins.find((p) => p.name === "helphone:worker-sandbox");
    expect(plugin).toBeTruthy();
    // 'post' places it after vite:worker-import-meta-url and before import
    // analysis, so the worker chunk URL survives while the constructor swaps.
    expect(plugin.enforce).toBe("post");
  }, 30000);

  it("skips the rewrite while tests run and applies it otherwise", async () => {
    const { workerSandboxVitePlugin } = await import("../plugins/vite-plugin-worker-sandbox.js");
    const plugin = workerSandboxVitePlugin();
    plugin.configResolved({ root: "/repo" });

    expect(plugin.transform(SPAWN_SOURCE, "/repo/src/lib/example.js")).toBeNull();

    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const out = plugin.transform(SPAWN_SOURCE, "/repo/src/lib/example.js");
      expect(out.code).toContain("createSandboxedWorker(new URL(");
      expect(out.code).toContain('new URL("../workers/x.js", import.meta.url)');
      expect(plugin.transform(SPAWN_SOURCE, "/repo/test/example.js")).toBeNull();
      expect(plugin.transform(SPAWN_SOURCE, "/repo/src/workers/example.js")).toBeNull();
      expect(plugin.transform(SPAWN_SOURCE, "/repo/node_modules/lib/example.js")).toBeNull();
      expect(plugin.transform("const x = 1;\n", "/repo/src/lib/example.js")).toBeNull();
      expect(plugin.transform(SPAWN_SOURCE, "/repo/src/lib/example.css")).toBeNull();
    } finally {
      process.env.VITEST = saved;
    }
  });

  it("answers Origin: null fetches with ACAO, but never the API", async () => {
    const { workerSandboxVitePlugin } = await import("../plugins/vite-plugin-worker-sandbox.js");
    const plugin = workerSandboxVitePlugin();
    let middleware;
    plugin.configureServer({ middlewares: { use: (fn) => (middleware = fn) } });

    const run = (req) => {
      const headers = {};
      middleware(req, { setHeader: (k, v) => (headers[k] = v) }, () => {});
      return headers;
    };

    expect(run({ headers: { origin: "null" }, method: "GET", url: "/assets/zk-worker.js" })).toEqual({
      "Access-Control-Allow-Origin": "null",
      Vary: "Origin",
    });
    expect(run({ headers: { origin: "null" }, method: "GET", url: "/api/health" })).toEqual({});
    expect(run({ headers: { origin: "https://evil.test" }, method: "GET", url: "/x.js" })).toEqual({});
    expect(run({ headers: {}, method: "GET", url: "/x.js" })).toEqual({});
    expect(run({ headers: { origin: "null" }, method: "POST", url: "/x.js" })).toEqual({});
  });
});
