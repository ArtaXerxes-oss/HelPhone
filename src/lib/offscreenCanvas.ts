/**
 * OffscreenCanvas overlay rendering for the community map.
 *
 * Animated markers (pulsing rings) are drawn on a <canvas> whose control is
 * transferred to a Web Worker via `transferControlToOffscreen()`, so the
 * animation runs on its own thread and cannot be starved by React renders or
 * map interaction on the main thread. Browsers without OffscreenCanvas get the
 * same drawing on the main thread through the identical `drawOverlayFrame`.
 *
 * The frame rate is driven by requestAnimationFrame (display refresh, typically
 * 60 Hz) and *measured*, not assumed: `FpsMeter` reports what was achieved so a
 * slow device is visible instead of silently claimed to be at 60 FPS.
 */
import type { MapOverlay, OverlayKind, OverlayRenderStats } from '../types';

export const TARGET_FPS = 60;
export const STATS_INTERVAL_MS = 1_000;

export const OVERLAY_COLORS: Record<OverlayKind, string> = {
  pending: '#FF7A6B',
  enroute: '#7357FF',
  resolved: '#3F8487',
  responder: '#234B4E',
};

const PULSE_PERIOD_MS = 2_000;
const CORE_RADIUS = 6;
const MAX_PULSE_RADIUS = 22;

/** The subset of a 2D context the renderer uses, so tests can fake it. */
export interface DrawContext {
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(): void;
  stroke(): void;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  globalAlpha: number;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
}

export interface RenderSize {
  /** Logical width/height in map (viewBox) units. */
  width: number;
  height: number;
  /** Device pixel ratio the backing store is scaled by. */
  dpr: number;
}

export interface ViewportTransform {
  /** Zoom scale factor relative to the base viewport (default 1). */
  scale: number;
  /** Pan X offset in logical map units (default 0). */
  offsetX: number;
  /** Pan Y offset in logical map units (default 0). */
  offsetY: number;
  /** Current map zoom level for HP-037 cluster coordination. */
  zoom?: number;
  /** Geographic viewport bounds [west, south, east, north]. */
  bounds?: [number, number, number, number];
}

export const DEFAULT_VIEWPORT_TRANSFORM: ViewportTransform = Object.freeze({
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  zoom: 2,
  bounds: [-180, -85, 180, 85] as [number, number, number, number],
});

/**
 * Applies the shared viewport transform (pan/zoom) to logical coordinates.
 * Identity transforms return the input coordinates without floating-point drift.
 */
export function applyViewportTransform(
  x: number,
  y: number,
  transform?: Partial<ViewportTransform> | null,
): { x: number; y: number } {
  if (!transform) return { x, y };
  const scale = typeof transform.scale === 'number' && Number.isFinite(transform.scale) ? transform.scale : 1;
  const offsetX = typeof transform.offsetX === 'number' && Number.isFinite(transform.offsetX) ? transform.offsetX : 0;
  const offsetY = typeof transform.offsetY === 'number' && Number.isFinite(transform.offsetY) ? transform.offsetY : 0;
  if (scale === 1 && offsetX === 0 && offsetY === 0) return { x, y };
  return {
    x: x * scale + offsetX,
    y: y * scale + offsetY,
  };
}

/**
 * Projects geographic (lng, lat) coordinates into logical viewport coordinates
 * using the same ViewportTransform shared with the HP-037 cluster layer.
 */
export function projectLngLatToViewport(
  lng: number,
  lat: number,
  size: Pick<RenderSize, 'width' | 'height'>,
  transform?: Partial<ViewportTransform> | null,
): { x: number; y: number } {
  const bounds = transform?.bounds && transform.bounds.length === 4 ? transform.bounds : DEFAULT_VIEWPORT_TRANSFORM.bounds!;
  const [west, south, east, north] = bounds;
  const spanLng = east - west || 360;
  const spanLat = north - south || 170;
  const baseX = ((lng - west) / spanLng) * size.width;
  const baseY = ((north - lat) / spanLat) * size.height;
  return applyViewportTransform(baseX, baseY, transform);
}

/**
 * Coordinates HP-037 cluster features and active markers into a single
 * MapOverlay[] list projected through the shared ViewportTransform.
 */
export function buildViewportOverlays({
  points = [],
  clusters = [],
  size,
  transform,
}: {
  points?: ReadonlyArray<{ id: string; lat?: number; lng?: number; x?: number; y?: number; kind?: OverlayKind }>;
  clusters?: ReadonlyArray<{
    id?: string | number;
    properties?: Record<string, unknown>;
    geometry?: { coordinates?: [number, number] };
  }>;
  size: Pick<RenderSize, 'width' | 'height'>;
  transform?: Partial<ViewportTransform> | null;
}): MapOverlay[] {
  const out: MapOverlay[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < clusters.length; i++) {
    const feature = clusters[i];
    const coords = feature?.geometry?.coordinates;
    if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) continue;
    const { x, y } = projectLngLatToViewport(coords[0], coords[1], size, transform);
    const props = feature.properties ?? {};
    const id = String(feature.id ?? props.pointId ?? `cluster-${i}`);
    const rawKind = props.kind as OverlayKind | undefined;
    const kind: OverlayKind =
      rawKind && rawKind in OVERLAY_COLORS
        ? rawKind
        : props.cluster
          ? 'pending'
          : 'responder';
    seenIds.add(id);
    out.push({ id, x, y, kind });
  }

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (!pt || seenIds.has(pt.id)) continue;
    let coords: { x: number; y: number } | null = null;
    if (typeof pt.x === 'number' && typeof pt.y === 'number') {
      coords = applyViewportTransform(pt.x, pt.y, transform);
    } else if (typeof pt.lng === 'number' && typeof pt.lat === 'number') {
      coords = projectLngLatToViewport(pt.lng, pt.lat, size, transform);
    }
    if (!coords) continue;
    const kind: OverlayKind = pt.kind && pt.kind in OVERLAY_COLORS ? pt.kind : 'pending';
    seenIds.add(pt.id);
    out.push({ id: pt.id, x: coords.x, y: coords.y, kind });
  }

  return out;
}

/** Pulse progress 0..1 for a marker at time `t`, staggered per overlay so they don't all beat together. */
export function pulsePhase(t: number, index: number): number {
  return ((t + index * 250) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
}

/** Draw one frame. Pure with respect to its arguments, shared by worker and main thread. */
export function drawOverlayFrame(
  ctx: DrawContext,
  overlays: readonly MapOverlay[],
  size: RenderSize,
  t: number,
  transform?: Partial<ViewportTransform> | null,
): void {
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  overlays.forEach((o, i) => {
    const pos = transform ? applyViewportTransform(o.x, o.y, transform) : o;
    const color = OVERLAY_COLORS[o.kind] ?? OVERLAY_COLORS.pending;
    const phase = pulsePhase(t, i);

    ctx.save();
    ctx.globalAlpha = 0.5 * (1 - phase);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, CORE_RADIUS + phase * (MAX_PULSE_RADIUS - CORE_RADIUS), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, CORE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

/** Rolling frame-rate meter: call `tick(now)` once per frame. */
export class FpsMeter {
  private frames = 0;
  private windowStart: number | null = null;
  private lastFps = 0;

  constructor(private readonly intervalMs = STATS_INTERVAL_MS) {}

  /** Returns fresh stats once per interval, otherwise null. */
  tick(now: number): OverlayRenderStats | null {
    if (this.windowStart === null) {
      this.windowStart = now;
      this.frames = 0;
      return null;
    }
    this.frames++;
    const elapsed = now - this.windowStart;
    if (elapsed < this.intervalMs) return null;
    this.lastFps = (this.frames * 1_000) / elapsed;
    const stats = { fps: this.lastFps, frames: this.frames, windowMs: elapsed };
    this.windowStart = now;
    this.frames = 0;
    return stats;
  }

  get fps(): number {
    return this.lastFps;
  }
}

export function isOffscreenCanvasSupported(
  canvas?: { transferControlToOffscreen?: unknown } | null,
  g: { Worker?: unknown; OffscreenCanvas?: unknown } = globalThis as never,
): boolean {
  return (
    typeof g.Worker === 'function' &&
    typeof g.OffscreenCanvas === 'function' &&
    typeof canvas?.transferControlToOffscreen === 'function'
  );
}

export interface OverlayRenderer {
  readonly mode: 'worker' | 'main-thread';
  setOverlays(overlays: MapOverlay[]): void;
  setViewport?(transform: Partial<ViewportTransform>): void;
  resize(size: RenderSize): void;
  destroy(): void;
}

export interface OverlayRendererOptions extends RenderSize {
  onStats?: (stats: OverlayRenderStats) => void;
  /** Called if the worker fails after control was transferred; the canvas can't be reused, so remount it. */
  onError?: (error: Error) => void;
  /** Skip OffscreenCanvas even when supported (e.g. after a worker failure). */
  forceMainThread?: boolean;
  /** Test seam. Defaults to a module worker running src/workers/canvas-worker.js. */
  createWorker?: () => Worker;
}

type CanvasLike = HTMLCanvasElement & { transferControlToOffscreen(): OffscreenCanvas };

function defaultWorker(): Worker {
  return new Worker(new URL('../workers/canvas-worker.js', import.meta.url), { type: 'module' });
}

function applyBackingStore(canvas: HTMLCanvasElement, size: RenderSize): boolean {
  const targetW = Math.round(size.width * size.dpr);
  const targetH = Math.round(size.height * size.dpr);
  let changed = false;
  if (canvas.width !== targetW) {
    canvas.width = targetW;
    changed = true;
  }
  if (canvas.height !== targetH) {
    canvas.height = targetH;
    changed = true;
  }
  return changed;
}

/**
 * Attach an overlay renderer to `canvas`. Uses a worker when OffscreenCanvas is
 * available, otherwise (or when forced) draws on the main thread.
 */
export function createOverlayRenderer(
  canvas: HTMLCanvasElement,
  opts: OverlayRendererOptions,
): OverlayRenderer {
  if (!opts.forceMainThread && isOffscreenCanvasSupported(canvas)) {
    return createWorkerRenderer(canvas as CanvasLike, opts);
  }
  return createMainThreadRenderer(canvas, opts);
}

function createWorkerRenderer(canvas: CanvasLike, opts: OverlayRendererOptions): OverlayRenderer {
  // Size the backing store before handing over control; afterwards only the worker may resize it.
  applyBackingStore(canvas, opts);
  const offscreen = canvas.transferControlToOffscreen();
  const worker = (opts.createWorker ?? defaultWorker)();

  worker.onmessage = (event: MessageEvent) => {
    if (event.data?.type === 'stats') opts.onStats?.(event.data.stats as OverlayRenderStats);
  };
  worker.onerror = (event: ErrorEvent) => {
    opts.onError?.(new Error(event.message || 'Overlay worker failed'));
  };

  worker.postMessage(
    { type: 'init', canvas: offscreen, width: opts.width, height: opts.height, dpr: opts.dpr },
    [offscreen],
  );

  return {
    mode: 'worker',
    setOverlays: (overlays) => worker.postMessage({ type: 'overlays', overlays }),
    setViewport: (transform) =>
      worker.postMessage({
        type: 'viewport',
        transform: { ...DEFAULT_VIEWPORT_TRANSFORM, ...transform },
      }),
    resize: (size) => worker.postMessage({ type: 'resize', ...size }),
    destroy: () => {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
    },
  };
}

function createMainThreadRenderer(canvas: HTMLCanvasElement, opts: OverlayRendererOptions): OverlayRenderer {
  let size: RenderSize = { width: opts.width, height: opts.height, dpr: opts.dpr };
  let overlays: MapOverlay[] = [];
  let viewport: Partial<ViewportTransform> | null = null;
  let rafId: number | null = null;
  let stopped = false;
  const meter = new FpsMeter();
  const ctx = canvas.getContext('2d') as DrawContext | null;
  applyBackingStore(canvas, size);

  const frame = (now: number) => {
    if (stopped) return;
    if (ctx) drawOverlayFrame(ctx, overlays, size, now, viewport);
    const stats = meter.tick(now);
    if (stats) opts.onStats?.(stats);
    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);

  return {
    mode: 'main-thread',
    setOverlays: (next) => {
      overlays = next;
    },
    setViewport: (next) => {
      viewport = { ...DEFAULT_VIEWPORT_TRANSFORM, ...next };
    },
    resize: (next) => {
      size = next;
      applyBackingStore(canvas, size);
    },
    destroy: () => {
      stopped = true;
      overlays = [];
      viewport = null;
      if (rafId !== null) cancelAnimationFrame(rafId);
    },
  };
}

export interface OverlayBenchmarkResult {
  fps: number;
  frames: number;
  jankFrames: number;
  maxFrameDeltaMs: number;
  backingStoreAllocations: number;
  meetsTarget: boolean;
}

/**
 * Benchmark harness verifying that pan/zoom viewport transforms + HP-037
 * cluster layer overlay updates meet TARGET_FPS without jank or canvas
 * backing-store memory growth (#958).
 */
export function runOverlayBenchmark({
  overlayCount = 64,
  frameCount = 120,
  frameStepMs = 1000 / TARGET_FPS,
  size = { width: 1140, height: 540, dpr: 2 },
}: {
  overlayCount?: number;
  frameCount?: number;
  frameStepMs?: number;
  size?: RenderSize;
} = {}): OverlayBenchmarkResult {
  let widthWrites = 0;
  let heightWrites = 0;
  let backingW = 0;
  let backingH = 0;
  const noop = () => {};
  const ctx: DrawContext = {
    setTransform: noop,
    clearRect: noop,
    beginPath: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    save: noop,
    restore: noop,
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
  };
  const fakeCanvas = {
    get width() {
      return backingW;
    },
    set width(v: number) {
      widthWrites++;
      backingW = v;
    },
    get height() {
      return backingH;
    },
    set height(v: number) {
      heightWrites++;
      backingH = v;
    },
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;

  applyBackingStore(fakeCanvas, size);

  const kinds: OverlayKind[] = ['pending', 'enroute', 'resolved', 'responder'];
  const clusters = Array.from({ length: overlayCount }, (_, i) => ({
    id: `c-${i}`,
    properties: { cluster: i % 4 === 0, kind: kinds[i % kinds.length] },
    geometry: {
      coordinates: [-120 + (i * 3.5) % 240, -50 + (i * 2.1) % 100] as [number, number],
    },
  }));

  const meter = new FpsMeter(STATS_INTERVAL_MS);
  let lastStats: OverlayRenderStats | null = null;
  let jankFrames = 0;
  let maxFrameDeltaMs = 0;
  let prevNow = 0;

  for (let f = 0; f <= frameCount; f++) {
    const now = f * frameStepMs;
    if (f > 0) {
      const delta = now - prevNow;
      if (delta > maxFrameDeltaMs) maxFrameDeltaMs = delta;
      if (delta > (1000 / TARGET_FPS) * 2) jankFrames++;
    }
    prevNow = now;

    // Simulate continuous pan/zoom on the shared viewport transform + redundant resize check
    const transform: ViewportTransform = {
      scale: 1 + (f % 30) * 0.02,
      offsetX: Math.sin(f * 0.1) * 24,
      offsetY: Math.cos(f * 0.1) * 16,
      zoom: 4 + (f % 10) * 0.25,
      bounds: [-180, -85, 180, 85],
    };
    applyBackingStore(fakeCanvas, size);
    const overlays = buildViewportOverlays({ clusters, size, transform });
    drawOverlayFrame(ctx, overlays, size, now, transform);
    const stats = meter.tick(now);
    if (stats) lastStats = stats;
  }

  const fps = lastStats?.fps ?? meter.fps;
  const backingStoreAllocations = Math.max(widthWrites, heightWrites);
  return {
    fps,
    frames: frameCount,
    jankFrames,
    maxFrameDeltaMs,
    backingStoreAllocations,
    meetsTarget: fps >= TARGET_FPS * 0.9 && jankFrames === 0 && backingStoreAllocations === 1,
  };
}
