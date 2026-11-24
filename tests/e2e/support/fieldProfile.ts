import { test as base, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

/**
 * Field-profile fixture (#795, #796). Applies the perf-budget.json profile
 * (Moto G4 + Fast 3G + 4x CPU) over CDP when the project's `metadata.field`
 * is set, and marks every page as synthetic so RUM ingest labels its samples
 * `source="synthetic"` (see rumDimensions in src/lib/telemetry.ts).
 *
 * Chromium only: Emulation.setCPUThrottlingRate has no Firefox/WebKit
 * equivalent, so field results are Chromium-on-CI approximations of field
 * devices, not measurements of them.
 */
export const perfBudget = JSON.parse(readFileSync(new URL('../../../perf-budget.json', import.meta.url), 'utf8'))

const kbpsToBytesPerSec = (kbps: number) => (kbps * 1024) / 8

export const test = base.extend<{ fieldProfile: void }>({
  fieldProfile: [
    async ({ page, browserName }, use, testInfo) => {
      const field = Boolean(testInfo.project.metadata?.field)
      await page.addInitScript((marker) => {
        ;(window as unknown as Record<string, unknown>).__HELPHONE_SYNTHETIC__ = marker
      }, {
        runId: process.env.SYNTHETIC_RUN_ID ?? `local-${Date.now()}`,
        commitSha: process.env.GITHUB_SHA,
        cohort: process.env.SYNTHETIC_COHORT ?? 'synthetic-pinned',
      })
      if (field && browserName === 'chromium') {
        const { cpuThrottleRate, network } = perfBudget.profile
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Network.enable')
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: network.latencyMs,
          downloadThroughput: kbpsToBytesPerSec(network.downloadKbps),
          uploadThroughput: kbpsToBytesPerSec(network.uploadKbps),
        })
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottleRate })
      }
      await use()
    },
    { auto: true },
  ],
})

export { expect }
