/**
 * useNetworkQuality — tracks connection quality and idle time.
 *
 * Used by the kiosk auto-lock: pointer/keyboard events reset the idle timer;
 * when no activity is detected for `warnAfterMs` we emit 'warn', and after
 * `lockAfterMs` we emit 'lock'.
 */
import { useState, useEffect, useRef, useCallback } from 'react'

export type IdleState = 'active' | 'warn' | 'lock'

export interface NetworkQualityState {
  online: boolean
  effectiveType: string | null
  idleState: IdleState
  /** Seconds remaining before the next transition (warn → lock, active → warn) */
  secondsRemaining: number | null
}

export interface UseNetworkQualityOptions {
  /** ms of inactivity before showing the countdown warning (default 90 000) */
  warnAfterMs?: number
  /** ms of inactivity before locking (default 120 000) */
  lockAfterMs?: number
  /** Called when transitioning to 'warn' state */
  onWarn?: () => void
  /** Called when transitioning to 'lock' state */
  onLock?: () => void
  /** Set false to disable idle tracking entirely */
  trackIdle?: boolean
}

const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'touchstart'] as const

export function useNetworkQuality(options: UseNetworkQualityOptions = {}): NetworkQualityState & {
  resetIdle: () => void
} {
  const {
    warnAfterMs = 90_000,
    lockAfterMs = 120_000,
    onWarn,
    onLock,
    trackIdle = true,
  } = options

  const [online, setOnline] = useState(() => navigator.onLine)
  const [effectiveType, setEffectiveType] = useState<string | null>(() => {
    const conn = (navigator as any).connection
    return conn?.effectiveType ?? null
  })
  const [idleState, setIdleState] = useState<IdleState>('active')
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null)

  const lastActivityRef = useRef(Date.now())
  const idleStateRef = useRef<IdleState>('active')
  const onWarnRef = useRef(onWarn)
  const onLockRef = useRef(onLock)
  onWarnRef.current = onWarn
  onLockRef.current = onLock

  const resetIdle = useCallback(() => {
    lastActivityRef.current = Date.now()
    if (idleStateRef.current !== 'active') {
      idleStateRef.current = 'active'
      setIdleState('active')
      setSecondsRemaining(null)
    }
  }, [])

  // Network status
  useEffect(() => {
    const handleOnline = () => setOnline(true)
    const handleOffline = () => setOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    const conn = (navigator as any).connection
    const handleChange = () => setEffectiveType(conn?.effectiveType ?? null)
    conn?.addEventListener('change', handleChange)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      conn?.removeEventListener('change', handleChange)
    }
  }, [])

  // Idle tracking
  useEffect(() => {
    if (!trackIdle) return

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, resetIdle, { passive: true })
    }

    const interval = setInterval(() => {
      const idle = Date.now() - lastActivityRef.current

      if (idle >= lockAfterMs) {
        if (idleStateRef.current !== 'lock') {
          idleStateRef.current = 'lock'
          setIdleState('lock')
          setSecondsRemaining(0)
          onLockRef.current?.()
        }
      } else if (idle >= warnAfterMs) {
        if (idleStateRef.current !== 'warn') {
          idleStateRef.current = 'warn'
          setIdleState('warn')
          onWarnRef.current?.()
        }
        setSecondsRemaining(Math.ceil((lockAfterMs - idle) / 1000))
      } else {
        if (idleStateRef.current !== 'active') {
          idleStateRef.current = 'active'
          setIdleState('active')
          setSecondsRemaining(null)
        }
      }
    }, 1000)

    return () => {
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, resetIdle)
      }
      clearInterval(interval)
    }
  }, [trackIdle, warnAfterMs, lockAfterMs, resetIdle])

  return { online, effectiveType, idleState, secondsRemaining, resetIdle }
}
