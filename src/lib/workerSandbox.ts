/**
 * Browser sandbox isolation for untrusted Web Worker scripts.
 *
 * Threat model: worker code is not fully trusted (third-party prover/WASM
 * runtimes, map and telemetry helpers, vendored algorithm modules). A worker
 * that runs with the page's origin could read `localStorage` / `sessionStorage`,
 * reach the app origin's IndexedDB / Cache storage, use DOM globals a library
 * happened to leak, or smuggle prototype-polluting / type-confused payloads
 * across `postMessage`.
 *
 * Three independent layers:
 *
 *  1. **Origin isolation** — the worker is launched from a `blob:` URL created
 *     inside an iframe marked `sandbox="allow-scripts"` (deliberately *without*
 *     `allow-same-origin`), so it inherits an opaque ("null") origin: no
 *     cookies, no app storage, no same-origin privileges. The iframe relays
 *     messages in both directions and re-transfers transferables. When the
 *     opaque origin cannot boot (frame blocked, module graph not CORS
 *     readable, CSP) the sandbox degrades to a same-origin blob worker after a
 *     bounded wait instead of breaking the app.
 *  2. **Lockdown** — a bootstrap blob runs `installWorkerLockdown()` inside the
 *     worker *before* any application code executes, revoking storage and DOM
 *     globals (this layer holds even when origin isolation is unavailable).
 *  3. **Message sanitization** — every payload crossing the boundary is parsed
 *     with a strict zod schema chosen for that worker's protocol, in both
 *     directions. Rejected payloads never reach the other side and are
 *     recorded as violations.
 *
 * The build wires this in through {@link rewriteWorkerConstructors} (invoked
 * from vite.config.ts): every `new Worker(...)` under `src/` becomes a
 * sandboxed launch while the `new URL(..., import.meta.url)` argument keeps
 * Vite's own worker chunking intact.
 */

import { z, type ZodTypeAny } from "zod";

// ---------------------------------------------------------------------------
// Message schemas (strict, one per worker protocol)
// ---------------------------------------------------------------------------

/** Structured-clone friendly binary payload (typed arrays, not DataView). */
const typedArraySchema = z.custom<ArrayBufferView>(
  (value) => ArrayBuffer.isView(value) && !(value instanceof DataView),
  { message: "expected a typed array" },
);

const messageIdSchema = z
  .number()
  .int()
  .nonnegative()
  .lte(Number.MAX_SAFE_INTEGER);

/**
 * Fallback schema for workers without a dedicated protocol: it still rejects
 * payloads that could poison the receiving realm (prototype-pollution keys,
 * absurd nesting) or that are too large to walk.
 */
export const genericWorkerMessageSchema = z.unknown().superRefine((value, ctx) => {
  const FORBIDDEN = ["__proto__", "constructor", "prototype"];
  const MAX_DEPTH = 24;
  const MAX_ARRAY_ITEMS = 4096;
  let budget = 10000;

  const walk = (node: unknown, depth: number, path: (string | number)[]): void => {
    if (depth > MAX_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `message nesting exceeds ${MAX_DEPTH} levels`,
      });
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer) return;
    if (budget-- <= 0) return;
    if (Array.isArray(node)) {
      const items = node.slice(0, MAX_ARRAY_ITEMS);
      for (let i = 0; i < items.length; i++) walk(items[i], depth + 1, [...path, i]);
      return;
    }
    let keys: string[];
    try {
      keys = Object.getOwnPropertyNames(node);
    } catch {
      return; // exotic host object: nothing to inspect, nothing to reject
    }
    for (const key of keys) {
      if (FORBIDDEN.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, key],
          message: `forbidden key "${key}"`,
        });
        return;
      }
      let child: unknown;
      try {
        child = (node as Record<string, unknown>)[key];
      } catch {
        continue; // throwing getter on a host object
      }
      walk(child, depth + 1, [...path, key]);
    }
  };

  walk(value, 0, []);
});

/** Parent → zk-worker: prove / warmProver / isProverReady / initHumanity. */
export const zkWorkerInboundSchema = z
  .strictObject({
    id: messageIdSchema,
    type: z.literal("prove").optional(),
    action: z.enum(["prove", "warmProver", "isProverReady", "initHumanity"]).optional(),
    inputs: z.record(z.unknown()).optional(),
    payload: z.unknown().optional(),
  })
  .refine((value) => value.type === "prove" || value.action !== undefined, {
    message: "either type: 'prove' or an action is required",
    path: ["action"],
  });

/** Log text: the worker only ever sends strings, numbers or booleans. */
const logText = z.union([z.string().max(4096), z.number(), z.boolean()]);

/** zk-worker → parent: progress / result / log / completion / error. */
export const zkWorkerOutboundSchema = z.union([
  z.strictObject({
    type: z.literal("progress"),
    id: messageIdSchema,
    action: z.literal("log"),
    message: logText,
  }),
  z.strictObject({
    type: z.literal("done"),
    id: messageIdSchema,
    action: z.literal("proveComplete"),
    proof: typedArraySchema,
    publicInputs: z.unknown(),
    profiling: z
      .strictObject({
        provingMs: z.number(),
        heapDeltaBytes: z.number(),
        memStats: z
          .strictObject({
            totalAllocated: z.number(),
            pooled: z.number(),
            active: z.number(),
          })
          .passthrough(),
      })
      .passthrough(),
  }),
  z.strictObject({
    type: z.literal("error"),
    id: messageIdSchema,
    action: z.literal("error"),
    error: z.string().max(8192),
  }),
  z.strictObject({
    id: messageIdSchema,
    action: z.enum([
      "log",
      "warmProverComplete",
      "initHumanityComplete",
      "isProverReadyResult",
      "error",
    ]),
    message: logText.optional(),
    error: z.string().max(8192).optional(),
    success: z.boolean().optional(),
    ready: z.boolean().optional(),
  }),
]);

/** Parent → cluster worker: one binning job. */
export const clusterWorkerInboundSchema = z.strictObject({
  id: messageIdSchema,
  points: z.union([typedArraySchema, z.array(z.number())]),
  params: z.strictObject({
    originX: z.number(),
    originY: z.number(),
    cellSize: z.number(),
    fixedScale: z.number(),
    gridW: z.number(),
    gridH: z.number(),
    maxPoints: z.number(),
  }),
});

/** cluster worker → parent: bin results or an error string. */
export const clusterWorkerOutboundSchema = z.union([
  z.strictObject({
    id: messageIdSchema,
    computeMs: z.number().nonnegative(),
    grid: z.strictObject({
      cellCount: typedArraySchema,
      cellSum: typedArraySchema,
      cellRadius: typedArraySchema,
    }),
  }),
  z.strictObject({ id: messageIdSchema, error: z.string().max(2048) }),
]);

export type WorkerSchemas = {
  /** Short protocol label used in violation reports. */
  boundary: string;
  inbound: ZodTypeAny | null;
  outbound: ZodTypeAny | null;
};

/**
 * Pick the schemas for a worker from its emitted file name. Workers without a
 * dedicated protocol still get the generic sanitizer in both directions.
 */
export function selectWorkerSchemas(workerUrl: string): WorkerSchemas {
  const file = String(workerUrl).split("?")[0].split("/").pop() ?? "";
  if (file.startsWith("zk-worker")) {
    return { boundary: "zk", inbound: zkWorkerInboundSchema, outbound: zkWorkerOutboundSchema };
  }
  if (file.startsWith("clusterWorker")) {
    return { boundary: "cluster", inbound: clusterWorkerInboundSchema, outbound: clusterWorkerOutboundSchema };
  }
  return { boundary: "generic", inbound: genericWorkerMessageSchema, outbound: genericWorkerMessageSchema };
}

export type ValidationResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** Parse `data` with `schema`, collapsing zod's issue list to one line. */
export function validateMessage<S extends ZodTypeAny>(schema: S, data: unknown): ValidationResult<z.infer<S>> {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  const path = issue.path.length ? issue.path.map(String).join(".") : "(root)";
  return { ok: false, error: `${path}: ${issue.message}` };
}

// ---------------------------------------------------------------------------
// In-worker lockdown
// ---------------------------------------------------------------------------

export interface WorkerLockdownReport {
  /** Whether the lockdown ran (false when called on a window-like realm). */
  applied: boolean;
  /** Every key the lockdown is designed to remove. */
  blocked: string[];
  /** Keys that were present and are now gone. */
  revoked: string[];
  /** Keys that could not be deleted and now throw on access. */
  guarded: string[];
  /** Keys that stayed readable because neither removal worked. */
  unrevocable: string[];
  at: number;
}

/**
 * Revoke storage and DOM globals inside a worker.
 *
 * Deliberately **self contained**: the source is stringified into the
 * bootstrap blob, so it must not reference any binding declared outside its
 * own body (no shared constants, no helpers, no imports). It is idempotent and
 * is also called directly from worker modules as a second line of defence.
 *
 * Safety rail: refuses to run against a window-like realm (anything that has a
 * `document`), because stripping DOM globals from the main thread would break
 * the application — this function is for workers only.
 *
 * `localStorage` / `sessionStorage` do not exist in dedicated workers, so each
 * property is deleted where possible (keeps `typeof x === "undefined"` feature
 * detection working for third-party code) and made to throw where it cannot be
 * removed.
 */
export function installWorkerLockdown(target?: Record<string, unknown>): WorkerLockdownReport {
  const g = (target ?? (globalThis as unknown as Record<string, unknown>)) as Record<string, unknown>;

  const prior = g.__helphoneWorkerLockdown as WorkerLockdownReport | undefined;
  if (prior) return prior;

  const blocked = [
    // storage & persistence
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "caches",
    "BroadcastChannel",
    "SharedWorker",
    // ad-hoc script loading (classic workers only)
    "importScripts",
    // parent window / DOM references a leaked binding would resolve to
    "window",
    "document",
    "parent",
    "top",
    "frames",
    "opener",
  ];

  let hasDocument = false;
  try {
    hasDocument = "document" in g && g.document != null;
  } catch {
    hasDocument = false;
  }

  const base: WorkerLockdownReport = {
    applied: false,
    blocked: blocked.slice(),
    revoked: [],
    guarded: [],
    unrevocable: [],
    at: Date.now(),
  };
  if (hasDocument) {
    return base;
  }

  for (const key of blocked) {
    let present = false;
    try {
      present = key in g;
    } catch {
      present = false;
    }
    try {
      // Prefer deletion: third-party feature detection keeps working.
      delete g[key];
    } catch {
      /* non-deletable property, handled below */
    }
    let stillThere = false;
    try {
      stillThere = key in g;
    } catch {
      stillThere = true;
    }
    if (!stillThere) {
      if (present) base.revoked.push(key);
      continue;
    }
    // Could not delete it: make every access fail loudly instead of silently
    // handing out the real object.
    try {
      const error = new Error(`worker sandbox: "${key}" is revoked`);
      Object.defineProperty(g, key, {
        configurable: false,
        enumerable: false,
        get() {
          throw error;
        },
        set() {
          throw error;
        },
      });
      base.guarded.push(key);
    } catch {
      base.unrevocable.push(key);
    }
  }

  base.applied = true;
  try {
    g.__helphoneWorkerLockdown = base;
  } catch {
    /* frozen global — the lockdown itself still applied */
  }
  return base;
}

// ---------------------------------------------------------------------------
// Bootstrap blob
// ---------------------------------------------------------------------------

/** Namespace for messages that must never reach application code. */
export const INTERNAL_CHANNEL = "__helphone";
export const BOOT_MESSAGE = "boot";
export const BOOT_ERROR_MESSAGE = "boot-error";

/** True for sandbox control messages (boot handshake, boot failures). */
export function isInternalMessage(data: unknown): data is Record<string, unknown> {
  return Boolean(data && typeof data === "object" && (data as Record<string, unknown>)[INTERNAL_CHANNEL]);
}

/**
 * Source of the bootstrap module executed inside the worker: run the lockdown
 * first, announce it (with its report), then import the real worker module.
 * The URL must be absolute — a `blob:` URL has no base for relative imports.
 */
export function buildWorkerBootstrap(workerUrl: string): string {
  const url = JSON.stringify(String(workerUrl));
  const channel = JSON.stringify(INTERNAL_CHANNEL);
  return [
    "/* helphone worker sandbox bootstrap */",
    `const __lockdown = (${installWorkerLockdown.toString()})();`,
    `self.postMessage({ ${channel}: ${JSON.stringify(BOOT_MESSAGE)}, lockdown: __lockdown });`,
    `import(${url}).catch((error) => {`,
    `  self.postMessage({ ${channel}: ${JSON.stringify(BOOT_ERROR_MESSAGE)},`,
    `    message: String((error && error.message) || error) });`,
    `});`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Transferables
// ---------------------------------------------------------------------------

/** `Object.prototype.toString` brands of transferable host objects. */
const TRANSFERABLE_BRANDS = new Set([
  "[object OffscreenCanvas]",
  "[object ImageBitmap]",
  "[object MessagePort]",
  "[object ReadableStream]",
  "[object WritableStream]",
  "[object TransformStream]",
  "[object VideoFrame]",
  "[object AudioData]",
]);

function isTransferable(value: object): boolean {
  try {
    return TRANSFERABLE_BRANDS.has(Object.prototype.toString.call(value));
  } catch {
    return false;
  }
}

/**
 * Collect every transferable reachable in a structured-clone payload so the
 * sandbox relay keeps zero-copy semantics on both hops (ArrayBuffer views,
 * OffscreenCanvas, ImageBitmap, streams, …).
 */
export function collectTransferables(
  value: unknown,
  out: unknown[] = [],
  seen = new Set<unknown>(),
  depth = 0,
): unknown[] {
  if (value === null || typeof value !== "object" || depth > 32 || seen.has(value)) return out;
  seen.add(value);
  if (value instanceof ArrayBuffer) {
    if (!out.includes(value)) out.push(value);
    return out;
  }
  if (ArrayBuffer.isView(value)) {
    const buffer = (value as ArrayBufferView).buffer;
    if (buffer instanceof ArrayBuffer && !out.includes(buffer)) out.push(buffer);
    return out;
  }
  if (isTransferable(value) || (typeof MessagePort !== "undefined" && value instanceof MessagePort)) {
    if (!out.includes(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTransferables(item, out, seen, depth + 1);
    return out;
  }
  let keys: string[];
  try {
    keys = Object.keys(value as Record<string, unknown>);
  } catch {
    return out;
  }
  for (const key of keys) {
    let child: unknown;
    try {
      child = (value as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    collectTransferables(child, out, seen, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sandbox frame (null origin)
// ---------------------------------------------------------------------------

export type WorkerOriginMode = "opaque" | "same-origin";

/** Transport used by the handle: parent ↔ (iframe relay) ↔ worker. */
export interface SandboxTransport {
  readonly originMode: WorkerOriginMode;
  /** Resolves once the transport can accept messages. */
  whenReady(): Promise<void>;
  post(data: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onMessage(listener: (data: unknown) => void): void;
  onError(listener: (error: Error) => void): void;
  onBoot(listener: (message: Record<string, unknown>) => void): void;
}

export interface SandboxTransportOptions {
  workerUrl: string;
  bootstrap: string;
  name?: string;
  /** Test seam: build the worker without the DOM. */
  createWorker?: (url: string, init?: WorkerOptions) => Worker;
  /** Test seam: skip the iframe and hand-roll the relay. */
  createFrame?: () => SandboxFrame | null;
}

/** Parent side of the sandboxed-iframe relay. */
export interface SandboxFrame {
  readonly origin: string;
  /** Create the worker inside the frame; resolves once it is live. */
  create(bootstrap: string, name?: string): Promise<void>;
  post(data: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onMessage(listener: (data: unknown) => void): void;
  onError(listener: (error: Error) => void): void;
}

const FRAME_TOKEN_PREFIX = "helphone-worker-sandbox";

function randomToken(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${FRAME_TOKEN_PREFIX}:${rand}`;
}

function makeMessageEvent(data: unknown): MessageEvent {
  if (typeof MessageEvent === "function") {
    try {
      return new MessageEvent("message", { data });
    } catch {
      /* some environments reject MessageEvent construction */
    }
  }
  return { data } as MessageEvent;
}

function makeErrorEvent(message: string): ErrorEvent {
  if (typeof ErrorEvent === "function") {
    try {
      return new ErrorEvent("error", { message });
    } catch {
      /* fall through */
    }
  }
  return { message } as unknown as ErrorEvent;
}

/**
 * Document loaded into the sandboxed iframe. It owns the blob URL and the
 * worker, and mirrors every payload to the parent while re-transferring
 * transferables. Emitted as a string so it stays independent of the bundle.
 *
 * `nonce` is forwarded from the embedding document: `srcdoc` documents inherit
 * the parent's CSP, so an inline script under a nonce policy must carry it.
 */
export function buildSandboxFrameHtml(nonce = ""): string {
  const collect = collectTransferables.toString();
  const nonceAttr = nonce ? ` nonce="${nonce.replace(/[^A-Za-z0-9+/=_-]/g, "")}"` : "";
  return `<!doctype html><meta charset="utf-8"><title>helphone worker sandbox</title><script${nonceAttr}>
(function () {
  var token = null, worker = null, objectUrl = null;
  var __collect = (${collect});
  function send(message, transfer) {
    try { parent.postMessage(message, "*", transfer || []); } catch (error) {}
  }
  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.kind === "hello") { token = data.token; return; }
    if (!token || data.token !== token) return;
    if (data.kind === "create") {
      try {
        objectUrl = URL.createObjectURL(new Blob([data.bootstrap], { type: "text/javascript" }));
        worker = new Worker(objectUrl, { type: "module", name: data.name || "helphone-worker" });
        worker.onmessage = function (ev) {
          send({ token: token, kind: "message", data: ev.data }, __collect(ev.data, []));
        };
        worker.onmessageerror = function () {
          send({ token: token, kind: "error", message: "worker payload failed to deserialize" });
        };
        worker.onerror = function (ev) {
          send({ token: token, kind: "error", message: String((ev && ev.message) || "worker script failed") });
        };
        send({ token: token, kind: "ready" });
      } catch (error) {
        send({ token: token, kind: "error", message: String((error && error.message) || error) });
      }
      return;
    }
    if (data.kind === "message") {
      if (!worker) return;
      var transfer = data.transfer || [];
      if (!transfer.length && data.data && typeof data.data === "object") {
        transfer = __collect(data.data, []);
      }
      try { worker.postMessage(data.data, transfer); }
      catch (error) { send({ token: token, kind: "error", message: String((error && error.message) || error) }); }
      return;
    }
    if (data.kind === "terminate") {
      if (worker) { try { worker.terminate(); } catch (error) {} }
      if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch (error) {} }
      worker = null; objectUrl = null;
      send({ token: token, kind: "terminated" });
    }
  });
  send({ kind: "loaded" });
})();
</script>`;
}

/** Read the embedding document's CSP nonce so the srcdoc script may run. */
function readCspNonce(target: Document): string {
  try {
    const el = target.querySelector("script[nonce]") as HTMLScriptElement | null;
    if (!el) return "";
    return (el.nonce as string) || el.getAttribute("nonce") || "";
  } catch {
    return "";
  }
}

/**
 * Create a hidden `sandbox="allow-scripts"` iframe (opaque origin) that owns
 * the blob URL and the worker. Returns `null` when the environment has no
 * usable DOM — callers then fall back to a same-origin blob worker.
 */
export function createDomSandboxFrame(doc?: Document): SandboxFrame | null {
  const target = doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!target || typeof target.createElement !== "function") return null;
  if (typeof Worker !== "function") return null;

  const token = randomToken();
  const iframe = target.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("title", "helphone worker sandbox");
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.style.cssText =
    "position:fixed;left:-1px;top:-1px;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  iframe.srcdoc = buildSandboxFrameHtml(readCspNonce(target));

  const messageListeners: Array<(data: unknown) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  let settled: { resolve: () => void; reject: (error: Error) => void } | null = null;
  let loaded = false;
  let ready = false;
  let terminated = false;
  let pendingCreate: { bootstrap: string; name?: string } | null = null;

  const postToFrame = (payload: Record<string, unknown>, transfer?: Transferable[]) => {
    iframe.contentWindow?.postMessage(payload, "*", transfer ?? []);
  };

  const flushPending = () => {
    if (!loaded || !pendingCreate) return;
    const create = pendingCreate;
    pendingCreate = null;
    postToFrame({ kind: "hello", token });
    postToFrame({ kind: "create", token, bootstrap: create.bootstrap, name: create.name });
  };

  const handleParentMessage = (event: MessageEvent) => {
    if (terminated) return;
    const source = (iframe.contentWindow as Window | null) ?? null;
    if (!source || event.source !== source) return;
    // A sandboxed frame reports an opaque origin; anything else is an impostor.
    if (event.origin !== "null" && event.origin !== "") return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return;

    if (data.kind === "loaded") {
      loaded = true;
      flushPending();
      return;
    }
    if (data.token !== token) return;
    if (data.kind === "ready") {
      ready = true;
      settled?.resolve();
      settled = null;
      return;
    }
    if (data.kind === "message") {
      for (const listener of messageListeners) listener(data.data);
      return;
    }
    if (data.kind === "error") {
      const error = new Error(String(data.message ?? "worker sandbox error"));
      if (!ready && settled) {
        settled.reject(error);
        settled = null;
      }
      for (const listener of errorListeners) listener(error);
    }
  };

  const dispose = () => {
    terminated = true;
    if (typeof window !== "undefined") window.removeEventListener("message", handleParentMessage);
    iframe.remove();
  };

  if (typeof window !== "undefined") window.addEventListener("message", handleParentMessage);
  (target.documentElement ?? target.body)?.appendChild(iframe);

  return {
    origin: "null",
    create(bootstrap: string, name?: string) {
      pendingCreate = { bootstrap, name };
      flushPending();
      return new Promise<void>((resolve, reject) => {
        settled = { resolve, reject };
        // The frame posts "loaded" once its script is live; if that never
        // happens the handle's connect timeout degrades the worker instead.
        setTimeout(() => {
          if (!ready && settled) {
            settled = null;
            reject(new Error("worker sandbox frame did not become ready"));
          }
        }, 4000);
      });
    },
    post(data, transfer) {
      postToFrame({ kind: "message", token, data, transfer }, transfer as Transferable[]);
    },
    terminate() {
      if (terminated) return;
      postToFrame({ kind: "terminate", token });
      setTimeout(dispose, 0);
    },
    onMessage(listener) {
      messageListeners.push(listener);
    },
    onError(listener) {
      errorListeners.push(listener);
    },
  };
}

/** Same-origin transport: blob URL created and owned by the page itself. */
export function createDirectTransport(options: SandboxTransportOptions): SandboxTransport {
  const { workerUrl, bootstrap, name, createWorker } = options;
  const factory =
    createWorker ??
    ((url: string, init?: WorkerOptions) => {
      if (typeof Worker !== "function") throw new Error("worker sandbox: no Worker implementation available");
      return new Worker(url, init);
    });

  const blob = new Blob([bootstrap], { type: "text/javascript" });
  const canMint = typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
  // Environments without blob URLs (jsdom/tests) still get a stable handle.
  const objectUrl = canMint ? URL.createObjectURL(blob) : `blob:helphone-worker-sandbox/${name ?? "worker"}`;
  const worker = factory(objectUrl, { type: "module", name: name ?? "helphone-worker" });

  const messageListeners: Array<(data: unknown) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const bootListeners: Array<(message: Record<string, unknown>) => void> = [];

  worker.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (isInternalMessage(data)) {
      for (const listener of bootListeners) listener(data);
      return;
    }
    for (const listener of messageListeners) listener(data);
  };
  worker.onerror = (event: ErrorEvent) => {
    const error = new Error(event?.message ?? "worker script failed");
    for (const listener of errorListeners) listener(error);
  };

  return {
    originMode: "same-origin",
    async whenReady() {
      /* a same-origin blob worker is usable immediately */
    },
    post(data, transfer) {
      worker.postMessage(data, transfer as Transferable[]);
    },
    terminate() {
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
      if (canMint) URL.revokeObjectURL(objectUrl);
    },
    onMessage(listener) {
      messageListeners.push(listener);
    },
    onError(listener) {
      errorListeners.push(listener);
    },
    onBoot(listener) {
      bootListeners.push(listener);
    },
  };
}

/** Opaque transport: iframe-owned blob URL + relayed messages. */
export function createOpaqueTransport(options: SandboxTransportOptions): SandboxTransport | null {
  const frame = (options.createFrame ?? createDomSandboxFrame)();
  if (!frame) return null;

  const messageListeners: Array<(data: unknown) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const bootListeners: Array<(message: Record<string, unknown>) => void> = [];
  const ready = frame.create(options.bootstrap, options.name).catch((error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    for (const listener of errorListeners) listener(err);
    throw err;
  });

  frame.onMessage((data) => {
    if (isInternalMessage(data)) {
      for (const listener of bootListeners) listener(data);
      return;
    }
    for (const listener of messageListeners) listener(data);
  });
  frame.onError((error) => {
    for (const listener of errorListeners) listener(error);
  });

  return {
    originMode: "opaque",
    whenReady: () => ready,
    post(data, transfer) {
      frame.post(data, transfer);
    },
    terminate() {
      frame.terminate();
    },
    onMessage(listener) {
      messageListeners.push(listener);
    },
    onError(listener) {
      errorListeners.push(listener);
    },
    onBoot(listener) {
      bootListeners.push(listener);
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type SandboxViolationCode =
  | "inbound-schema"
  | "outbound-schema"
  | "boot-failure"
  | "frame-timeout"
  | "queue-overflow"
  | "transport-error";

export interface WorkerSandboxViolation {
  code: SandboxViolationCode;
  /** Protocol label of the boundary that rejected the payload. */
  boundary: string;
  direction?: "inbound" | "outbound";
  reason: string;
  /** Correlation id when one could be read from the payload. */
  messageId?: number;
  /** 1-based ordinal of this violation on the handle. */
  count: number;
  at: number;
}

export interface WorkerSandboxOptions {
  /** Worker module type; module workers only (blob ES modules). */
  type?: "module";
  /** Diagnostics name forwarded to `new Worker(..., { name })`. */
  name?: string;
  /**
   * Origin isolation to attempt.
   * - `auto` (default): opaque/null origin first, degrading on boot failure
   * - `opaque`: never degrade (fail instead)
   * - `same-origin`: skip the iframe, keep lockdown + sanitization
   */
  origin?: "auto" | WorkerOriginMode;
  /** Override protocol detection (used by tests and exotic entry points). */
  schemas?: Partial<WorkerSchemas> | null;
  /** Test seam: build the worker without the DOM. */
  createWorker?: (url: string, init?: WorkerOptions) => Worker;
  /** Test seam: inject the iframe relay. */
  createFrame?: () => SandboxFrame | null;
  /** How long to wait for the opaque transport before degrading. */
  connectTimeoutMs?: number;
  /** How long to wait for the worker's boot handshake before degrading. */
  bootTimeoutMs?: number;
  /** Set `false` to surface boot failures instead of degrading. */
  fallbackToSameOrigin?: boolean;
  /** Called for every rejected payload or degradation event. */
  onViolation?: (violation: WorkerSandboxViolation) => void;
}

const MAX_QUEUE = 64;

/**
 * Worker-compatible handle returned by {@link createSandboxedWorker}. Exposes
 * the subset of the `Worker` surface the app uses (`postMessage`, `terminate`,
 * `onmessage`/`onerror`, `addEventListener`) plus sandbox diagnostics.
 */
export class SandboxedWorker implements Worker {
  onmessage: ((this: Worker, ev: MessageEvent) => any) | null = null;
  onmessageerror: ((this: Worker, ev: MessageEvent) => any) | null = null;
  onerror: ((this: AbstractWorker, ev: ErrorEvent) => any) | null = null;

  readonly name: string;
  readonly schemas: WorkerSchemas;

  private transport: SandboxTransport | null = null;
  private transportReady = false;
  /** Origin isolation of the transport currently (or last) in force. */
  private activeOrigin: WorkerOriginMode | null = null;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  private readonly queue: Array<{ data: unknown; transfer?: Transferable[] }> = [];
  private readonly recorded: WorkerSandboxViolation[] = [];
  private readonly options: WorkerSandboxOptions;
  private readonly workerUrl: string;
  private readonly bootstrap: string;
  private readonly requestedOrigin: "auto" | WorkerOriginMode;
  private booted = false;
  private terminated = false;
  private degraded = false;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(workerUrl: string | URL, options: WorkerSandboxOptions = {}) {
    this.workerUrl = String(workerUrl);
    this.options = options;
    this.name = options.name ?? "helphone-worker";
    this.schemas = { ...selectWorkerSchemas(this.workerUrl), ...(options.schemas ?? {}) };
    this.bootstrap = buildWorkerBootstrap(this.workerUrl);
    this.requestedOrigin = options.origin ?? "auto";
    this.start(this.requestedOrigin === "same-origin" ? "same-origin" : "opaque");
  }

  /** Which origin isolation is currently in force. */
  get originMode(): WorkerOriginMode {
    return this.activeOrigin ?? "same-origin";
  }

  /** True once the worker executed the lockdown bootstrap. */
  get isBooted(): boolean {
    return this.booted;
  }

  get violations(): readonly WorkerSandboxViolation[] {
    return this.recorded;
  }

  postMessage(message: any, transfer: Transferable[]): void;
  postMessage(message: any, options?: StructuredSerializeOptions): void;
  postMessage(message: any, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
    if (this.terminated) return;
    const transfer = Array.isArray(transferOrOptions)
      ? transferOrOptions
      : transferOrOptions && Array.isArray((transferOrOptions as StructuredSerializeOptions).transfer)
        ? (transferOrOptions as StructuredSerializeOptions).transfer
        : undefined;

    const result = this.schemas.inbound
      ? validateMessage(this.schemas.inbound, message)
      : ({ ok: true, data: message } as const);
    if (!result.ok) {
      this.record("inbound-schema", result.error, "inbound", message);
      return;
    }
    const payload = result.data;
    if (!this.transportReady || !this.transport) {
      if (this.queue.length >= MAX_QUEUE) {
        this.queue.shift();
        this.record("queue-overflow", `dropped oldest queued message (cap ${MAX_QUEUE})`, "inbound", payload);
      }
      this.queue.push({ data: payload, transfer });
      return;
    }
    this.deliver(payload, transfer);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.transport?.terminate();
    this.transport = null;
    this.queue.length = 0;
    this.listeners.clear();
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (!listener) return;
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (!listener) return;
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    this.emit(event.type, event);
    return true;
  }

  // -- internals ----------------------------------------------------------

  private start(mode: WorkerOriginMode): void {
    const options: SandboxTransportOptions = {
      workerUrl: this.workerUrl,
      bootstrap: this.bootstrap,
      name: this.name,
      createWorker: this.options.createWorker,
      createFrame: this.options.createFrame,
    };

    let transport: SandboxTransport | null = null;
    if (mode === "opaque") {
      transport = createOpaqueTransport(options);
      if (!transport) {
        if (this.requestedOrigin === "opaque") {
          this.record("frame-timeout", "opaque origin unavailable in this environment", "inbound");
          this.fail(new Error("worker sandbox: opaque origin unavailable"));
        }
        // `auto`: silently continue with a same-origin blob worker.
      }
    }
    if (!transport) {
      try {
        transport = createDirectTransport(options);
      } catch (error) {
        this.emitError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }

    this.transport = transport;
    this.activeOrigin = transport.originMode;
    this.transportReady = transport.originMode === "same-origin";
    const bound = transport;
    transport.onMessage((data) => {
      if (this.transport !== bound) return;
      this.fromWorker(data);
    });
    transport.onError((error) => {
      if (this.transport !== bound) return;
      this.fromTransportError(error);
    });
    transport.onBoot((message) => {
      if (this.transport !== bound) return;
      this.fromBoot(message);
    });

    if (transport.originMode === "opaque") {
      this.armConnectTimeout();
      transport
        .whenReady()
        .then(() => {
          if (this.terminated || this.transport !== bound) return;
          this.transportReady = true;
          this.armBootTimeout();
          this.flush();
        })
        .catch(() => {
          /* handled through onError */
        });
    } else {
      // Same-origin workers are usable immediately, including after a
      // degradation replay of everything queued while the frame connected.
      this.flush();
    }
  }

  private armConnectTimeout(): void {
    const timeout = this.options.connectTimeoutMs ?? 4000;
    if (!Number.isFinite(timeout)) return;
    setTimeout(() => {
      if (this.terminated || this.degraded || this.transportReady || this.booted) return;
      this.record("frame-timeout", `opaque origin not ready within ${timeout}ms`, "inbound");
      this.degrade("frame timeout");
    }, timeout);
  }

  private armBootTimeout(): void {
    const timeout = this.options.bootTimeoutMs ?? 6000;
    if (!Number.isFinite(timeout)) return;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = setTimeout(() => {
      if (this.terminated || this.booted) return;
      if (this.transport?.originMode !== "opaque" || this.degraded) return;
      this.record("boot-failure", `no boot handshake within ${timeout}ms`, "inbound");
      this.degrade("boot timeout");
    }, timeout);
  }

  private degrade(reason: string): void {
    if (this.degraded || this.terminated) return;
    this.degraded = true;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.transport?.terminate();
    this.transport = null;
    this.transportReady = false;
    if (this.options.fallbackToSameOrigin === false || this.requestedOrigin === "opaque") {
      this.fail(new Error(`worker sandbox: ${reason}`));
      return;
    }
    this.start("same-origin");
    if (typeof console !== "undefined") {
      console.warn(`[worker-sandbox] degraded to same-origin (${reason}): ${this.workerUrl}`);
    }
  }

  private fail(error: Error): void {
    this.terminated = true;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.transport?.terminate();
    this.transport = null;
    this.transportReady = false;
    this.emitError(error);
  }

  private deliver(data: unknown, transfer?: Transferable[]): void {
    try {
      this.transport?.post(data, transfer);
    } catch (error) {
      this.record("transport-error", error instanceof Error ? error.message : String(error), "inbound", data);
    }
  }

  private flush(): void {
    const queued = this.queue.splice(0, this.queue.length);
    for (const entry of queued) this.deliver(entry.data, entry.transfer);
  }

  private fromBoot(message: Record<string, unknown>): void {
    if (message[INTERNAL_CHANNEL] === BOOT_ERROR_MESSAGE) {
      this.record("boot-failure", String(message.message ?? "worker module failed to load"), "inbound");
      if (this.transport?.originMode === "opaque" && this.options.fallbackToSameOrigin !== false && !this.degraded) {
        this.degrade("bootstrap import failed");
      } else {
        this.emitError(new Error(String(message.message ?? "worker module failed to load")));
      }
      return;
    }
    this.booted = true;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.flush();
  }

  private fromWorker(data: unknown): void {
    if (isInternalMessage(data)) {
      this.fromBoot(data as Record<string, unknown>);
      return;
    }
    const result = this.schemas.outbound
      ? validateMessage(this.schemas.outbound, data)
      : ({ ok: true, data } as const);
    if (!result.ok) {
      this.record("outbound-schema", result.error, "outbound", data);
      return;
    }
    const event = makeMessageEvent(result.data);
    this.onmessage?.call(this as unknown as Worker, event);
    this.emit("message", event);
  }

  private fromTransportError(error: Error): void {
    if (!this.booted && !this.degraded && this.transport?.originMode === "opaque") {
      this.record("boot-failure", error.message, "inbound");
      this.degrade(error.message);
      return;
    }
    this.emitError(error);
  }

  private emitError(error: Error): void {
    const event = makeErrorEvent(error.message);
    this.onerror?.call(this as unknown as AbstractWorker, event);
    this.emit("error", event);
  }

  private emit(type: string, event: Event): void {
    const set = this.listeners.get(type);
    if (!set || !set.size) return;
    for (const listener of [...set]) {
      try {
        if (typeof listener === "function") listener.call(this as unknown as Worker, event);
        else listener.handleEvent(event);
      } catch {
        /* a broken listener must not break the boundary */
      }
    }
  }

  private record(
    code: SandboxViolationCode,
    reason: string,
    direction?: "inbound" | "outbound",
    payload?: unknown,
  ): void {
    const violation: WorkerSandboxViolation = {
      code,
      boundary: this.schemas.boundary,
      direction,
      reason,
      messageId: readMessageId(payload),
      count: this.recorded.length + 1,
      at: Date.now(),
    };
    this.recorded.push(violation);
    if (this.recorded.length > 100) this.recorded.shift();
    const handler = this.options.onViolation;
    if (handler) handler(violation);
    else if (typeof console !== "undefined") {
      console.warn(`[worker-sandbox] ${code} (${violation.boundary}): ${reason}`);
    }
  }
}

function readMessageId(payload: unknown): number | undefined {
  if (payload && typeof payload === "object" && typeof (payload as { id?: unknown }).id === "number") {
    return (payload as { id: number }).id;
  }
  return undefined;
}

/**
 * Launch an untrusted worker through the sandbox.
 *
 * Returns synchronously (launch sites keep their `new Worker(...)` shape); the
 * opaque transport connects in the background, messages posted before it is
 * ready are queued and flushed, or replayed into a degraded same-origin worker.
 */
export function createSandboxedWorker(workerUrl: string | URL, options: WorkerSandboxOptions = {}): SandboxedWorker {
  return new SandboxedWorker(workerUrl, options);
}

export interface WorkerSandboxSupport {
  /** A sandboxed (opaque) frame could be created in this environment. */
  opaqueOrigin: boolean;
  /** Blob URLs can be minted at all. */
  blobUrls: boolean;
}

/**
 * Probe the current environment for sandbox support so the first worker launch
 * does not pay the iframe warm-up cost.
 */
export function prepareWorkerSandbox(doc?: Document): WorkerSandboxSupport {
  let blobUrls = false;
  try {
    blobUrls = typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
  } catch {
    blobUrls = false;
  }
  const frame = blobUrls ? createDomSandboxFrame(doc) : null;
  if (frame) frame.terminate();
  return { opaqueOrigin: Boolean(frame), blobUrls };
}

// ---------------------------------------------------------------------------
// Build integration
// ---------------------------------------------------------------------------

/**
 * Blank out comments and quoted strings (same length, same offsets) so the
 * constructor search never rewrites documentation or string literals.
 */
export function maskCode(code: string): string {
  const out = code.split("");
  let i = 0;
  const n = code.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) out[k] = " ";
  };
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      blank(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      blank(i, end === -1 ? n : end + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === quote) {
          j += 1;
          break;
        }
        // Template literals may nest `${ ... }`; treat the whole literal as
        // opaque — nobody writes a worker launch inside an interpolation.
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/**
 * Rewrite `new Worker(...)` call sites into sandboxed launches.
 *
 * Invoked by the `helphone:worker-sandbox` plugin in vite.config.ts with
 * `enforce: 'post'`, i.e. after `vite:worker-import-meta-url` has turned
 * `new URL('../workers/x.js', import.meta.url)` into a worker chunk URL — the
 * argument list is untouched, only the constructor is swapped. Returns `null`
 * when the module has nothing to rewrite.
 */
export function rewriteWorkerConstructors(code: string, id: string): string | null {
  if (id.includes("workerSandbox")) return null;
  if (!/\bnew\s+Worker\s*\(/.test(maskCode(code))) return null;
  if (/\bcreateSandboxedWorker\s*\(/.test(code)) return null;

  const masked = maskCode(code);
  const spans: Array<[number, number]> = [];
  const pattern = /\bnew\s+Worker\s*\(/g;
  let match = pattern.exec(masked);
  while (match) {
    const start = match.index;
    const end = start + match[0].lastIndexOf("Worker") + "Worker".length;
    spans.push([start, end]);
    match = pattern.exec(masked);
  }
  if (!spans.length) return null;

  let rewritten = code;
  for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) {
    rewritten = `${rewritten.slice(0, start)}createSandboxedWorker${rewritten.slice(end)}`;
  }
  if (/from\s+["'][^"']*workerSandbox(\.ts)?["']/.test(rewritten)) return rewritten;
  return `import { createSandboxedWorker } from "/src/lib/workerSandbox.ts";\n${rewritten}`;
}
