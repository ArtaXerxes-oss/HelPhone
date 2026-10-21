import { test, expect, type Page } from '@playwright/test'

// ---------------------------------------------------------------------------
// E2E test for the Stellar wallet connection flow (StellarWalletsKit's
// Freighter module -> src/pages/Help.jsx's promptWalletConnection()).
//
// Real browser wallet extensions can't be installed in a Playwright browser
// context, so this mocks Freighter's actual page<->extension protocol
// (window.postMessage), reverse-engineered from
// node_modules/@creit-tech/stellar-wallets-kit/node_modules/@stellar/freighter-api:
//
//   - isConnected() short-circuits to {isConnected: window.freighter} when
//     window.freighter is truthy -- no postMessage round-trip at all.
//   - getAddress()/requestAccess() post
//     {source: "FREIGHTER_EXTERNAL_MSG_REQUEST", messageId, type: "REQUEST_PUBLIC_KEY" | "REQUEST_ACCESS", ...}
//     via window.postMessage(msg, window.location.origin), then wait for a
//     `message` event where event.source === window and
//     event.data.source === "FREIGHTER_EXTERNAL_MSG_RESPONSE" and (note the
//     library's own typo) event.data.messagedId === the request's messageId.
//     The response payload's `publicKey` field becomes the resolved address.
//
// NOTE: this environment's Playwright install doesn't support this sandbox's
// OS ("Playwright does not support chromium on mac13"), so this spec has not
// been executed here. Written directly against the freighter-api source
// above rather than guessed, but should be run and adjusted (particularly
// the wallet-picker modal selector, which depends on StellarWalletsKit's
// shadow-DOM UI and hasn't been visually confirmed) in an environment that
// can actually launch a browser.
// ---------------------------------------------------------------------------

const MOCK_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3'

async function installMockFreighter(page: Page, address = MOCK_ADDRESS) {
  await page.addInitScript((addr) => {
    // Presence flag: freighter-api's isConnected() returns immediately
    // ({isConnected: window.freighter}) without a postMessage round-trip
    // when this is truthy.
    ;(window as any).freighter = true

    window.addEventListener('message', (event: MessageEvent) => {
      const data = event?.data
      if (!data || data.source !== 'FREIGHTER_EXTERNAL_MSG_REQUEST') return
      if (data.type !== 'REQUEST_ACCESS' && data.type !== 'REQUEST_PUBLIC_KEY') return

      // Respond on the next tick so this looks like a real async extension
      // reply rather than a synchronous same-frame echo.
      setTimeout(() => {
        window.postMessage(
          {
            source: 'FREIGHTER_EXTERNAL_MSG_RESPONSE',
            messagedId: data.messageId, // freighter-api's own field name (not a typo on our part)
            publicKey: addr,
          },
          window.location.origin,
        )
      }, 0)
    })
  }, address)
}

test.describe('Wallet connection (mocked Freighter)', () => {
  test('connecting reflects the connected state and shows the public key', async ({ page }) => {
    await installMockFreighter(page)
    await page.goto('/')

    const connectButton = page.getByRole('button', { name: 'Connect Wallet' })
    await expect(connectButton).toBeVisible()
    await connectButton.click()

    // StellarWalletsKit's wallet-picker modal lists installed/available
    // wallets by product name; Freighter is presence-detected via the
    // window.freighter flag set above.
    const freighterOption = page.getByText('Freighter', { exact: false })
    await expect(freighterOption).toBeVisible({ timeout: 10_000 })
    await freighterOption.click()

    // Once connected, the same corner button toggles the profile panel
    // instead of re-opening the wallet picker (see Help.jsx's aria-label
    // switching from "Connect Wallet" to "Open profile").
    const profileButton = page.getByRole('button', { name: 'Open profile' })
    await expect(profileButton).toBeVisible({ timeout: 10_000 })
    await profileButton.click()

    // computeWalletStatus() renders `${address.slice(0, 8)}...${address.slice(-6)}`.
    const expectedDisplay = `${MOCK_ADDRESS.slice(0, 8)}...${MOCK_ADDRESS.slice(-6)}`
    await expect(page.getByText(expectedDisplay)).toBeVisible()
  })

  test('does not show the connected state before connecting', async ({ page }) => {
    await installMockFreighter(page)
    await page.goto('/')

    await expect(page.getByRole('button', { name: 'Connect Wallet' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open profile' })).toHaveCount(0)
  })
})
