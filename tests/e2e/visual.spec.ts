import { test, expect } from '@playwright/test'

// Issue #114 — Visual Regression Testing
//
// Takes baseline screenshots of key pages. Dynamic content (maps, live
// data) is masked or waited on to reduce flaky diffs.

test.describe('Visual Regression', () => {
  test('landing page screenshot', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Mask video element to avoid flicker between frames
    await page.evaluate(() => {
      const video = document.querySelector('video')
      if (video) {
        video.pause()
        ;(video as HTMLVideoElement).currentTime = 0
      }
    })

    await expect(page).toHaveScreenshot('landing-page.png', {
      fullPage: true,
      mask: [page.locator('video')],
      maxDiffPixelRatio: 0.05,
    })
  })

  test('help page screenshot', async ({ page }) => {
    await page.goto('/help')
    await page.waitForLoadState('networkidle')

    // Wait for map to potentially render
    await page.waitForTimeout(2000)

    await expect(page).toHaveScreenshot('help-page.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    })
  })

  test('ranking page screenshot', async ({ page }) => {
    await page.goto('/ranking')
    await page.waitForLoadState('networkidle')

    await expect(page).toHaveScreenshot('ranking-page.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    })
  })
})
