/**
 * OpenTelemetry integration for error tracking and performance monitoring
 * Issue #746: Link errors to OTel traces for debugging blob-worker failures
 * Issue #754: Track GraphQL subscription transport performance
 */

import { trace, context, SpanStatusCode } from '@opentelemetry/api'

const tracer = trace.getTracer('helphone')

export interface ErrorContext {
  source: string
  component?: string
  traceId?: string
  userId?: string
  [key: string]: unknown
}

/**
 * Record an error with OTel context (Issue #746)
 */
export function recordError(error: Error, ctx: ErrorContext = {}): void {
  const span = tracer.startSpan('error.record')

  try {
    span.recordException(error)
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })

    // Add context attributes
    Object.entries(ctx).forEach(([key, value]) => {
      span.setAttribute(key, String(value))
    })

    // Store trace ID for linking
    const activeSpan = trace.getActiveSpan()
    if (activeSpan) {
      const traceId = activeSpan.spanContext().traceId
      sessionStorage.setItem('otel_trace_id', traceId)
    }
  } finally {
    span.end()
  }
}

/**
 * Link an error to an existing trace (Issue #746)
 */
export function linkError(error: Error, traceId: string): void {
  const span = tracer.startSpan('error.link')

  try {
    span.setAttribute('error.trace_id', traceId)
    span.setAttribute('error.message', error.message)
    span.recordException(error)
  } finally {
    span.end()
  }
}

/**
 * Track GraphQL subscription transport (Issue #754)
 */
export function trackSubscriptionTransport(
  transport: 'ws' | 'http2_push' | 'redis_pubsub',
  operation: string,
  duration: number,
  success: boolean
): void {
  const span = tracer.startSpan('subscription.transport')

  try {
    span.setAttributes({
      'subscription.transport': transport,
      'subscription.operation': operation,
      'subscription.duration_ms': duration,
      'subscription.success': success,
    })

    if (!success) {
      span.setStatus({ code: SpanStatusCode.ERROR })
    }
  } finally {
    span.end()
  }
}

/**
 * Track whether an emergency audio alert was actually audible (ISP-049).
 * `blocked` means the browser's autoplay policy kept the AudioContext
 * suspended, so the siren could not sound; `fallback` records what was done
 * instead. blocked / (played + blocked) is the "audio-blocked rate".
 */
export function trackAudioAlert(
  outcome: 'played' | 'blocked',
  details: { fallback?: 'vibrate' | 'none' } = {}
): void {
  const span = tracer.startSpan('audio.alert')

  try {
    span.setAttributes({
      'audio.outcome': outcome,
      'audio.fallback': details.fallback ?? 'none',
    })

    if (outcome === 'blocked') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'autoplay blocked' })
    }
  } finally {
    span.end()
  }
}

/**
 * Track video performance metrics (Issue #745)
 */
export function trackVideoPerformance(
  metric: 'forward_play' | 'reverse_play' | 'frame_drop' | 'raf_throttle',
  duration: number
): void {
  const span = tracer.startSpan('video.performance')

  try {
    span.setAttributes({
      'video.metric': metric,
      'video.duration_ms': duration,
    })
  } finally {
    span.end()
  }
}

/**
 * Track Soroban state operations (Issue #755)
 */
export function trackSorobanState(
  operation: 'read' | 'write' | 'delete',
  size: number,
  duration: number
): void {
  const span = tracer.startSpan('soroban.state')

  try {
    span.setAttributes({
      'soroban.operation': operation,
      'soroban.state_size_bytes': size,
      'soroban.duration_ms': duration,
    })
  } finally {
    span.end()
  }
}

/**
 * Start a blob-worker operation trace (Issue #746)
 */
export function startBlobWorkerTrace(operationId: string): () => void {
  const span = tracer.startSpan('blob_worker.operation', {
    attributes: {
      'blob_worker.operation_id': operationId,
    },
  })

  // Store operation ID for error linkage
  const operationIds = JSON.parse(sessionStorage.getItem('blob_worker_ops') || '[]')
  operationIds.push({ id: operationId, timestamp: Date.now() })
  // Keep only last 10 operations
  sessionStorage.setItem('blob_worker_ops', JSON.stringify(operationIds.slice(-10)))

  return () => {
    span.end()
  }
}
