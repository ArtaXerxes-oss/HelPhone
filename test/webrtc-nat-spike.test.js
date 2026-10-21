import { describe, expect, it, vi } from 'vitest'
import { benchmarkIceCandidates, candidateMode, shouldUseWebSocketFallback } from '../src/lib/webrtc'
class FakePeer {
  createDataChannel() {}
  async createOffer() { return { type: 'offer', sdp: '' } }
  async setLocalDescription() {
    queueMicrotask(() => this.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 1 203.0.113.1 9 typ relay', protocol: 'udp' } }))
    queueMicrotask(() => this.onicecandidate({ candidate: null }))
  }
  close = vi.fn()
}
describe('WebRTC NAT traversal spike (#579)', () => {
  it('classifies ICE candidate types', () => {
    expect(candidateMode('candidate:1 1 udp 1 10.0.0.1 9 typ host')).toBe('host')
    expect(candidateMode('candidate:2 1 udp 1 203.0.113.1 9 typ relay')).toBe('relay')
  })
  it('records relay success and keeps WebRTC', async () => {
    const result = await benchmarkIceCandidates({ peerFactory: () => new FakePeer(), timeoutMs: 50 })
    expect(result.hasRelay).toBe(true)
    expect(result.recommendedTransport).toBe('webrtc')
  })
  it('falls back when relay is required but unavailable', () => {
    expect(shouldUseWebSocketFallback({ success: true, hasRelay: false }, true)).toBe(true)
  })
})
