import { useEffect, useState } from 'react'
import { benchmarkIceCandidates, shouldUseWebSocketFallback } from '../../lib/webrtc'
import type { RealtimeTransport } from '../../types'
export function ResponderTracker({ requireRelay = false }: { requireRelay?: boolean }) {
  const [transport, setTransport] = useState<RealtimeTransport>('probing')
  useEffect(() => {
    let active = true
    benchmarkIceCandidates().then((result) => {
      if (active) setTransport(shouldUseWebSocketFallback(result, requireRelay) ? 'websocket' : 'webrtc')
    }).catch(() => active && setTransport('websocket'))
    return () => { active = false }
  }, [requireRelay])
  return <output aria-live="polite" data-transport={transport}>Responder link: {transport}</output>
}
