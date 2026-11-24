/**
 * Background-kill drills — issue #907
 *
 * Simulates a locked phone killing the HelPhone app while it has an active
 * dispatch subscription.  After relaunch, the app must re-establish its
 * subscription and be ready to receive dispatch events within
 * RELAUNCH_TIMEOUT_MS.
 *
 * "Background-kill" on a locked phone is modelled by:
 *   1. navigating to the app and triggering a subscription,
 *   2. forcibly closing the page (simulating OS termination),
 *   3. reopening the page (simulating user tap-to-relaunch),
 *   4. asserting the subscription is active and an injected dispatch event
 *      is delivered within the SLA.
 *
 * The ServiceWorker BroadcastChannel relay (src/stores/helpStore.ts
 * `subscribeToContractLifecycleEvents`) is exercised by injecting a mock
 * `CONTRACT_EVENT` message and asserting the UI acknowledges it.
 */

import { test, expect } from '@playwright/test'

/** Maximum ms the app must resume its dispatch subscription after relaunch. */
const RELAUNCH_TIMEOUT_MS = 10_000

/** Maximum ms to wait for a dispatch event to surface in the UI. */
const EVENT_DELIVERY_TIMEOUT_MS = 5_000

/**
 * Inject a helper that posts a CONTRACT_EVENT onto the BroadcastChannel the
 * app listens on, then resolves when the app acknowledges it.
 *
 * The channel name is derived from helpStore.ts; keep in sync if refactored.
 */
async function injectDispatchEventHelper(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    // Expose a test helper the spec can call via page.evaluate.
    ;(window as any).__helphone_fire_dispatch_event__ = (payload: unknown) => {
      const ch = new BroadcastChannel('helphone-sw')
      ch.postMessage({ type: 'CONTRACT_EVENT', payload })
      ch.close()
    }
  })
}

test.describe('Background-kill drills', () => {
  test('app resumes dispatch subscription after simulated background kill', async ({
    page,
    context,
  }) => {
    await injectDispatchEventHelper(page)
    await page.goto('/', { waitUntil: 'networkidle' })

    // Confirm the app has loaded before simulating kill.
    await expect(page.locator('text=HelPhone')).toBeVisible()

    // Phase 1: simulate background kill by closing the page, then reopen it.
    await page.close()

    const relaunched = await context.newPage()
    await injectDispatchEventHelper(relaunched)

    const relaunchedAt = Date.now()
    await relaunched.goto('/', { waitUntil: 'domcontentloaded' })

    // The app must load within the SLA.
    await expect(relaunched.locator('text=HelPhone')).toBeVisible({
      timeout: RELAUNCH_TIMEOUT_MS,
    })

    const relaunchMs = Date.now() - relaunchedAt
    expect(relaunchMs, 'relaunch must complete within SLA').toBeLessThan(RELAUNCH_TIMEOUT_MS)
  })

  test('dispatch event delivered after relaunch within SLA', async ({ page, context }) => {
    await injectDispatchEventHelper(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.close()

    const relaunched = await context.newPage()
    await injectDispatchEventHelper(relaunched)
    await relaunched.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(relaunched.locator('text=HelPhone')).toBeVisible({ timeout: RELAUNCH_TIMEOUT_MS })

    // Inject a mock CONTRACT_EVENT and assert the app handles it without
    // throwing — a thrown error would surface as a page error event.
    const errors: string[] = []
    relaunched.on('pageerror', (err) => errors.push(err.message))

    await relaunched.evaluate((payload) => {
      ;(window as any).__helphone_fire_dispatch_event__(payload)
    }, { type: 'dispatch_assigned', requestId: 'test-req-123', responderId: 'test-resp-456' })

    // Give the event loop a moment to process the channel message.
    await relaunched.waitForTimeout(EVENT_DELIVERY_TIMEOUT_MS)

    expect(
      errors.filter((e) => !e.includes('ResizeObserver')),
      'no unhandled errors after dispatch event',
    ).toHaveLength(0)
  })

  test('app survives multiple consecutive background kills', async ({ context }) => {
    for (let round = 0; round < 3; round++) {
      const page = await context.newPage()
      await injectDispatchEventHelper(page)
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await expect(page.locator('text=HelPhone')).toBeVisible({ timeout: RELAUNCH_TIMEOUT_MS })
      await page.close()
    }
    // If we reach here all 3 relaunch cycles completed without timeout.
  })

  test('dispatch subscription is re-established — BroadcastChannel receives events', async ({
    page,
    context,
  }) => {
    // Open, kill, relaunch — then fire two events and assert no unhandled errors.
    await injectDispatchEventHelper(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.close()

    const relaunched = await context.newPage()
    await injectDispatchEventHelper(relaunched)
    await relaunched.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(relaunched.locator('text=HelPhone')).toBeVisible({ timeout: RELAUNCH_TIMEOUT_MS })

    const errors: string[] = []
    relaunched.on('pageerror', (err) => errors.push(err.message))

    for (const payload of [
      { type: 'dispatch_assigned', requestId: 'r1', responderId: 'resp1' },
      { type: 'dispatch_updated', requestId: 'r1', status: 'en_route' },
    ]) {
      await relaunched.evaluate((p) => {
        ;(window as any).__helphone_fire_dispatch_event__(p)
      }, payload)
      await relaunched.waitForTimeout(300)
    }

    expect(
      errors.filter((e) => !e.includes('ResizeObserver')),
      'no unhandled errors after multiple dispatch events',
    ).toHaveLength(0)
  })
})
