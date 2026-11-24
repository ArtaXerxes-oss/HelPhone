import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { FeatureFlagProvider, useFeatureFlag } from './lib/featureFlags.js'
import { WalletProvider } from './contexts/WalletContext.js'
import LanguageSwitcher from './components/LanguageSwitcher'
import ProvenanceBadge from './components/ProvenanceBadge.jsx'
import { NavSection, HeroSection } from './components/sections'
import { colors, motion, spacing } from './theme/tokens'

function AppContent() {
  const [visibleElements, setVisibleElements] = useState<Set<number>>(new Set())
  const [replicaLagMs, setReplicaLagMs] = useState<number>(0)
  const [syncProgress, setSyncProgress] = useState<number | null>(null)
  const [isRecovering, setIsRecovering] = useState<boolean>(false)

  const emergencyBroadcasterEnabled = useFeatureFlag('emergency_broadcaster')
  const sorobanBackupEnabled = useFeatureFlag('soroban_state_backup')
  const canaryMapClustering = useFeatureFlag('canary_map_clustering')
  const sliceNav = useFeatureFlag('slice_nav')
  const sliceHero = useFeatureFlag('slice_hero')

  useEffect(() => {
    const elements = document.querySelectorAll('[data-reveal]')
    const vh = window.innerHeight || 800

    elements.forEach((el, idx) => {
      const rect = el.getBoundingClientRect()
      if (rect.top <= vh * motion.revealViewportRatio) {
        setVisibleElements((prev) => new Set([...prev, idx]))
      }
    })

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const idx = Array.from(elements).indexOf(entry.target)
            setVisibleElements((prev) => new Set([...prev, idx]))
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: motion.revealThreshold, rootMargin: motion.revealRootMargin },
    )

    elements.forEach((el) => observer.observe(el))

    const timeout = setTimeout(() => {
      setVisibleElements((prev) => new Set(Array.from({ length: elements.length }, (_, i) => i)))
    }, motion.revealFallbackMs)

    return () => {
      observer.disconnect()
      clearTimeout(timeout)
    }
  }, [])

  return (
    <div style={{ background: colors.background, color: colors.cream, minHeight: '100vh' }}>
      {sliceNav ? (
        <NavSection canaryActive={canaryMapClustering} backupActive={sorobanBackupEnabled} />
      ) : (
        <nav
          className="hp-app-nav"
          style={{
            position: 'fixed',
            top: 0,
            insetInline: 0,
            zIndex: 100,
            background: colors.navGlass,
            backdropFilter: 'blur(8px)',
            borderBottom: `1px solid ${colors.borderSubtle}`,
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <div className="hp-app-nav-brand" style={{ display: 'flex', alignItems: 'center', gap: spacing.linkGap }}>
            <span style={{ fontSize: '1.5rem', fontWeight: 'bold', color: colors.coral }}>HelPhone</span>
            {canaryMapClustering && (
              <span
                className="hp-app-nav-status"
                style={{
                  fontSize: '0.75rem',
                  background: colors.purple,
                  color: colors.white,
                  padding: '0.2rem 0.5rem',
                  borderRadius: '999px',
                  fontWeight: 600,
                }}
              >
                CANARY ACTIVE
              </span>
            )}
          </div>
          <div className="hp-app-nav-links" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center' }}>
            <Link to="/" style={{ color: colors.cream, textDecoration: 'none' }}>
              Home
            </Link>
            <Link to="/help" style={{ color: colors.cream, textDecoration: 'none' }}>
              Emergency Request
            </Link>
            <Link to="/ranking" style={{ color: colors.cream, textDecoration: 'none' }}>
              Responders
            </Link>
            {sorobanBackupEnabled && (
              <span className="hp-app-nav-status" style={{ fontSize: '0.8rem', color: colors.teal }}>
                🛡️ State Backup Active
              </span>
            )}
            {replicaLagMs > 10000 && (
              <span
                className="hp-stale-badge"
                data-testid="stale-badge"
                style={{
                  fontSize: '0.8rem',
                  color: colors.coral,
                  background: 'rgba(255, 122, 107, 0.15)',
                  padding: '0.2rem 0.5rem',
                  borderRadius: '4px',
                  fontWeight: 600,
                }}
              >
                ⚠️ Stale ~{Math.round(replicaLagMs / 1000)}s
              </span>
            )}
            {syncProgress !== null && (
              <span
                className="hp-sync-badge"
                data-testid="sync-badge"
                style={{
                  fontSize: '0.8rem',
                  color: colors.teal,
                  background: 'rgba(35, 75, 78, 0.2)',
                  padding: '0.2rem 0.5rem',
                  borderRadius: '4px',
                }}
              >
                🔄 Syncing history {syncProgress}%
              </span>
            )}
            {isRecovering && (
              <span
                className="hp-recovery-badge hp-offline-indicator"
                data-testid="recovery-badge"
                style={{
                  fontSize: '0.8rem',
                  color: colors.purple,
                  background: 'rgba(115, 87, 255, 0.2)',
                  padding: '0.2rem 0.5rem',
                  borderRadius: '4px',
                }}
              >
                🛡️ Recovering...
              </span>
            )}
            <ProvenanceBadge />
            <LanguageSwitcher />
          </div>
        </nav>
      )}

      {sliceHero ? (
        <HeroSection
          showEmergencyCta={emergencyBroadcasterEnabled}
          revealIndex={0}
          visible={visibleElements.has(0)}
        />
      ) : (
        <section
          data-reveal={0}
          style={{ paddingTop: spacing.navPadTop, paddingBottom: spacing.sectionPadBottom, textAlign: 'center' }}
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
          {emergencyBroadcasterEnabled && (
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
      )}
    </div>
  )
}

export default function App() {
  return (
    <FeatureFlagProvider>
      <WalletProvider>
        <AppContent />
      </WalletProvider>
    </FeatureFlagProvider>
  )
}
