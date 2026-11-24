import { mkdirSync, writeFileSync } from 'node:fs'
import { test, expect, perfBudget } from './support/fieldProfile'

/**
 * @perf client leg of `npm run perf:budget` (#795). Runs under the
 * field-moto-g4 project, records the labelled trace measures the app emits
 * (wasm.init, telemetry.*, worker.flush) plus long tasks, and writes them to
 * artifacts/perf-budget/client-<project>.json for scripts/perf-budget.mjs to
 * fold into the single verdict. Assertions here are coarse guards only; the
 * harness owns the pass/fail decision.
 */
test('@perf help route within field budget', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const longTasks: Array<{ name: string; start: number; duration: number }> = []
    ;(window as unknown as Record<string, unknown>).__perfLongTasks = longTasks
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push({ name: e.name, start: e.startTime, duration: e.duration })
      }).observe({ type: 'longtask', buffered: true })
    } catch {}
  })

  const started = Date.now()
  await page.goto('/help')
  await page.locator('.mapboxgl-map, [class*="map"], canvas').first().waitFor({ state: 'visible', timeout: 120_000 })
  const readyMs = Date.now() - started

  const client = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const measures = performance.getEntriesByType('measure').map((m) => ({ name: m.name, duration: m.duration }))
    const scripts = performance.getEntriesByType('resource')
      .filter((r) => (r as PerformanceResourceTiming).initiatorType === 'script')
      .map((r) => ({ name: r.name.split('/').pop(), duration: r.duration, bytes: (r as PerformanceResourceTiming).encodedBodySize }))
    return {
      domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,
      loadMs: nav ? nav.loadEventEnd : null,
      measures,
      scripts,
      longTasks: (window as unknown as { __perfLongTasks: unknown[] }).__perfLongTasks,
    }
  })

  const out = { project: testInfo.project.name, profile: perfBudget.profile.name, readyMs, ...client }
  mkdirSync('artifacts/perf-budget', { recursive: true })
  writeFileSync(`artifacts/perf-budget/client-${testInfo.project.name}.json`, JSON.stringify(out, null, 2))

  // Coarse guard: anything past 3x the end-to-end budget is broken, not slow.
  expect(readyMs).toBeLessThan(perfBudget.endToEnd.tapToConfirm.p75Ms * 3)
})
