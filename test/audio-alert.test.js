import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trackAudioAlert = vi.fn()
vi.mock('../src/lib/telemetry.ts', () => ({ trackAudioAlert: (...a) => trackAudioAlert(...a) }))

import {
  BLOCKED_VIBRATION_PATTERN,
  EmergencyAudioAlert,
  RESUME_TIMEOUT_MS,
} from '../src/lib/audioAlert.ts'

function makeAudioContext() {
  const param = { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }
  const node = { connect: vi.fn(), disconnect: vi.fn(), pan: param, gain: param, frequency: param,
    start: vi.fn(), stop: vi.fn(), type: '', onended: null }
  return {
    state: 'running', currentTime: 10, destination: {},
    createGain: vi.fn(() => ({ ...node })),
    createStereoPanner: vi.fn(() => ({ ...node })),
    createOscillator: vi.fn(() => ({ ...node })),
    resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
  }
}

// vitest 4 mocks must be `function`s to be callable with `new`; an arrow
// function (as this file used before) throws "is not a constructor".
function installable(context) {
  return vi.fn(function AudioContext() { return context })
}

describe('EmergencyAudioAlert', () => {
  const previousAudioContext = window.AudioContext
  afterEach(() => {
    window.AudioContext = previousAudioContext
    vi.restoreAllMocks()
  })

  it('synthesizes an alert and pans according to bearing', async () => {
    const context = makeAudioContext()
    window.AudioContext = installable(context)
    const alert = new EmergencyAudioAlert()

    await alert.play({ distanceKm: 5, bearingDegrees: 90 })

    expect(context.createOscillator).toHaveBeenCalledOnce()
    const panner = context.createStereoPanner.mock.results[0].value
    expect(panner.pan.setValueAtTime).toHaveBeenCalledWith(1, 10)
  })

  it('resumes a suspended context from the user gesture path', async () => {
    const context = makeAudioContext()
    context.state = 'suspended'
    context.resume = vi.fn(async () => { context.state = 'running' })
    window.AudioContext = installable(context)
    const alert = new EmergencyAudioAlert()

    await expect(alert.unlock()).resolves.toBe(true)

    expect(context.resume).toHaveBeenCalledOnce()
    expect(alert.isUnlocked).toBe(true)
  })
})

describe('EmergencyAudioAlert autoplay-blocked handling (ISP-049)', () => {
  const previousAudioContext = window.AudioContext
  const previousVibrate = navigator.vibrate
  let context

  beforeEach(() => {
    vi.useFakeTimers()
    trackAudioAlert.mockReset()
    context = makeAudioContext()
    context.state = 'suspended'
    window.AudioContext = installable(context)
    navigator.vibrate = vi.fn(() => true)
  })

  afterEach(() => {
    vi.useRealTimers()
    window.AudioContext = previousAudioContext
    navigator.vibrate = previousVibrate
  })

  it('does not hang when resume() never settles: gives up, vibrates and reports blocked', async () => {
    context.resume = vi.fn(() => new Promise(() => {})) // what Chromium does with no gesture
    const alert = new EmergencyAudioAlert()

    const pending = alert.play()
    await vi.advanceTimersByTimeAsync(RESUME_TIMEOUT_MS)

    await expect(pending).resolves.toBe('blocked')
    expect(context.createOscillator).not.toHaveBeenCalled()
    expect(navigator.vibrate).toHaveBeenCalledWith(BLOCKED_VIBRATION_PATTERN)
    expect(alert.getStats()).toEqual({ played: 0, blocked: 1 })
    expect(trackAudioAlert).toHaveBeenCalledWith('blocked', { fallback: 'vibrate' })
  })

  it('reports blocked when resume() settles but the context stays suspended', async () => {
    context.resume = vi.fn(async () => {})
    const alert = new EmergencyAudioAlert()

    await expect(alert.play()).resolves.toBe('blocked')
    expect(trackAudioAlert).toHaveBeenCalledWith('blocked', { fallback: 'vibrate' })
  })

  it('reports blocked when resume() rejects', async () => {
    context.resume = vi.fn(async () => { throw new Error('NotAllowedError') })
    const alert = new EmergencyAudioAlert()

    await expect(alert.play()).resolves.toBe('blocked')
  })

  it('records fallback "none" on devices without vibration', async () => {
    context.resume = vi.fn(async () => {})
    navigator.vibrate = undefined
    const alert = new EmergencyAudioAlert()

    await alert.play()

    expect(trackAudioAlert).toHaveBeenCalledWith('blocked', { fallback: 'none' })
  })

  it('plays normally, without vibrating, when resume() succeeds', async () => {
    context.resume = vi.fn(async () => { context.state = 'running' })
    const alert = new EmergencyAudioAlert()

    await expect(alert.play()).resolves.toBe('played')
    expect(context.createOscillator).toHaveBeenCalledOnce()
    expect(navigator.vibrate).not.toHaveBeenCalled()
    expect(alert.getStats()).toEqual({ played: 1, blocked: 0 })
    expect(trackAudioAlert).toHaveBeenCalledWith('played')
  })

  it('a gesture unlocks audio so a later alert needs no resume', async () => {
    context.resume = vi.fn(async () => { context.state = 'running' })
    const alert = new EmergencyAudioAlert()
    const disarm = alert.armOnFirstGesture(document)

    document.dispatchEvent(new Event('pointerdown'))
    await vi.advanceTimersByTimeAsync(0)
    expect(alert.isUnlocked).toBe(true)

    document.dispatchEvent(new Event('keydown'))
    await vi.advanceTimersByTimeAsync(0)
    expect(context.resume).toHaveBeenCalledOnce() // listeners were removed after success

    context.resume.mockClear()
    await expect(alert.play()).resolves.toBe('played')
    expect(context.resume).not.toHaveBeenCalled()
    disarm()
  })

  it('stays armed until a gesture succeeds', async () => {
    let allow = false
    context.resume = vi.fn(async () => { if (allow) context.state = 'running' })
    const alert = new EmergencyAudioAlert()
    alert.armOnFirstGesture(document)

    document.dispatchEvent(new Event('pointerdown'))
    await vi.advanceTimersByTimeAsync(RESUME_TIMEOUT_MS)
    expect(alert.isUnlocked).toBe(false)

    allow = true
    document.dispatchEvent(new Event('pointerup'))
    await vi.advanceTimersByTimeAsync(0)
    expect(alert.isUnlocked).toBe(true)
  })

  it('the returned disposer removes the listeners', async () => {
    context.resume = vi.fn(async () => { context.state = 'running' })
    const alert = new EmergencyAudioAlert()
    const disarm = alert.armOnFirstGesture(document)

    disarm()
    document.dispatchEvent(new Event('pointerdown'))
    await vi.advanceTimersByTimeAsync(0)

    expect(context.resume).not.toHaveBeenCalled()
  })
})
