import { Link } from 'react-router-dom'
import { colors, spacing } from '../../theme/tokens'

export interface HeroSectionProps {
  /** When true, show the emergency CTA (gated by emergency_broadcaster). */
  showEmergencyCta?: boolean
  revealIndex?: number
  visible?: boolean
}

/** Pilot slice: landing hero extracted from App.tsx (#770). */
export function HeroSection({
  showEmergencyCta = false,
  revealIndex = 0,
  visible = true,
}: HeroSectionProps) {
  return (
    <section
      data-slice="hero"
      data-reveal={revealIndex}
      data-visible={visible ? '1' : '0'}
      style={{
        paddingTop: spacing.navPadTop,
        paddingBottom: spacing.sectionPadBottom,
        textAlign: 'center',
        opacity: visible ? 1 : 0.35,
        transition: 'opacity 400ms ease',
      }}
    >
      <h1 style={{ fontSize: 'clamp(2rem, 8vw, 3rem)', color: colors.cream, marginBottom: '1rem' }}>
        Community Emergency Response Web App
      </h1>
      <p
        style={{
          fontSize: '1.25rem',
          color: colors.muted,
          maxWidth: '700px',
          margin: '0 auto 2rem',
          padding: '0 1rem',
        }}
      >
        Peer-to-peer decentralised emergency dispatch powered by Soroban smart contracts, ZK privacy
        proofs, and WebAuthn Passkeys.
      </p>

      {showEmergencyCta && (
        <div style={{ marginTop: '2rem' }}>
          <Link
            to="/help"
            style={{
              background: colors.coral,
              color: colors.white,
              padding: '1rem 2rem',
              borderRadius: '0.5rem',
              textDecoration: 'none',
              fontWeight: 'bold',
              fontSize: '1.1rem',
            }}
          >
            Request Emergency Help Now
          </Link>
        </div>
      )}
    </section>
  )
}

export default HeroSection
