import { expect, test } from '@playwright/test'
import { estimateEta } from '../../src/lib/etaEstimate'
import { hasExif, stripExifFromBuffer } from '../../src/lib/imageProcessor.js'
import { createStagingRegistry, shortCodeFor } from '../../src/lib/nfc/stagingTag.js'
import { createReassembler, fragmentMessage, MSG } from '../../src/lib/radio/protocol.js'

test('no request can be submitted before its location proof prerequisites', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('hp_tour_done', '1'))
  await page.goto('/help')

  await expect(page.getByRole('button', { name: 'Connect wallet first' })).toBeDisabled()
  await expect(page.getByText('ZK PRIVACY CHECKPOINT')).toBeVisible()
  await expect(page.getByTestId('zk-checkpoint-status')).toHaveText('ready')
})

test('degraded ETA is explicitly labelled as an offline estimate', () => {
  const eta = estimateEta({ distanceKm: 12, source: 'fallback', closurePenalty: 1.5 })
  expect(eta.degraded).toBe(true)
  expect(eta.confidence).toBe('low')
  expect(eta.label).toContain('(estimate, offline)')
})

test('checkpoint panel exposes pending and finalized states', async ({ page }) => {
  await page.goto('/help')
  const status = page.getByTestId('zk-checkpoint-status')

  await expect(status).toHaveAttribute('data-pending', 'false')
  await expect(status).toHaveAttribute('data-finalized', 'false')
})

test('QR transfer codes resolve to the original staging area', () => {
  const registry = createStagingRegistry()
  const code = shortCodeFor('STAGING-ALPHA')
  registry.register('STAGING-ALPHA', code)
  expect(registry.resolve(code.toLowerCase())).toBe('STAGING-ALPHA')
})

test('photo processing removes EXIF metadata', () => {
  const jpeg = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe1, 0x00, 0x0c,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a,
    0xff, 0xd9,
  ])
  expect(hasExif(jpeg)).toBe(true)
  expect(hasExif(stripExifFromBuffer(jpeg))).toBe(false)
})

test('repeated hardware SOS frames are deduplicated', () => {
  const { frames } = fragmentMessage({
    type: MSG.SOS,
    msgId: 42,
    payloadBytes: 'SOS',
    maxFrame: 14,
  })
  const receiver = createReassembler()

  expect(receiver.push(frames[0])).toMatchObject({ partial: true })
  expect(receiver.push(frames[0])).toMatchObject({ duplicate: true, msgId: 42 })
})
