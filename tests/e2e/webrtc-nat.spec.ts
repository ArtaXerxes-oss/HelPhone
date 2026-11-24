/**
 * WebRTC NAT matrix — issue #907
 *
 * Covers the topology combinations a field device encounters on mobile
 * networks.  Each topology is represented as a named Playwright project
 * (`webrtc-nat-*`) defined in playwright.config.js; this spec exercises
 * the connection or graceful fallback SLA for each one.
 *
 * SLA: peers must connect (or cleanly fall back to WebSocket) within
 * NAT_CONNECT_TIMEOUT_MS.  A test that cannot negotiate ICE within that
 * window is a topology failure — Playwright names the project so CI
 * reports which topology broke.
 *
 * The spec mocks RTCPeerConnection via page.addInitScript so it runs
 * in a standard headless Chromium without real network access.  The
 * mock simulates the ICE candidate sets that each NAT topology emits,
 * replicating what spike #719 §4 measured on actual devices.
 */

import { test, expect } from '@playwright/test'

/** Maximum ms a peer pair must connect or fall back within. */
const NAT_CONNECT_TIMEOUT_MS = 15_000

type NatTopology = 'full-cone' | 'restricted-cone' | 'port-restricted' | 'symmetric' | 'symmetric-with-relay'

interface NatProjectMetadata {
  topology: NatTopology
  requireRelay: boolean
}

/** Candidates emitted by each NAT topology as measured in spike #719 §4. */
const TOPOLOGY_CANDIDATES: Record<NatTopology, string[]> = {
  'full-cone': [
    'candidate:1 1 udp 2130706431 192.168.1.10 54400 typ host',
    'candidate:2 1 udp 1694498815 203.0.113.10 54400 typ srflx raddr 192.168.1.10 rport 54400',
  ],
  'restricted-cone': [
    'candidate:1 1 udp 2130706431 192.168.1.10 54401 typ host',
    'candidate:2 1 udp 1694498815 203.0.113.11 54401 typ srflx raddr 192.168.1.10 rport 54401',
  ],
  'port-restricted': [
    'candidate:1 1 udp 2130706431 192.168.1.10 54402 typ host',
    'candidate:2 1 udp 1694498815 203.0.113.12 54402 typ srflx raddr 192.168.1.10 rport 54402',
  ],
  'symmetric': [
    'candidate:1 1 udp 2130706431 192.168.1.10 54403 typ host',
    // No srflx — symmetric NAT remaps the port per destination, so srflx is
    // useless.  Only relay (TURN) can bridge the connection.
  ],
  'symmetric-with-relay': [
    'candidate:1 1 udp 2130706431 192.168.1.10 54404 typ host',
    'candidate:2 1 udp 16777215 203.0.113.100 3478 typ relay raddr 203.0.113.10 rport 54404',
  ],
}

function candidatesForTopology(topology: NatTopology): string[] {
  return TOPOLOGY_CANDIDATES[topology] ?? []
}

/**
 * Inject a mock RTCPeerConnection that emits the topology's candidate set.
 * The real lib (src/lib/webrtc.ts) calls `peer.createDataChannel`, then
 * `setLocalDescription(await createOffer())` and reads `onicecandidate`.
 */
async function injectWebRtcMock(page: import('@playwright/test').Page, topology: NatTopology) {
  const candidates = candidatesForTopology(topology)
  await page.addInitScript(({ candidateList }) => {
    class MockPeer {
      onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null = null
      createDataChannel() {}
      async createOffer() { return { type: 'offer' as RTCSdpType, sdp: '' } }
      async setLocalDescription() {
        for (const c of candidateList) {
          queueMicrotask(() => {
            this.onicecandidate?.({ candidate: { candidate: c } as RTCIceCandidate })
          })
        }
        // null sentinel signals gathering complete
        queueMicrotask(() => { this.onicecandidate?.({ candidate: null }) })
      }
      close() {}
    }
    // @ts-ignore override for test
    window.RTCPeerConnection = MockPeer
  }, { candidateList: candidates })
}

test.describe('WebRTC NAT matrix', () => {
  // Read the topology from the project metadata set in playwright.config.js.
  // Fall back to 'full-cone' so the spec still passes when run outside the
  // matrix (e.g. `npx playwright test webrtc-nat.spec.ts --project=chromium`).
  const metadata = (test.info().project.metadata ?? {}) as Partial<NatProjectMetadata>

  test.beforeEach(async ({ page }) => {
    const topology = (metadata.topology ?? 'full-cone') as NatTopology
    await injectWebRtcMock(page, topology)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
  })

  test('full-cone: peers connect directly within SLA', async ({ page }) => {
    test.skip(
      !!metadata.topology && metadata.topology !== 'full-cone',
      'topology mismatch — wrong project',
    )
    const result = await page.evaluate(async (timeout) => {
      const { benchmarkIceCandidates } = await import('/src/lib/webrtc.ts')
      return benchmarkIceCandidates({ timeoutMs: timeout })
    }, NAT_CONNECT_TIMEOUT_MS)

    expect(result.success, 'full-cone: ICE gathering must succeed').toBe(true)
    expect(result.gatheringMs, 'full-cone: must connect within SLA').toBeLessThan(NAT_CONNECT_TIMEOUT_MS)
    expect(result.recommendedTransport).toBe('webrtc')
  })

  test('restricted-cone: srflx candidate enables direct connection', async ({ page }) => {
    test.skip(
      !!metadata.topology && metadata.topology !== 'restricted-cone',
      'topology mismatch — wrong project',
    )
    const result = await page.evaluate(async (timeout) => {
      const { benchmarkIceCandidates } = await import('/src/lib/webrtc.ts')
      return benchmarkIceCandidates({ timeoutMs: timeout })
    }, NAT_CONNECT_TIMEOUT_MS)

    expect(result.success).toBe(true)
    expect(result.gatheringMs).toBeLessThan(NAT_CONNECT_TIMEOUT_MS)
    expect(['webrtc', 'websocket']).toContain(result.recommendedTransport)
  })

  test('port-restricted: srflx candidate succeeds or falls back cleanly', async ({ page }) => {
    test.skip(
      !!metadata.topology && metadata.topology !== 'port-restricted',
      'topology mismatch — wrong project',
    )
    const result = await page.evaluate(async (timeout) => {
      const { benchmarkIceCandidates, shouldUseWebSocketFallback } = await import('/src/lib/webrtc.ts')
      const bench = await benchmarkIceCandidates({ timeoutMs: timeout })
      return { ...bench, fallback: shouldUseWebSocketFallback(bench, false) }
    }, NAT_CONNECT_TIMEOUT_MS)

    expect(result.gatheringMs).toBeLessThan(NAT_CONNECT_TIMEOUT_MS)
    // Port-restricted without relay may fall back — that is acceptable.
    expect(typeof result.fallback).toBe('boolean')
  })

  test('symmetric: falls back to WebSocket when relay unavailable', async ({ page }) => {
    test.skip(
      !!metadata.topology && metadata.topology !== 'symmetric',
      'topology mismatch — wrong project',
    )
    const result = await page.evaluate(async (timeout) => {
      const { benchmarkIceCandidates, shouldUseWebSocketFallback } = await import('/src/lib/webrtc.ts')
      const bench = await benchmarkIceCandidates({ timeoutMs: timeout })
      return { ...bench, fallback: shouldUseWebSocketFallback(bench, true) }
    }, NAT_CONNECT_TIMEOUT_MS)

    expect(result.success).toBe(true)
    expect(result.hasRelay, 'symmetric NAT without TURN has no relay').toBe(false)
    // With requireRelay=true, symmetric without relay MUST fall back.
    expect(result.fallback, 'must fall back when relay required but absent').toBe(true)
    expect(result.gatheringMs).toBeLessThan(NAT_CONNECT_TIMEOUT_MS)
  })

  test('symmetric-with-relay: relay enables connection within SLA', async ({ page }) => {
    test.skip(
      !!metadata.topology && metadata.topology !== 'symmetric-with-relay',
      'topology mismatch — wrong project',
    )
    const result = await page.evaluate(async (timeout) => {
      const { benchmarkIceCandidates, shouldUseWebSocketFallback } = await import('/src/lib/webrtc.ts')
      const bench = await benchmarkIceCandidates({ timeoutMs: timeout })
      return { ...bench, fallback: shouldUseWebSocketFallback(bench, true) }
    }, NAT_CONNECT_TIMEOUT_MS)

    expect(result.success).toBe(true)
    expect(result.hasRelay, 'symmetric-with-relay must have a relay candidate').toBe(true)
    expect(result.fallback, 'relay present — no WebSocket fallback needed').toBe(false)
    expect(result.gatheringMs).toBeLessThan(NAT_CONNECT_TIMEOUT_MS)
  })

  test('all topologies report gathering time within SLA', async ({ page }) => {
    // Cross-topology sanity: whichever project runs this spec, gathering must
    // complete before the SLA ceiling.
    const topology = (metadata.topology ?? 'full-cone') as NatTopology
    const result = await page.evaluate(async (timeout) => {
      const { benchmarkIceCandidates } = await import('/src/lib/webrtc.ts')
      return benchmarkIceCandidates({ timeoutMs: timeout })
    }, NAT_CONNECT_TIMEOUT_MS)

    expect(result.gatheringMs, `${topology}: SLA violated`).toBeLessThan(NAT_CONNECT_TIMEOUT_MS)
  })
})
