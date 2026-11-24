/**
 * Client telemetry transport (ADR-014 follow-up 2).
 *
 * High-rate live positions arrive as binary FlatBuffers frames over the
 * WebSocket fallback endpoint. `binaryType` is set to `'arraybuffer'` before
 * the socket opens so the reader never has to async-convert a Blob. Low-rate
 * APIs (ICE config/metrics, request details, popups) stay JSON.
 */

import { verifyFrame } from './telemetryFrame.js'
import type { Frame } from '../schemas/telemetry_generated.js'

export interface TelemetryConfig {
  transport: string
  endpoint: string
  binaryType: 'arraybuffer'
  fileIdentifier: string
  maxObjectsPerFrame: number
  maxFrameBytes: number
  maxFramesPerSecond: number
  maxClients: number
}

export interface TelemetryClientOptions {
  url: string
  onFrame?: (frame: Frame) => void
  onJson?: (message: unknown) => void
  onDropped?: (reason: string) => void
  onError?: (error: unknown) => void
  /** Injected for tests; defaults to the global WebSocket constructor. */
  WebSocketImpl?: typeof WebSocket
}

export interface TelemetryClient {
  close: () => void
  readonly socket: WebSocket | null
}

/** Default fallback endpoint advertised by `/api/events/ice-config`. */
export const DEFAULT_FRAME_STREAM = '/api/events/frame-stream'

/**
 * Open the binary frame stream. Malformed frames are reported via `onDropped`
 * and skipped — they never reach `onFrame` or throw on the main path.
 */
export function createTelemetryClient(options: TelemetryClientOptions): TelemetryClient {
  const Impl = options.WebSocketImpl ?? (typeof WebSocket !== 'undefined' ? WebSocket : null)
  if (!Impl) return { close: () => {}, socket: null }

  const socket = new Impl(options.url)
  socket.binaryType = 'arraybuffer'

  socket.onmessage = (event: MessageEvent) => {
    const data = event.data
    if (data instanceof ArrayBuffer) {
      const result = verifyFrame(new Uint8Array(data))
      if (!result.ok) {
        options.onDropped?.(result.error ?? 'malformed frame')
        return
      }
      options.onFrame?.(result.frame as Frame)
      return
    }
    if (ArrayBuffer.isView(data)) {
      const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      const result = verifyFrame(view)
      if (!result.ok) options.onDropped?.(result.error ?? 'malformed frame')
      else options.onFrame?.(result.frame as Frame)
      return
    }
    // Text frames are low-rate JSON control messages, not telemetry.
    try {
      options.onJson?.(JSON.parse(String(data)))
    } catch {
      options.onDropped?.('unparseable JSON control message')
    }
  }
  socket.onerror = (error) => options.onError?.(error)

  return { socket, close: () => socket.close() }
}

/** Fetch the JSON discovery/config document (low-rate API stays JSON). */
export async function fetchTelemetryConfig(baseUrl = ''): Promise<TelemetryConfig> {
  const response = await fetch(`${baseUrl}/api/events/frames/config`, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`telemetry config failed: ${response.status}`)
  return (await response.json()) as TelemetryConfig
}

/** HTTP ingest fallback for clients without WebSocket support. */
export async function postTelemetryFrame(frame: Uint8Array, baseUrl = ''): Promise<boolean> {
  const response = await fetch(`${baseUrl}/api/events/frames`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: frame,
  })
  return response.status === 202
}
