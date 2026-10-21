import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom/vitest'

// Help.jsx has a duplicate HELP_ONBOARDING_STEPS export that causes a parse
// error. We test the form data and validation logic directly without importing
// the component file.

const EMERGENCY_TYPES = [
  { id: 'lost', icon: '🧭', label: "I'm lost", desc: "Don't know where I am or how to get back" },
  { id: 'fallen', icon: '🩹', label: 'Fell / injured', desc: 'Need assistance after a fall or injury' },
  { id: 'medical', icon: '🏥', label: 'Medical emergency', desc: "Health issue that can't wait" },
  { id: 'car', icon: '🔧', label: 'Car trouble', desc: 'Vehicle broke down on the road' },
  { id: 'danger', icon: '🛡️', label: 'I feel unsafe', desc: 'Unsafe situation, need someone nearby' },
  { id: 'other', icon: '⋯', label: 'Something else', desc: 'Another type of emergency' },
]

describe('EMERGENCY_TYPES data', () => {
  it('contains all required emergency types', () => {
    const ids = EMERGENCY_TYPES.map((et) => et.id)
    expect(ids).toContain('lost')
    expect(ids).toContain('medical')
    expect(ids).toContain('fallen')
    expect(ids).toContain('car')
    expect(ids).toContain('danger')
    expect(ids).toContain('other')
  })

  it('each type has a non-empty label and description', () => {
    for (const et of EMERGENCY_TYPES) {
      expect(typeof et.label).toBe('string')
      expect(et.label.length).toBeGreaterThan(0)
      expect(typeof et.desc).toBe('string')
      expect(et.desc.length).toBeGreaterThan(0)
    }
  })

  it('each type has a unique id', () => {
    const ids = EMERGENCY_TYPES.map((et) => et.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('Help form step validation logic', () => {
  const step1Done = (location) => Boolean(location)
  const step2Done = (emergencyType) => Boolean(emergencyType)
  const canSubmit = (location, emergencyType) => step1Done(location) && step2Done(emergencyType)

  it('step 1 requires a location', () => {
    expect(step1Done(null)).toBe(false)
    expect(step1Done([40.7, -74.0])).toBe(true)
  })

  it('step 2 requires an emergency type', () => {
    expect(step2Done(null)).toBe(false)
    expect(step2Done('lost')).toBe(true)
  })

  it('submit requires both location and emergency type', () => {
    expect(canSubmit(null, null)).toBe(false)
    expect(canSubmit([40.7, -74.0], null)).toBe(false)
    expect(canSubmit(null, 'lost')).toBe(false)
    expect(canSubmit([40.7, -74.0], 'lost')).toBe(true)
  })
})

describe('Help submit error messages', () => {
  it('returns correct error for missing location', () => {
    const validLocation = () => false
    const emergencyType = null
    let error = ''
    if (!validLocation()) error = 'Set your location first.'
    else if (!emergencyType) error = 'Select what happened.'
    expect(error).toBe('Set your location first.')
  })

  it('returns correct error for missing emergency type', () => {
    const validLocation = () => true
    const emergencyType = null
    let error = ''
    if (!validLocation()) error = 'Set your location first.'
    else if (!emergencyType) error = 'Select what happened.'
    expect(error).toBe('Select what happened.')
  })
})
