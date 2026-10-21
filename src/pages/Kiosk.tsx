/**
 * Kiosk page — /kiosk?shelter=BRAVO&lang=en
 *
 * Locked-down intake flow for shared shelter tablets.
 * - No nav, no map interactivity, no responder PII on screen
 * - Auto-lock: 90 s warn → 120 s wipe decrypted state
 * - Staff PIN elevation for triage (10 min, then auto-demote)
 * - Triple-tap corner → PIN exit dialog
 * - Escape remapped to "step back" only
 * - Tab trapped inside intake
 * - Language switch preserves ?shelter= param
 * - All events logged to audit chain
 */
import { useState, useEffect, useRef, useCallback, useId } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { useNetworkQuality } from '../hooks/useNetworkQuality'
import { useGeofencing } from '../hooks/useGeofencing'
import {
  startKioskSession,
  getKioskSession,
  wipeKioskSession,
  attemptPinElevation,
  demoteToAnon,
  isPinLocked,
  pinLockRemainingMs,
  elevationRemainingMs,
} from '../lib/kioskSession'
import { getShelterName } from '../lib/geofence'
import { appendAuditEvent } from '../lib/kioskAudit'
import i18n from '../i18n'

// ── Constants ────────────────────────────────────────────────────────────────

/** Single-flag rollback: set VITE_KIOSK_ENABLED=false to 404 this route. */
const KIOSK_ENABLED = import.meta.env.VITE_KIOSK_ENABLED !== 'false'

const WARN_MS = 90_000
const LOCK_MS = 120_000
const TRIPLE_TAP_MS = 800   // window for 3 taps in same corner
const TRIPLE_TAP_COUNT = 3

// ── Types ─────────────────────────────────────────────────────────────────────

type IntakeStep = 'welcome' | 'type' | 'location' | 'details' | 'confirm' | 'submitted'
type ModalKind = 'none' | 'lock' | 'pin-exit' | 'geofence-error'

interface DraftState {
  emergencyType: string
  locationName: string
  details: string
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function KioskPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { t } = useTranslation()
  const shelterId = (searchParams.get('shelter') ?? 'UNKNOWN').toUpperCase()
  const shelterName = getShelterName(shelterId)

  // --- guard ---
  if (!KIOSK_ENABLED) {
    return (
      <div role="main" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', fontFamily: 'system-ui', color: '#234B4E' }}>
        <span>404 — Not found</span>
      </div>
    )
  }

  return <KioskInner shelterId={shelterId} shelterName={shelterName} searchParams={searchParams} setSearchParams={setSearchParams} />
}

function KioskInner({
  shelterId,
  shelterName,
  searchParams,
  setSearchParams,
}: {
  shelterId: string
  shelterName: string
  searchParams: URLSearchParams
  setSearchParams: (p: URLSearchParams) => void
}) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)

  const [step, setStep] = useState<IntakeStep>('welcome')
  const [modal, setModal] = useState<ModalKind>('none')
  const [draft, setDraft] = useState<DraftState>({ emergencyType: '', locationName: '', details: '' })
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState('')
  const [pinLockSecs, setPinLockSecs] = useState(0)
  const [elevationSecs, setElevationSecs] = useState<number | null>(null)
  const cornerTapRef = useRef<number[]>([])
  const dialogTitleId = useId()
  const pinInputRef = useRef<HTMLInputElement>(null)

  // Geofencing
  const { insidePolygon, error: geoError } = useGeofencing(shelterId)

  // Network quality + idle tracking
  const { idleState, secondsRemaining, resetIdle } = useNetworkQuality({
    warnAfterMs: WARN_MS,
    lockAfterMs: LOCK_MS,
    trackIdle: true,
    onWarn: () => {
      if (modal === 'none') setModal('lock')
    },
    onLock: () => {
      handleAutoLock()
    },
  })

  // Focus trap — always active in kiosk
  useFocusTrap(containerRef, { enabled: true })

  // Escape → step back (never exit kiosk)
  useEscapeKey(
    useCallback(() => {
      if (modal !== 'none') return // let modal handle it
      stepBack()
    }, [modal, step]),
    { kioskMode: true, enabled: modal === 'none' },
  )

  // Boot: start session and audit
  useEffect(() => {
    startKioskSession(shelterId, shelterName)
    appendAuditEvent('kiosk_start', shelterId)
  }, [shelterId, shelterName])

  // Elevation countdown ticker
  useEffect(() => {
    const id = setInterval(() => {
      const rem = elevationRemainingMs()
      setElevationSecs(rem !== null ? Math.ceil(rem / 1000) : null)
      if (rem !== null && rem <= 0) {
        demoteToAnon()
        setElevationSecs(null)
      }
      // PIN lock countdown
      setPinLockSecs(Math.ceil(pinLockRemainingMs() / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // Language switch: preserve shelter param, no full reload
  function switchLang(code: string) {
    i18n.changeLanguage(code)
    const next = new URLSearchParams(searchParams)
    next.set('lang', code)
    setSearchParams(next)
    appendAuditEvent('language_changed', shelterId, { lang: code })
  }

  // Triple-tap corner detector (bottom-right)
  function handleCornerTap() {
    const now = Date.now()
    const taps = cornerTapRef.current
    const recent = taps.filter((t) => now - t < TRIPLE_TAP_MS)
    recent.push(now)
    cornerTapRef.current = recent
    if (recent.length >= TRIPLE_TAP_COUNT) {
      cornerTapRef.current = []
      setModal('pin-exit')
      setTimeout(() => pinInputRef.current?.focus(), 50)
    }
  }

  // Auto-lock: wipe decrypted state, keep encrypted queue
  function handleAutoLock() {
    wipeKioskSession()
    appendAuditEvent('auto_wipe', shelterId)
    // Reset intake but do NOT clear secureStorage — encrypted outbox survives
    setStep('welcome')
    setDraft({ emergencyType: '', locationName: '', details: '' })
    setModal('lock')
  }

  function handleUnlock() {
    // Resume session
    startKioskSession(shelterId, shelterName)
    resetIdle()
    setModal('none')
  }

  function stepBack() {
    const order: IntakeStep[] = ['welcome', 'type', 'location', 'details', 'confirm', 'submitted']
    const idx = order.indexOf(step)
    if (idx > 0) setStep(order[idx - 1])
  }

  function stepForward() {
    const order: IntakeStep[] = ['welcome', 'type', 'location', 'details', 'confirm', 'submitted']
    const idx = order.indexOf(step)
    if (idx < order.length - 1) setStep(order[idx + 1])
  }

  async function handleSubmit() {
    // Geofence check
    if (insidePolygon === false) {
      setModal('geofence-error')
      return
    }
    await appendAuditEvent('intake_filed', shelterId, { type: draft.emergencyType })
    setStep('submitted')
  }

  async function handlePinSubmit() {
    if (isPinLocked()) return
    setPinError('')
    const result = await attemptPinElevation(pin)
    setPin('')
    if (result === 'elevated') {
      await appendAuditEvent('pin_elevated', shelterId)
      setElevationSecs(Math.ceil((10 * 60 * 1000) / 1000))
      setModal('none')
    } else if (result === 'locked') {
      await appendAuditEvent('pin_locked', shelterId)
      setPinError(t('kiosk.pin.locked', 'Too many attempts. Try again in 5 minutes.'))
    } else {
      await appendAuditEvent('pin_failed', shelterId)
      setPinError(t('kiosk.pin.wrong', 'Incorrect PIN.'))
    }
  }

  async function handleStaffExit() {
    await appendAuditEvent('staff_exit', shelterId)
    demoteToAnon()
    wipeKioskSession()
    // Navigate to /help (outside kiosk scope) — only reachable after correct PIN
    window.location.href = '/help'
  }

  const session = getKioskSession()
  const elevated = session?.role === 'staff-pin'

  return (
    <div
      ref={containerRef}
      data-kiosk="true"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#1c2c24',
        fontFamily: "'Inter', system-ui, sans-serif",
        overscrollBehavior: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      {/* ── Banner ── */}
      <KioskBanner
        shelterName={shelterName}
        elevated={elevated}
        elevationSecs={elevationSecs}
        idleState={idleState}
        secondsRemaining={secondsRemaining}
        onSwitchLang={switchLang}
      />

      {/* ── Main intake area ── */}
      <main
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '0 24px 24px' }}
        aria-label={t('kiosk.intake.label', 'Emergency intake')}
      >
        {step === 'welcome' && (
          <WelcomeStep shelterName={shelterName} onNext={stepForward} />
        )}
        {step === 'type' && (
          <TypeStep value={draft.emergencyType} onChange={(v) => setDraft((d) => ({ ...d, emergencyType: v }))} onBack={stepBack} onNext={stepForward} />
        )}
        {step === 'location' && (
          <LocationStep value={draft.locationName} onChange={(v) => setDraft((d) => ({ ...d, locationName: v }))} shelterId={shelterId} onBack={stepBack} onNext={stepForward} />
        )}
        {step === 'details' && (
          <DetailsStep value={draft.details} onChange={(v) => setDraft((d) => ({ ...d, details: v }))} onBack={stepBack} onNext={stepForward} />
        )}
        {step === 'confirm' && (
          <ConfirmStep draft={draft} shelterName={shelterName} onBack={stepBack} onSubmit={handleSubmit} />
        )}
        {step === 'submitted' && (
          <SubmittedStep onNewRequest={() => { setStep('welcome'); setDraft({ emergencyType: '', locationName: '', details: '' }) }} />
        )}
      </main>

      {/* ── Triple-tap exit corner (invisible 60×60 touch target) ── */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={handleCornerTap}
        style={{
          position: 'fixed',
          bottom: 0,
          right: 0,
          width: 60,
          height: 60,
          background: 'transparent',
          border: 'none',
          cursor: 'default',
          zIndex: 9999,
        }}
      />

      {/* ── Modals ── */}
      {modal === 'lock' && (
        <LockScreenModal
          shelterName={shelterName}
          secondsRemaining={idleState === 'warn' ? secondsRemaining : null}
          onUnlock={handleUnlock}
          titleId={dialogTitleId}
        />
      )}

      {modal === 'pin-exit' && (
        <PinModal
          pin={pin}
          error={pinError}
          locked={isPinLocked()}
          lockSecsRemaining={pinLockSecs}
          inputRef={pinInputRef}
          onChange={setPin}
          onSubmit={handlePinSubmit}
          onStaffExit={elevated ? handleStaffExit : undefined}
          onCancel={() => { setPin(''); setPinError(''); setModal('none') }}
          titleId={dialogTitleId}
        />
      )}

      {modal === 'geofence-error' && (
        <GeofenceErrorModal
          shelterName={shelterName}
          onClose={() => setModal('none')}
          titleId={dialogTitleId}
        />
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function KioskBanner({
  shelterName,
  elevated,
  elevationSecs,
  idleState,
  secondsRemaining,
  onSwitchLang,
}: {
  shelterName: string
  elevated: boolean
  elevationSecs: number | null
  idleState: string
  secondsRemaining: number | null
  onSwitchLang: (code: string) => void
}) {
  const { t, i18n } = useTranslation()
  const currentLang = i18n.resolvedLanguage || 'en'

  return (
    <header
      role="banner"
      aria-label="Kiosk status"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 20px',
        background: '#1c3535',
        borderBottom: '1px solid rgba(63,132,135,0.3)',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          aria-live="polite"
          style={{
            fontSize: 11,
            fontWeight: 900,
            letterSpacing: '1.6px',
            color: elevated ? '#FF7A6B' : '#7fb8ba',
          }}
        >
          KIOSK · {shelterName.toUpperCase()}
        </span>
        {elevated && elevationSecs !== null && (
          <span style={{ fontSize: 10, color: '#FF7A6B', opacity: 0.8 }}>
            {t('kiosk.staff', 'STAFF')} {elevationSecs}s
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {idleState === 'warn' && secondsRemaining !== null && (
          <span
            role="status"
            aria-live="assertive"
            style={{ fontSize: 11, color: '#FF7A6B', fontWeight: 700 }}
          >
            {t('kiosk.lockIn', 'Locking in')} {secondsRemaining}s
          </span>
        )}
        {/* Language switcher — stays in kiosk scope */}
        {['en', 'ar'].map((code) => (
          <button
            key={code}
            type="button"
            aria-label={`Switch language to ${code === 'ar' ? 'Arabic' : 'English'}`}
            aria-pressed={currentLang.startsWith(code)}
            onClick={() => onSwitchLang(code)}
            style={{
              padding: '5px 9px',
              borderRadius: 7,
              border: `1px solid ${currentLang.startsWith(code) ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)'}`,
              background: currentLang.startsWith(code) ? 'rgba(255,255,255,0.12)' : 'transparent',
              color: currentLang.startsWith(code) ? 'rgba(242,236,220,0.95)' : 'rgba(242,236,220,0.4)',
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
              minWidth: 44,
              minHeight: 44,
            }}
          >
            {code === 'ar' ? 'العربية' : 'EN'}
          </button>
        ))}
      </div>
    </header>
  )
}

function BigBtn({
  children,
  onClick,
  secondary = false,
  disabled = false,
}: {
  children: React.ReactNode
  onClick?: () => void
  secondary?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        minHeight: 56,
        padding: '14px 20px',
        borderRadius: 12,
        border: secondary ? '1px solid rgba(255,255,255,0.18)' : 'none',
        background: secondary ? 'rgba(255,255,255,0.07)' : '#FF7A6B',
        color: secondary ? 'rgba(242,236,220,0.8)' : '#fff',
        fontSize: 17,
        fontWeight: 700,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'opacity 0.15s',
      }}
    >
      {children}
    </button>
  )
}

function WelcomeStep({ shelterName, onNext }: { shelterName: string; onNext: () => void }) {
  const { t } = useTranslation()
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, maxWidth: 480, margin: '0 auto', width: '100%' }}>
      <div style={{ textAlign: 'center' }}>
        <p style={{ fontSize: 13, color: '#7fb8ba', letterSpacing: '1.4px', fontWeight: 900, margin: '0 0 12px' }}>
          {shelterName.toUpperCase()}
        </p>
        <h1 style={{ margin: '0 0 10px', fontSize: 34, fontFamily: "'Instrument Serif', serif", fontWeight: 400, color: '#F4ECDC', lineHeight: 1.1 }}>
          {t('kiosk.welcome.title', 'Need help?')}
        </h1>
        <p style={{ margin: 0, fontSize: 15, color: 'rgba(242,236,220,0.6)', lineHeight: 1.6 }}>
          {t('kiosk.welcome.body', 'This tablet connects you with nearby responders. Tap below to start.')}
        </p>
      </div>
      <BigBtn onClick={onNext}>{t('kiosk.welcome.cta', 'Request help')}</BigBtn>
    </div>
  )
}

const EMERGENCY_TYPES = [
  { value: 'medical', label: 'Medical emergency' },
  { value: 'lost', label: "I'm lost" },
  { value: 'fallen', label: 'Fell / injured' },
  { value: 'danger', label: 'I feel unsafe' },
  { value: 'other', label: 'Something else' },
]

function TypeStep({ value, onChange, onBack, onNext }: { value: string; onChange: (v: string) => void; onBack: () => void; onNext: () => void }) {
  const { t } = useTranslation()
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480, margin: '0 auto', width: '100%', paddingTop: 32 }}>
      <h2 style={{ margin: 0, color: '#F4ECDC', fontSize: 22, fontWeight: 700 }}>{t('kiosk.type.title', 'What do you need?')}</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
        {EMERGENCY_TYPES.map((et) => (
          <button
            key={et.value}
            type="button"
            aria-pressed={value === et.value}
            onClick={() => onChange(et.value)}
            style={{
              width: '100%',
              minHeight: 56,
              padding: '14px 18px',
              borderRadius: 12,
              border: `2px solid ${value === et.value ? '#FF7A6B' : 'rgba(255,255,255,0.12)'}`,
              background: value === et.value ? 'rgba(255,122,107,0.14)' : 'rgba(255,255,255,0.05)',
              color: value === et.value ? '#FF7A6B' : 'rgba(242,236,220,0.85)',
              fontSize: 16,
              fontWeight: 600,
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            {t(`kiosk.type.${et.value}`, et.label)}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <BigBtn secondary onClick={onBack}>{t('kiosk.back', 'Back')}</BigBtn>
        <BigBtn onClick={onNext} disabled={!value}>{t('kiosk.next', 'Next')}</BigBtn>
      </div>
    </div>
  )
}

function LocationStep({ value, onChange, shelterId, onBack, onNext }: { value: string; onChange: (v: string) => void; shelterId: string; onBack: () => void; onNext: () => void }) {
  const { t } = useTranslation()
  const shelterName = getShelterName(shelterId)
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480, margin: '0 auto', width: '100%', paddingTop: 32 }}>
      <h2 style={{ margin: 0, color: '#F4ECDC', fontSize: 22, fontWeight: 700 }}>{t('kiosk.location.title', 'Where are you?')}</h2>
      <div style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(63,132,135,0.14)', border: '1px solid rgba(63,132,135,0.3)', color: '#7fb8ba', fontSize: 13 }}>
        {t('kiosk.location.pinned', 'Location pinned to')} {shelterName}
      </div>
      <label style={{ color: 'rgba(242,236,220,0.7)', fontSize: 13 }}>
        {t('kiosk.location.room', 'Room / area (optional)')}
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('kiosk.location.placeholder', 'e.g. Room 12, entrance')}
          style={{
            display: 'block',
            marginTop: 8,
            width: '100%',
            padding: '14px 14px',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'rgba(255,255,255,0.07)',
            color: '#F4ECDC',
            fontSize: 16,
            outline: 'none',
            boxSizing: 'border-box',
            minHeight: 56,
          }}
        />
      </label>
      <div style={{ display: 'flex', gap: 10, marginTop: 'auto' }}>
        <BigBtn secondary onClick={onBack}>{t('kiosk.back', 'Back')}</BigBtn>
        <BigBtn onClick={onNext}>{t('kiosk.next', 'Next')}</BigBtn>
      </div>
    </div>
  )
}

function DetailsStep({ value, onChange, onBack, onNext }: { value: string; onChange: (v: string) => void; onBack: () => void; onNext: () => void }) {
  const { t } = useTranslation()
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480, margin: '0 auto', width: '100%', paddingTop: 32 }}>
      <h2 style={{ margin: 0, color: '#F4ECDC', fontSize: 22, fontWeight: 700 }}>{t('kiosk.details.title', 'Any details?')}</h2>
      <label style={{ color: 'rgba(242,236,220,0.7)', fontSize: 13, flex: 1, display: 'flex', flexDirection: 'column' }}>
        {t('kiosk.details.label', 'Describe what you need (optional)')}
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('kiosk.details.placeholder', 'e.g. I need a wheelchair')}
          rows={4}
          style={{
            flex: 1,
            marginTop: 8,
            padding: '14px',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'rgba(255,255,255,0.07)',
            color: '#F4ECDC',
            fontSize: 16,
            resize: 'none',
            outline: 'none',
            fontFamily: 'inherit',
            minHeight: 120,
          }}
        />
      </label>
      <div style={{ display: 'flex', gap: 10 }}>
        <BigBtn secondary onClick={onBack}>{t('kiosk.back', 'Back')}</BigBtn>
        <BigBtn onClick={onNext}>{t('kiosk.next', 'Next')}</BigBtn>
      </div>
    </div>
  )
}

function ConfirmStep({ draft, shelterName, onBack, onSubmit }: { draft: DraftState; shelterName: string; onBack: () => void; onSubmit: () => void }) {
  const { t } = useTranslation()
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480, margin: '0 auto', width: '100%', paddingTop: 32 }}>
      <h2 style={{ margin: 0, color: '#F4ECDC', fontSize: 22, fontWeight: 700 }}>{t('kiosk.confirm.title', 'Review your request')}</h2>
      <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 12, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Row label={t('kiosk.confirm.type', 'Type')} value={draft.emergencyType} />
        <Row label={t('kiosk.confirm.location', 'Location')} value={`${shelterName}${draft.locationName ? ` · ${draft.locationName}` : ''}`} />
        {draft.details && <Row label={t('kiosk.confirm.details', 'Details')} value={draft.details} />}
      </div>
      <p style={{ fontSize: 12, color: 'rgba(242,236,220,0.4)', margin: 0 }}>
        {t('kiosk.confirm.privacy', 'Your details are encrypted before transmission and only visible to verified responders.')}
      </p>
      <div style={{ display: 'flex', gap: 10, marginTop: 'auto' }}>
        <BigBtn secondary onClick={onBack}>{t('kiosk.back', 'Back')}</BigBtn>
        <BigBtn onClick={onSubmit}>{t('kiosk.confirm.submit', 'Send request')}</BigBtn>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'rgba(242,236,220,0.4)', letterSpacing: '1px', fontWeight: 700, marginBottom: 3 }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 14, color: '#F4ECDC' }}>{value}</div>
    </div>
  )
}

function SubmittedStep({ onNewRequest }: { onNewRequest: () => void }) {
  const { t } = useTranslation()
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, maxWidth: 480, margin: '0 auto', width: '100%', textAlign: 'center' }}>
      <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(63,132,135,0.2)', border: '1px solid #3F8487', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#3F8487" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </div>
      <div>
        <h2 style={{ margin: '0 0 8px', color: '#F4ECDC', fontSize: 28, fontFamily: "'Instrument Serif', serif", fontWeight: 400 }}>
          {t('kiosk.submitted.title', 'Request sent')}
        </h2>
        <p style={{ margin: 0, color: 'rgba(242,236,220,0.6)', fontSize: 14, lineHeight: 1.6 }}>
          {t('kiosk.submitted.body', 'A nearby responder has been notified. Please stay where you are.')}
        </p>
      </div>
      <BigBtn secondary onClick={onNewRequest}>{t('kiosk.submitted.another', 'New request')}</BigBtn>
    </div>
  )
}

// ── Modals ─────────────────────────────────────────────────────────────────────

function LockScreenModal({ shelterName, secondsRemaining, onUnlock, titleId }: { shelterName: string; secondsRemaining: number | null; onUnlock: () => void; titleId: string }) {
  const { t } = useTranslation()
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={{ position: 'fixed', inset: 0, background: '#0e1c18', zIndex: 20000, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 32 }}
    >
      <p id={titleId} style={{ fontSize: 13, letterSpacing: '1.6px', color: '#7fb8ba', fontWeight: 900, margin: 0 }}>
        KIOSK · {shelterName.toUpperCase()}
      </p>
      <h2 style={{ margin: 0, color: '#F4ECDC', fontSize: 32, fontFamily: "'Instrument Serif', serif", fontWeight: 400, textAlign: 'center' }}>
        {secondsRemaining !== null
          ? t('kiosk.lock.warning', 'Locking soon')
          : t('kiosk.lock.locked', 'Screen locked')}
      </h2>
      {secondsRemaining !== null && (
        <p role="status" aria-live="assertive" style={{ color: '#FF7A6B', fontSize: 18, fontWeight: 700, margin: 0 }}>
          {secondsRemaining}s
        </p>
      )}
      <div style={{ width: '100%', maxWidth: 340 }}>
        <BigBtn onClick={onUnlock}>{t('kiosk.lock.tap', 'Tap to continue')}</BigBtn>
      </div>
    </div>
  )
}

function PinModal({
  pin, error, locked, lockSecsRemaining, inputRef, onChange, onSubmit, onStaffExit, onCancel, titleId,
}: {
  pin: string
  error: string
  locked: boolean
  lockSecsRemaining: number
  inputRef: React.RefObject<HTMLInputElement | null>
  onChange: (v: string) => void
  onSubmit: () => void
  onStaffExit?: () => void
  onCancel: () => void
  titleId: string
}) {
  const { t } = useTranslation()

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter') onSubmit()
    if (e.key === 'Escape') onCancel()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 20000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
    >
      <div style={{ width: '100%', maxWidth: 360, background: '#1c3535', borderRadius: 18, padding: '24px 22px 20px', border: '1px solid rgba(63,132,135,0.3)' }}>
        <h2 id={titleId} style={{ margin: '0 0 6px', color: '#F4ECDC', fontSize: 20, fontWeight: 700 }}>
          {t('kiosk.pin.title', 'Staff PIN')}
        </h2>
        <p style={{ margin: '0 0 18px', fontSize: 13, color: 'rgba(242,236,220,0.5)' }}>
          {t('kiosk.pin.body', 'Enter the staff PIN to exit kiosk mode or access triage.')}
        </p>

        {locked ? (
          <p role="alert" style={{ color: '#FF7A6B', fontSize: 14, fontWeight: 700 }}>
            {t('kiosk.pin.lockedCountdown', 'Locked. Try again in')} {lockSecsRemaining}s
          </p>
        ) : (
          <>
            <input
              ref={inputRef}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKey}
              aria-label={t('kiosk.pin.inputLabel', 'Staff PIN')}
              style={{
                width: '100%',
                padding: '14px',
                borderRadius: 10,
                border: `1px solid ${error ? '#FF7A6B' : 'rgba(255,255,255,0.15)'}`,
                background: 'rgba(255,255,255,0.07)',
                color: '#F4ECDC',
                fontSize: 22,
                letterSpacing: 8,
                outline: 'none',
                boxSizing: 'border-box',
                marginBottom: error ? 8 : 16,
              }}
            />
            {error && <p role="alert" style={{ color: '#FF7A6B', fontSize: 13, margin: '0 0 14px' }}>{error}</p>}
            <BigBtn onClick={onSubmit} disabled={!pin}>
              {t('kiosk.pin.enter', 'Enter')}
            </BigBtn>
          </>
        )}

        {onStaffExit && (
          <button
            type="button"
            onClick={onStaffExit}
            style={{ marginTop: 10, width: '100%', minHeight: 44, padding: '10px', borderRadius: 10, border: '1px solid rgba(255,122,107,0.4)', background: 'rgba(255,122,107,0.1)', color: '#FF7A6B', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
          >
            {t('kiosk.pin.exitKiosk', 'Exit kiosk mode')}
          </button>
        )}

        <button
          type="button"
          onClick={onCancel}
          style={{ marginTop: 8, width: '100%', minHeight: 44, padding: '10px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: 'rgba(242,236,220,0.5)', fontSize: 14, cursor: 'pointer' }}
        >
          {t('kiosk.pin.cancel', 'Cancel')}
        </button>
      </div>
    </div>
  )
}

function GeofenceErrorModal({ shelterName, onClose, titleId }: { shelterName: string; onClose: () => void; titleId: string }) {
  const { t } = useTranslation()
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 20000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
    >
      <div style={{ width: '100%', maxWidth: 360, background: '#1c3535', borderRadius: 18, padding: '24px 22px 20px', border: '1px solid rgba(255,122,107,0.3)' }}>
        <h2 id={titleId} style={{ margin: '0 0 10px', color: '#FF7A6B', fontSize: 20, fontWeight: 700 }}>
          {t('kiosk.geofence.title', 'Outside shelter area')}
        </h2>
        <p style={{ margin: '0 0 18px', fontSize: 14, color: 'rgba(242,236,220,0.7)', lineHeight: 1.6 }}>
          {t('kiosk.geofence.body', 'This kiosk only accepts requests from inside {{shelter}}. If you are inside and see this message, please ask a staff member for help.', { shelter: shelterName })}
        </p>
        <BigBtn onClick={onClose}>{t('kiosk.geofence.ok', 'OK')}</BigBtn>
      </div>
    </div>
  )
}
