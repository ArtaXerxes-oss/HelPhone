import { defineConfig } from '@playwright/test'
import { readFileSync } from 'node:fs'

// Field profile shared with the perf-budget harness (#795) and synthetic/RUM
// divergence (#796). One definition: perf-budget.json.
const perfBudget = JSON.parse(readFileSync(new URL('./perf-budget.json', import.meta.url), 'utf8'))
const FIELD = perfBudget.profile
const PERF_SPECS = [/emergency-flow\.spec\.ts/, /smoke\.spec\.ts/, /perf-budget\.spec\.ts/]

// Multi-resolution layout matrix — one project per device profile so a PR
// check names the exact resolution it broke on. The specs themselves are
// viewport-agnostic; tests/e2e/layout.spec.ts measures whatever viewport
// the project injects. `npm run test:layout` runs every leg,
// `npm run test:layout -- --project=layout-iphone-se` runs one.
const MOBILE_UA = {
  'layout-iphone-se':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
  'layout-iphone-14':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'layout-pixel-7':
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'layout-ipad':
    'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
}

const layoutProject = (name, use) => ({
  name,
  testMatch: /layout\.spec\.ts/,
  use: { browserName: 'chromium', ...use },
})

export default defineConfig({
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled' },
  },
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:vite',
    port: 3000,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    // Throttling runs in its own project: slow-network navigations need a much
    // larger timeout and would make the default suite crawl.
    {
      name: 'chromium',
      testIgnore: [/throttling\.spec\.ts/, /layout\.spec\.ts/, /perf-budget\.spec\.ts/],
      use: { browserName: 'chromium' },
    },
    {
      name: 'throttling',
      testMatch: /throttling\.spec\.ts/,
      timeout: 180_000,
      use: { browserName: 'chromium' },
    },
    // ── Synthetic monitoring: same specs, two profiles ────────────
    // Datacenter = unthrottled baseline; field = Moto G4 + Fast 3G + 4x CPU
    // applied over CDP by tests/e2e/support/fieldProfile.ts. Both report to
    // /api/telemetry/rum with source="synthetic" so deltas are visible.
    {
      name: 'synthetic-datacenter',
      testMatch: PERF_SPECS,
      metadata: { field: false },
      use: { browserName: 'chromium' },
    },
    {
      name: FIELD.name,
      testMatch: PERF_SPECS,
      timeout: 180_000,
      metadata: { field: true },
      use: {
        browserName: 'chromium',
        viewport: FIELD.viewport,
        deviceScaleFactor: FIELD.deviceScaleFactor,
        isMobile: true,
        hasTouch: true,
        userAgent:
          'Mozilla/5.0 (Linux; Android 7.0; Moto G (4)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      },
    },
    // ── Multi-resolution visual layout matrix ─────────────────────
    layoutProject('layout-iphone-se', {
      viewport: { width: 375, height: 667 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: MOBILE_UA['layout-iphone-se'],
    }),
    layoutProject('layout-iphone-14', {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: MOBILE_UA['layout-iphone-14'],
    }),
    layoutProject('layout-pixel-7', {
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
      userAgent: MOBILE_UA['layout-pixel-7'],
    }),
    layoutProject('layout-ipad', {
      viewport: { width: 768, height: 1024 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: MOBILE_UA['layout-ipad'],
    }),
    layoutProject('layout-laptop', {
      viewport: { width: 1366, height: 768 },
      deviceScaleFactor: 1,
    }),
    layoutProject('layout-display-4k', {
      viewport: { width: 2560, height: 1440 },
      deviceScaleFactor: 1,
    }),
  ],
})
