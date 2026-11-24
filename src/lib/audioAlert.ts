import { trackAudioAlert } from './telemetry'

export type AlertPosition = {
  distanceKm?: number
  bearingDegrees?: number
}

/** `blocked` means the browser kept audio suspended (autoplay policy). */
export type AlertOutcome = 'played' | 'blocked'

/** How long to wait for AudioContext.resume() before treating audio as blocked. */
export const RESUME_TIMEOUT_MS = 1_000

/** Played instead of the siren when audio is blocked (best-effort; needs a supporting device). */
export const BLOCKED_VIBRATION_PATTERN = [500, 250, 500]

// Input events the browser accepts as a "user activation" for audio.
const ACTIVATION_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'keydown'] as const

/**
 * Resolves to the promise's value, or `undefined` if it has not settled after
 * `ms`. AudioContext.resume() stays pending forever (it neither resolves nor
 * rejects) when the autoplay policy blocks it, so it cannot be awaited bare.
 */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(undefined) }
    )
  })
}

type AudioContextConstructor = typeof AudioContext

export class EmergencyAudioAlert {
  private context: AudioContext | null = null
  private stats = { played: 0, blocked: 0 }

  constructor(private readonly resumeTimeoutMs: number = RESUME_TIMEOUT_MS) {}

  /** Alerts that sounded vs. were blocked by the autoplay policy (ISP-049). */
  getStats(): { played: number; blocked: number } {
    return { ...this.stats }
  }

  /** True once the audio context is running, i.e. a siren can sound without a gesture. */
  get isUnlocked(): boolean {
    return this.context?.state === 'running'
  }

  private getAudioContext(): AudioContext {
    if (this.context) return this.context

    const Context = window.AudioContext as AudioContextConstructor | undefined
    if (!Context) throw new Error('Web Audio is not supported in this browser.')
    this.context = new Context()
    return this.context
  }

  /**
   * Sound the siren. If the browser keeps audio suspended (no user gesture yet,
   * e.g. a dispatch arriving while the page was never touched) this does not
   * hang: it gives up after `resumeTimeoutMs`, vibrates instead and returns
   * `'blocked'` so the caller can show a visible alert.
   */
  async play(position: AlertPosition = {}): Promise<AlertOutcome> {
    const context = this.getAudioContext()
    if (!(await this.ensureRunning(context))) return this.handleBlocked()

    const distance = Math.max(0, position.distanceKm ?? 0)
    const attenuation = Math.max(0.2, 1 / (1 + distance / 5))
    const bearing = ((position.bearingDegrees ?? 0) % 360 + 360) % 360
    const pan = Math.sin((bearing * Math.PI) / 180)
    const now = context.currentTime
    const gain = context.createGain()
    const panner = context.createStereoPanner()
    panner.pan.setValueAtTime(pan, now)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.linearRampToValueAtTime(0.22 * attenuation, now + 0.08)
    gain.gain.setValueAtTime(0.22 * attenuation, now + 0.52)
    gain.gain.linearRampToValueAtTime(0.0001, now + 0.62)
    panner.connect(gain)
    gain.connect(context.destination)

    const oscillator = context.createOscillator()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(720, now)
    oscillator.frequency.linearRampToValueAtTime(980, now + 0.28)
    oscillator.frequency.linearRampToValueAtTime(720, now + 0.56)
    oscillator.connect(panner)
    oscillator.start(now)
    oscillator.stop(now + 0.64)
    oscillator.onended = () => {
      oscillator.disconnect()
      panner.disconnect()
      gain.disconnect()
    }

    this.stats.played += 1
    trackAudioAlert('played')
    return 'played'
  }

  /** Resume audio from a user gesture. Resolves to whether the context is now running. */
  async unlock(): Promise<boolean> {
    return this.ensureRunning(this.getAudioContext())
  }

  /**
   * Unlock audio on the first user gesture anywhere on the page, so an alert
   * that arrives later with no gesture can still sound. Stays armed until a
   * gesture actually succeeds. Returns a function that disarms it (for effect cleanup).
   */
  armOnFirstGesture(target: Document | HTMLElement = document): () => void {
    const disarm = () => {
      for (const type of ACTIVATION_EVENTS) target.removeEventListener(type, onGesture)
    }
    const onGesture = () => {
      this.unlock().then((running) => { if (running) disarm() }, () => undefined)
    }
    for (const type of ACTIVATION_EVENTS) target.addEventListener(type, onGesture)
    return disarm
  }

  private async ensureRunning(context: AudioContext): Promise<boolean> {
    if (context.state === 'running') return true
    await settleWithin(context.resume(), this.resumeTimeoutMs)
    return context.state === 'running'
  }

  private handleBlocked(): AlertOutcome {
    this.stats.blocked += 1
    let vibrated = false
    try {
      vibrated = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
        ? navigator.vibrate(BLOCKED_VIBRATION_PATTERN)
        : false
    } catch {
      // Vibration is a best-effort fallback only.
    }
    trackAudioAlert('blocked', { fallback: vibrated ? 'vibrate' : 'none' })
    return 'blocked'
  }

  async close(): Promise<void> {
    if (this.context && this.context.state !== 'closed') await this.context.close()
    this.context = null
  }
}

export const emergencyAudioAlert = new EmergencyAudioAlert()
