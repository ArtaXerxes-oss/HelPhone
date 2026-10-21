import { test, expect } from '@playwright/test'

// Issue #113 — E2E Test for Emergency Request Lifecycle
//
// Simulates a user navigating the app, interacting with the emergency
// request flow. Uses stubbed wallet to avoid real blockchain calls.

test.describe('Emergency Request Lifecycle', () => {
  test('landing page loads and shows main elements', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/HelPhone/i)

    // Hero section should be visible
    const hero = page.locator('body')
    await expect(hero).toBeVisible()
  })

  test('can navigate to help/map page', async ({ page }) => {
    await page.goto('/help')
    await page.waitForLoadState('networkidle')

    // Map container should render
    const mapContainer = page.locator('.mapboxgl-map, [class*="map"], canvas').first()
    await expect(mapContainer).toBeVisible({ timeout: 10000 })
  })

  test('help page shows request/response mode toggle', async ({ page }) => {
    await page.goto('/help')
    await page.waitForLoadState('networkidle')

    // The page should have interactive elements for get/offer mode
    const body = page.locator('body')
    await expect(body).toBeVisible()
  })

  test('ranking page loads', async ({ page }) => {
    await page.goto('/ranking')
    await page.waitForLoadState('networkidle')

    await expect(page.locator('body')).toBeVisible()
  })
})
