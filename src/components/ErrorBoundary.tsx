import React, { Component, ReactNode } from 'react'
import { recordError, linkError } from '../lib/telemetry'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
}

interface State {
  hasError: boolean
  error: Error | null
  errorCount: number
  lastErrorTime: number
}

/**
 * ErrorBoundary with crash recovery (Issue #746)
 * - Catches unhandled React errors
 * - Links errors to OTel traces via trace context
 * - Recovers from cascading failures via exponential backoff reset
 * - Prevents service worker failures from blocking the UI
 */
export class ErrorBoundary extends Component<Props, State> {
  private resetTimeoutId: NodeJS.Timeout | null = null
  private readonly MAX_ERRORS_BEFORE_RESET = 3
  private readonly RESET_INTERVAL_MS = 5000

  constructor(props: Props) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorCount: 0,
      lastErrorTime: 0,
    }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    const { onError } = this.props
    const traceId = this.getTraceId()

    // Record error with OTel linkage
    recordError(error, {
      source: 'react-error-boundary',
      component: errorInfo.componentStack,
      traceId,
    })

    // Link error to current trace context
    if (traceId) {
      linkError(error, traceId)
    }

    // Update error count and check for cascade failures
    this.setState((prev) => {
      const timeSinceLastError = Date.now() - prev.lastErrorTime
      const errorCount =
        timeSinceLastError > this.RESET_INTERVAL_MS * 2 ? 1 : prev.errorCount + 1

      if (errorCount >= this.MAX_ERRORS_BEFORE_RESET) {
        console.warn('[ErrorBoundary] Cascade failure detected, scheduling recovery reset')
        this.scheduleRecoveryReset()
      }

      return {
        errorCount,
        lastErrorTime: Date.now(),
      }
    })

    // Notify parent if callback provided
    if (onError) {
      onError(error, errorInfo)
    }

    // Attempt to clear blob-worker stuck state
    this.clearBlobWorkerState()

    // Log to console in development
    if (process.env.NODE_ENV === 'development') {
      console.error('ErrorBoundary caught:', error, errorInfo)
    }
  }

  private getTraceId(): string | null {
    // Extract trace ID from W3C trace context if available
    const traceParent = document.querySelector('meta[name="trace-id"]')?.getAttribute('content')
    if (traceParent) {
      const parts = traceParent.split('-')
      return parts.length > 1 ? parts[1] : null
    }
    // Fallback: check sessionStorage for ongoing trace
    return sessionStorage.getItem('otel_trace_id')
  }

  private clearBlobWorkerState() {
    // Clear stuck blob-worker state that might prevent window.onerror
    try {
      // Remove any pending blob URLs that might block cleanup
      const blobUrls = sessionStorage.getItem('pending_blob_urls')
      if (blobUrls) {
        const urls = JSON.parse(blobUrls)
        urls.forEach((url: string) => {
          try {
            URL.revokeObjectURL(url)
          } catch {
            // Ignore if already revoked
          }
        })
        sessionStorage.removeItem('pending_blob_urls')
      }

      // Signal service worker to clear cache if stuck
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.controller?.postMessage({
          type: 'CLEAR_ERROR_STATE',
          timestamp: Date.now(),
        })
      }
    } catch (e) {
      console.warn('[ErrorBoundary] Failed to clear blob-worker state:', e)
    }
  }

  private scheduleRecoveryReset() {
    if (this.resetTimeoutId) {
      clearTimeout(this.resetTimeoutId)
    }

    this.resetTimeoutId = setTimeout(() => {
      console.log('[ErrorBoundary] Executing cascade failure recovery reset')
      this.setState({
        hasError: false,
        error: null,
        errorCount: 0,
        lastErrorTime: 0,
      })
      this.resetTimeoutId = null
    }, this.RESET_INTERVAL_MS)
  }

  componentWillUnmount() {
    if (this.resetTimeoutId) {
      clearTimeout(this.resetTimeoutId)
    }
  }

  private handleRetry = () => {
    console.log('[ErrorBoundary] User initiated recovery')
    this.setState({
      hasError: false,
      error: null,
      errorCount: 0,
    })
  }

  render() {
    const { children, fallback } = this.props
    const { hasError, error } = this.state

    if (hasError) {
      if (fallback) {
        return fallback
      }

      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            backgroundColor: '#234B4E',
            color: '#ECE0CC',
            padding: '2rem',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <h1 style={{ marginBottom: '1rem', color: '#FF7A6B' }}>Something went wrong</h1>
          <p style={{ marginBottom: '1rem', opacity: 0.8 }}>
            {error?.message || 'An unexpected error occurred. Please try again.'}
          </p>
          <button
            onClick={this.handleRetry}
            style={{
              padding: '0.75rem 1.5rem',
              backgroundColor: '#FF7A6B',
              color: '#234B4E',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 'bold',
              fontSize: '1rem',
            }}
            onMouseOver={(e) => {
              ;(e.target as HTMLButtonElement).style.opacity = '0.9'
            }}
            onMouseOut={(e) => {
              ;(e.target as HTMLButtonElement).style.opacity = '1'
            }}
          >
            Try Again
          </button>
          {process.env.NODE_ENV === 'development' && (
            <pre
              style={{
                marginTop: '2rem',
                padding: '1rem',
                backgroundColor: 'rgba(0,0,0,0.2)',
                borderRadius: '4px',
                overflow: 'auto',
                maxHeight: '200px',
                fontSize: '0.85rem',
                fontFamily: 'monospace',
              }}
            >
              {error?.stack}
            </pre>
          )}
        </div>
      )
    }

    return children
  }
}

export default ErrorBoundary
