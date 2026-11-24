import { test, expect } from '@playwright/test'

/**
 * ADR-022 / predictiveEtaV2: forced Mapbox failure must produce a visibly
 * degraded, offline ETA path instead of a single authoritative number.
 */
test.describe('ETA degraded fallback (predictiveEtaV2)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('helphone:feature:predictiveEtaV2', 'true')
    })
    // Simulate a Mapbox outage: fail every map tile/style request.
    await page.route(/api\.mapbox\.com|mapbox:\/\//, (route) => route.abort('failed'))
  })

  test('shows an offline notice when Mapbox fails', async ({ page }) => {
    await page.goto('/help')
    await expect(page.getByTestId('mapbox-failure-notice')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('mapbox-failure-notice')).toContainText('offline ETA')
  })

  test('flag-off keeps the legacy single-number ETA path', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('helphone:feature:predictiveEtaV2')
    })
    await page.goto('/help')
    await expect(page.getByTestId('mapbox-failure-notice')).toHaveCount(0)
    await expect(page.getByTestId('eta-range')).toHaveCount(0)
  })
})
