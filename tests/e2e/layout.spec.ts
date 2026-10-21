import { expect, test, type Page } from '@playwright/test'

// Multi-resolution visual layout matrix
//
// The same layout gates run once per device profile defined in
// playwright.config.js (projects `layout-*`): iPhone SE, iPhone 14,
// Pixel 7, iPad, Laptop and a 4K display. Every leg asserts:
//
//   1. the document never scrolls horizontally — the failure a phone user
//      sees when an over-wide element cannot be panned back into view,
//   2. no visible element is clipped by the right edge of the viewport
//      (catches fixed bars that would otherwise silently hide content),
//   3. the page landmarks (nav, primary heading) stay inside the viewport,
//   4. a viewport screenshot for visual regression.
//
// Run the whole matrix with `npm run test:layout`, or a single resolution
// with `npx playwright test --project=layout-iphone-se`.

interface Route {
  name: string
  path: string
  /** Text that only appears once the route finished rendering. */
  readyText: string
  /** Selector of the element that must be on screen before we measure. */
  landmark: string
  /**
   * CSS injected before the screenshot. Surfaces whose pixels cannot be
   * replayed byte-for-byte (the Mapbox canvas, live RPC latency) are frozen
   * to a flat colour so the shot only records layout, not fresh data.
   */
  freezeCss?: string
}

const HELP_FREEZE_CSS = `
  #helphone-help-map { background: #101b16 !important; }
  #helphone-help-map * { visibility: hidden !important; }
  [data-testid="network-status"] { visibility: hidden !important; }
`

const ROUTES: Route[] = [
  { name: 'home', path: '/', readyText: 'Community Emergency Response Web App', landmark: 'nav' },
  {
    name: 'help',
    path: '/help',
    readyText: 'Get Help',
    landmark: '#helphone-help-wrap',
    freezeCss: HELP_FREEZE_CSS,
  },
  { name: 'ranking', path: '/ranking', readyText: 'Community Responders', landmark: 'h1' },
]

interface OverflowReport {
  /** `scrollWidth` vs. `innerWidth` of the document. */
  document: { scrollWidth: number; innerWidth: number }
  /** Visible elements whose right edge leaves the viewport. */
  offenders: Array<{ selector: string; right: number; width: number; text: string }>
}

async function measureOverflow(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    const describe = (el: Element): string => {
      const id = el.id ? `#${el.id}` : ''
      const cls =
        typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
          : ''
      return `${el.tagName.toLowerCase()}${id}${cls}`
    }

    const viewportWidth = document.documentElement.clientWidth
    const offenders: Array<{ selector: string; right: number; width: number; text: string }> = []

    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      if (rect.right <= viewportWidth + 1) continue

      const style = window.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue

      // Content parked off-canvas (closed drawers, translated sheets) cannot
      // contribute to horizontal scrolling while it sits below the fold.
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue

      offenders.push({
        selector: describe(el),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      })
    }

    return {
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      },
      offenders: offenders.slice(0, 10),
    }
  })
}

for (const route of ROUTES) {
  test.describe(`${route.name} layout`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
    })

    test(`renders without horizontal scrolling or clipping — ${route.path}`, async ({ page }) => {
      const project = test.info().project
      const viewport = page.viewportSize()
      const isMobile = Boolean(project.use.isMobile)
      test.info().annotations.push({
        type: 'viewport',
        description: `${project.name}: ${viewport?.width}x${viewport?.height}${isMobile ? ' (mobile)' : ''}`,
      })

      await page.goto(route.path, { waitUntil: 'domcontentloaded' })
      await page.getByText(route.readyText, { exact: false }).first().waitFor({ timeout: 30_000 })
      await page.waitForLoadState('networkidle').catch(() => {})
      await page.waitForTimeout(1000)

      // Pause any media so a playing frame cannot flicker under the shot.
      await page.evaluate(() => {
        document.querySelectorAll('video').forEach((video) => video.pause())
      })

      const report = await measureOverflow(page)

      const scrollOverflow = report.document.scrollWidth - report.document.innerWidth
      expect(
        scrollOverflow,
        `[${project.name}] ${route.path} scrolls horizontally by ${scrollOverflow}px at ` +
          `${viewport?.width}px (scrollWidth=${report.document.scrollWidth}, ` +
          `innerWidth=${report.document.innerWidth}; offenders: ` +
          `${report.offenders.map((o) => o.selector).join(', ') || 'none captured'})`,
      ).toBeLessThanOrEqual(1)

      expect(
        report.offenders,
        `[${project.name}] elements clipped by the right edge of ${viewport?.width}px viewport on ${route.path}`,
      ).toEqual([])

      const landmark = page.locator(route.landmark).first()
      await expect(landmark, `${route.path} must render its ${route.landmark} landmark`).toBeVisible()

      const landmarkBox = await landmark.boundingBox()
      expect(landmarkBox, `${route.path} landmark ${route.landmark} has no layout box`).not.toBeNull()
      if (landmarkBox) {
        expect(
          landmarkBox.x + landmarkBox.width,
          `${route.path} landmark ${route.landmark} must stay inside the viewport`,
        ).toBeLessThanOrEqual((viewport?.width ?? 0) + 1)
      }

      // Primary heading — asserted whenever the route ships an h1 (the /help
      // workspace is a tool surface whose title lives in the sidebar).
      const headings = page.getByRole('heading', { level: 1 })
      if ((await headings.count()) > 0) {
        const headingBox = await headings.first().boundingBox()
        expect(headingBox, `${route.path} primary heading has no layout box`).not.toBeNull()
        if (headingBox) {
          expect(
            headingBox.x + headingBox.width,
            `${route.path} primary heading must stay inside the viewport`,
          ).toBeLessThanOrEqual((viewport?.width ?? 0) + 1)
        }
      }
    })

    test(`screenshot matches — ${route.path}`, async ({ page }) => {
      await page.goto(route.path, { waitUntil: 'domcontentloaded' })
      await page.getByText(route.readyText, { exact: false }).first().waitFor({ timeout: 30_000 })
      await page.waitForLoadState('networkidle').catch(() => {})
      await page.waitForTimeout(1000)

      await page.evaluate(() => {
        document.querySelectorAll('video').forEach((video) => video.pause())
        document.documentElement.dataset.layoutSnapshot = 'true'
      })

      if (route.freezeCss) {
        await page.addStyleTag({ content: route.freezeCss })
        // Give the injected style one frame to repaint before capturing.
        await page.waitForTimeout(150)
      }

      await expect(page).toHaveScreenshot(`layout-${route.name}.png`, {
        animations: 'disabled',
        caret: 'hide',
        // Video frames are the only pixel source that cannot be replayed.
        mask: [page.locator('video')],
        maxDiffPixelRatio: 0.05,
      })
    })
  })
}
