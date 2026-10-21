import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

// ---------------------------------------------------------------------------
// Issue #129 — Automated Accessibility Testing (E2E)
//
// Uses @axe-core/playwright to scan pages for WCAG 2.1 violations during
// E2E testing. Tests fail when critical or serious violations are found.
// ---------------------------------------------------------------------------

test.describe('Accessibility — Landing page', () => {
  test('has no critical or serious WCAG violations', async ({ page }) => {
    await page.goto('/')

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()

    const critical = results.violations.filter(v => v.impact === 'critical')
    const serious = results.violations.filter(v => v.impact === 'serious')

    if (critical.length > 0) {
      console.error('Critical a11y violations:', critical.map(v => `${v.id}: ${v.description}`))
    }
    if (serious.length > 0) {
      console.error('Serious a11y violations:', serious.map(v => `${v.id}: ${v.description}`))
    }

    expect(critical).toHaveLength(0)
    expect(serious).toHaveLength(0)
  })

  test('has no color contrast violations', async ({ page }) => {
    await page.goto('/')

    const results = await new AxeBuilder({ page })
      .include('body')
      .withRules(['color-contrast'])
      .analyze()

    expect(results.violations).toHaveLength(0)
  })

  test('has no missing form labels', async ({ page }) => {
    await page.goto('/')

    const results = await new AxeBuilder({ page })
      .withRules(['label'])
      .analyze()

    expect(results.violations).toHaveLength(0)
  })

  test('has valid landmark regions', async ({ page }) => {
    await page.goto('/')

    const results = await new AxeBuilder({ page })
      .withRules(['landmark-unique', 'region'])
      .analyze()

    expect(results.violations).toHaveLength(0)
  })
})

test.describe('Accessibility — Help page', () => {
  test('has no critical or serious WCAG violations', async ({ page }) => {
    await page.goto('/help')

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()

    const critical = results.violations.filter(v => v.impact === 'critical')
    const serious = results.violations.filter(v => v.impact === 'serious')

    if (critical.length > 0) {
      console.error('Critical a11y violations:', critical.map(v => `${v.id}: ${v.description}`))
    }
    if (serious.length > 0) {
      console.error('Serious a11y violations:', serious.map(v => `${v.id}: ${v.description}`))
    }

    expect(critical).toHaveLength(0)
    expect(serious).toHaveLength(0)
  })

  test('has no missing alt text on images', async ({ page }) => {
    await page.goto('/help')

    const results = await new AxeBuilder({ page })
      .withRules(['image-alt'])
      .analyze()

    expect(results.violations).toHaveLength(0)
  })

  test('has no duplicate IDs', async ({ page }) => {
    await page.goto('/help')

    const results = await new AxeBuilder({ page })
      .withRules(['duplicate-id'])
      .analyze()

    expect(results.violations).toHaveLength(0)
  })

  test('interactive elements are keyboard accessible', async ({ page }) => {
    await page.goto('/help')

    const results = await new AxeBuilder({ page })
      .withRules(['focusable-content', 'tabindex'])
      .analyze()

    expect(results.violations).toHaveLength(0)
  })
})

test.describe('Accessibility — Ranking page', () => {
  test('has no critical or serious WCAG violations', async ({ page }) => {
    await page.goto('/ranking')

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()

    const critical = results.violations.filter(v => v.impact === 'critical')
    const serious = results.violations.filter(v => v.impact === 'serious')

    expect(critical).toHaveLength(0)
    expect(serious).toHaveLength(0)
  })

  test('data tables have proper headers', async ({ page }) => {
    await page.goto('/ranking')

    const results = await new AxeBuilder({ page })
      .withRules(['td-headers-attr', 'th-has-data-cells'])
      .analyze()

    expect(results.violations).toHaveLength(0)
  })
})

test.describe('Accessibility — All pages snapshot', () => {
  const pages = ['/', '/help', '/ranking']

  for (const path of pages) {
    test(`full WCAG scan on ${path}`, async ({ page }) => {
      await page.goto(path)

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()

      // Report all violations for debugging
      for (const violation of results.violations) {
        const help = violation.helpUrl ? ` (${violation.helpUrl})` : ''
        console.warn(
          `[a11y] ${violation.impact}: ${violation.id} — ${violation.description}${help}`,
        )
      }

      // Fail on critical violations only (serious/minor are warnings)
      const critical = results.violations.filter(v => v.impact === 'critical')
      expect(critical).toHaveLength(0)
    })
  }
})

// ---------------------------------------------------------------------------
// Issue #806 — Kiosk mode: scope confinement + auto-lock + focus trap
// ---------------------------------------------------------------------------

test.describe('Kiosk mode — scope confinement', () => {
  test('renders at /kiosk?shelter=BRAVO without 404', async ({ page }) => {
    const res = await page.goto('/kiosk?shelter=BRAVO')
    expect(res?.status()).not.toBe(404)
    await expect(page.locator('[data-kiosk="true"]')).toBeVisible()
  })

  test('kiosk banner shows shelter name', async ({ page }) => {
    await page.goto('/kiosk?shelter=BRAVO')
    await expect(page.getByText(/SHELTER BRAVO/i)).toBeVisible()
  })

  test('Escape does not navigate away from kiosk', async ({ page }) => {
    await page.goto('/kiosk?shelter=BRAVO')
    // Advance to step 2 so Escape has a step to go back to
    await page.getByRole('button', { name: /request help/i }).click()
    await page.keyboard.press('Escape')
    // Should still be in kiosk
    await expect(page).toHaveURL(/\/kiosk/)
    await expect(page.locator('[data-kiosk="true"]')).toBeVisible()
  })

  test('Tab stays trapped inside kiosk container', async ({ page }) => {
    await page.goto('/kiosk?shelter=BRAVO')
    // Tab through many times — focus must never leave [data-kiosk]
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab')
      const activeOutside = await page.evaluate(() => {
        const active = document.activeElement
        const kiosk = document.querySelector('[data-kiosk="true"]')
        return kiosk ? !kiosk.contains(active) : false
      })
      expect(activeOutside).toBe(false)
    }
  })

  test('language switch preserves ?shelter= param', async ({ page }) => {
    await page.goto('/kiosk?shelter=BRAVO')
    await page.getByRole('button', { name: /switch language to arabic/i }).click()
    await expect(page).toHaveURL(/shelter=BRAVO/)
    await expect(page).toHaveURL(/lang=ar/)
  })

  test('has no critical a11y violations on kiosk route', async ({ page }) => {
    await page.goto('/kiosk?shelter=BRAVO')
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze()
    const critical = results.violations.filter((v) => v.impact === 'critical')
    expect(critical).toHaveLength(0)
  })

  test('interactive elements meet 44px minimum touch target', async ({ page }) => {
    await page.goto('/kiosk?shelter=BRAVO')
    const tooSmall = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('[data-kiosk="true"] button:not([aria-hidden="true"])'))
      return buttons
        .map((el) => {
          const r = el.getBoundingClientRect()
          return { text: el.textContent?.trim().slice(0, 30), w: r.width, h: r.height }
        })
        .filter((b) => b.h < 44 || b.w < 44)
    })
    expect(tooSmall).toHaveLength(0)
  })
})

test.describe('Kiosk mode — auto-lock (fake timers)', () => {
  test('lock screen appears after idle timeout', async ({ page }) => {
    await page.goto('/kiosk?shelter=BRAVO')
    // Simulate 120 s of inactivity by fast-forwarding the idle ticker
    await page.evaluate(() => {
      // Override Date.now so the idle hook sees 130 s elapsed
      const start = Date.now()
      let calls = 0
      const orig = Date.now
      ;(Date as any).now = () => {
        calls++
        return calls > 2 ? start + 130_000 : orig()
      }
    })
    // Trigger a tick by moving the pointer slightly
    await page.mouse.move(1, 1)
    // Give the 1-second interval a moment
    await page.waitForTimeout(1200)
    // Lock screen or warning modal should appear
    const lockVisible = await page.locator('[role="dialog"]').isVisible().catch(() => false)
    expect(lockVisible).toBe(true)
  })
})
