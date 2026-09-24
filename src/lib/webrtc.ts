import type { IceBenchmarkResult, IceCandidateMetric, TraversalMode } from '../types'
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }]
export function candidateMode(candidate: string): TraversalMode {
  return (candidate.match(/ typ (host|srflx|relay)(?: |$)/)?.[1] as TraversalMode) ?? 'unknown'
}
export async function benchmarkIceCandidates({ iceServers = DEFAULT_ICE_SERVERS, timeoutMs = 8_000, peerFactory = (config) => new RTCPeerConnection(config) }: { iceServers?: RTCIceServer[]; timeoutMs?: number; peerFactory?: (config: RTCConfiguration) => RTCPeerConnection } = {}): Promise<IceBenchmarkResult> {
  const startedAt = performance.now()
  const candidates: IceCandidateMetric[] = []
  const peer = peerFactory({ iceServers, iceCandidatePoolSize: 2 })
  peer.createDataChannel('helphone-probe')
  try {
    const complete = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      peer.onicecandidate = ({ candidate }) => {
        if (!candidate) { clearTimeout(timer); resolve(); return }
        candidates.push({ mode: candidateMode(candidate.candidate), gatheredAtMs: Math.round(performance.now() - startedAt), protocol: candidate.protocol ?? 'unknown' })
      }
    })
    await peer.setLocalDescription(await peer.createOffer())
    await complete
  } finally { peer.close() }
  const modes = new Set(candidates.map(({ mode }) => mode))
  return { candidates, gatheringMs: Math.round(performance.now() - startedAt), success: candidates.length > 0, hasRelay: modes.has('relay'), recommendedTransport: modes.has('relay') || modes.has('srflx') ? 'webrtc' : 'websocket' }
}
export function shouldUseWebSocketFallback(result: Pick<IceBenchmarkResult, 'success' | 'hasRelay'>, requireRelay = false): boolean {
  return !result.success || (requireRelay && !result.hasRelay)
}
