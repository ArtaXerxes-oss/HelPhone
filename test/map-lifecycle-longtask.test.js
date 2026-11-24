import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  MapboxGLResourceManager,
  CrossRouteResourceManager,
  YjsResourceManager,
  WebSocketResourceManager,
} from '../src/lib/memoryLeakFixes'
import {
  DEFAULT_LONG_TASK_THRESHOLDS,
  LongTaskMonitor,
  MAX_BOUNDED_TELEMETRY_EVENTS,
} from '../src/lib/mainThreadOptimization'
import {
  TelemetryPipeline,
  createMemoryExporter,
  getLongTaskTelemetryEvents,
  clearLongTaskTelemetryEvents,
  MAX_LONGTASK_NAME_LENGTH,
} from '../src/lib/telemetry'

describe('Map lifecycle resource disposal (#961)', () => {
  it('disposes map instance, listeners, animation frames, markers, and overlays on unmount', () => {
    const mgr = new MapboxGLResourceManager()
    const fakeMap = {
      off: vi.fn(),
      remove: vi.fn(),
      isRemoved: () => false,
    }
    const domTarget = {
      removeEventListener: vi.fn(),
    }
    const overlay = {
      destroy: vi.fn(),
    }
    const marker = {
      remove: vi.fn(),
    }
    const handler = () => {}

    mgr.setMap(fakeMap)
    mgr.registerEventListener('move', handler)
    mgr.registerEventListener('message', handler, domTarget)
    mgr.setAnimationFrame(42)
    mgr.registerOverlay(overlay)
    mgr.registerMarker(marker)

    expect(mgr.isDisposed()).toBe(false)
    expect(mgr.getActiveResourceCount()).toEqual({
      listeners: 2,
      overlays: 1,
      markers: 1,
      animationFrames: 1,
      hasMap: true,
    })

    mgr.dispose()

    expect(mgr.isDisposed()).toBe(true)
    expect(fakeMap.off).toHaveBeenCalledWith('move', handler)
    expect(domTarget.removeEventListener).toHaveBeenCalledWith('message', handler)
    expect(overlay.destroy).toHaveBeenCalledTimes(1)
    expect(marker.remove).toHaveBeenCalledTimes(1)
    expect(fakeMap.remove).toHaveBeenCalledTimes(1)
    expect(mgr.getActiveResourceCount()).toEqual({
      listeners: 0,
      overlays: 0,
      markers: 0,
      animationFrames: 0,
      hasMap: false,
    })
  })

  it('disposes route resources across navigations in CrossRouteResourceManager', () => {
    const crossMgr = new CrossRouteResourceManager()
    const fakeMap = {
      off: vi.fn(),
      remove: vi.fn(),
      isRemoved: () => false,
    }
    const overlay = { destroy: vi.fn() }

    crossMgr.getMapboxManager().setMap(fakeMap)
    crossMgr.getMapboxManager().registerOverlay(overlay)
    crossMgr.disposeRouteResources()

    const report = crossMgr.getHealthReport()
    expect(report.navigationCount).toBe(1)
    expect(report.mapboxDisposed).toBe(true)
    expect(fakeMap.remove).toHaveBeenCalledTimes(1)
    expect(overlay.destroy).toHaveBeenCalledTimes(1)
  })

  it('cleans up Yjs and WebSocket resources on disposeAll', () => {
    const yjs = new YjsResourceManager()
    const undo = { destroy: vi.fn() }
    const binding = { unobserve: vi.fn() }
    const obs = () => {}
    yjs.registerUndoManager(undo)
    yjs.registerObserver(binding, obs)
    yjs.dispose()
    expect(undo.destroy).toHaveBeenCalledTimes(1)
    expect(binding.unobserve).toHaveBeenCalledWith(obs)
    expect(yjs.isDisposed()).toBe(true)

    const ws = new WebSocketResourceManager()
    ws.dispose()
    expect(ws.isDisposed()).toBe(true)
  })
})

describe('LongTaskMonitor configurable thresholds and bounded telemetry (#961)', () => {
  beforeEach(() => {
    clearLongTaskTelemetryEvents()
  })

  it('uses documented default thresholds (50ms warning, 100ms critical) and allows reconfiguration', () => {
    expect(DEFAULT_LONG_TASK_THRESHOLDS).toEqual({ warningMs: 50, criticalMs: 100 })
    const monitor = new LongTaskMonitor({ warningMs: 40, criticalMs: 80 })
    expect(monitor.getThresholds()).toEqual({ warningMs: 40, criticalMs: 80 })

    monitor.setThresholds({ criticalMs: 90 })
    expect(monitor.getThresholds()).toEqual({ warningMs: 40, criticalMs: 90 })
  })

  it('produces a bounded telemetry event only for tasks above the critical threshold', async () => {
    const exporter = createMemoryExporter()
    const pipeline = new TelemetryPipeline({ exporter })
    const telemetryReceived = []
    const monitor = new LongTaskMonitor(
      { warningMs: 50, criticalMs: 100 },
      {
        route: '/help',
        pipeline,
        maxTelemetryEvents: 3,
        onTelemetry: (e) => telemetryReceived.push(e),
      },
    )

    // Sub-warning task (30ms) and warning task (75ms) do not emit critical telemetry
    monitor.recordCustomTask('quick-render', 30, 100)
    monitor.recordCustomTask('moderate-cluster', 75, 200)
    expect(telemetryReceived).toHaveLength(0)

    // Critical tasks (> 100ms) emit bounded telemetry events
    const veryLongName = 'map-overlay-reprojection-'.repeat(10)
    monitor.recordCustomTask(veryLongName, 145.678, 300)
    monitor.recordCustomTask('tile-decode-1', 120, 500)
    monitor.recordCustomTask('tile-decode-2', 130, 700)
    monitor.recordCustomTask('tile-decode-3', 160, 900)

    // Callback received all 4 critical events, while internal buffer is bounded to maxTelemetryEvents=3
    expect(telemetryReceived).toHaveLength(4)
    expect(telemetryReceived[0].name.length).toBeLessThanOrEqual(MAX_LONGTASK_NAME_LENGTH)
    expect(telemetryReceived[0].durationMs).toBe(145.68)
    expect(telemetryReceived[0].severity).toBe('critical')
    expect(telemetryReceived[0].route).toBe('/help')

    const retained = monitor.getTelemetryEvents()
    expect(retained).toHaveLength(3)
    expect(retained.map((e) => e.name)).toEqual(['tile-decode-1', 'tile-decode-2', 'tile-decode-3'])
    expect(getLongTaskTelemetryEvents().length).toBeLessThanOrEqual(MAX_BOUNDED_TELEMETRY_EVENTS)

    await pipeline.flush()
    expect(exporter.batches).toHaveLength(1)
    expect(exporter.batches[0]).toHaveLength(4)
    expect(exporter.batches[0][0].name).toBe('longtask.breach')
    expect(exporter.batches[0][0].priority).toBe('critical')
  })
})
