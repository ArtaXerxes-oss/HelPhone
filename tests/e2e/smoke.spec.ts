import { test, expect } from '@playwright/test'

test.describe('Smoke test — app loads and routes', () => {
  test('landing page loads with main heading', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('text=HelPhone')).toBeVisible()
  })

  test('can navigate to ranking page', async ({ page }) => {
    await page.goto('/ranking')
    await expect(page.locator('text=Community Responders')).toBeVisible()
  })

  test('ranking page shows period tabs', async ({ page }) => {
    await page.goto('/ranking')
    await expect(page.locator('text=This Week')).toBeVisible()
    await expect(page.locator('text=This Month')).toBeVisible()
    await expect(page.locator('text=All Time')).toBeVisible()
  })

  test('ranking page shows table headers when loaded', async ({ page }) => {
    await page.goto('/ranking')
    await expect(page.locator('text=RESPONDER')).toBeVisible()
    await expect(page.locator('text=ARRIVALS')).toBeVisible()
  })
})
