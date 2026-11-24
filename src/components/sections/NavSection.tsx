import { Link } from 'react-router-dom'
import { colors, spacing } from '../../theme/tokens'
import LanguageSwitcher from '../LanguageSwitcher'
import ProvenanceBadge from '../ProvenanceBadge.jsx'

export interface NavSectionProps {
  canaryActive?: boolean
  backupActive?: boolean
}

/** Pilot slice: fixed top nav extracted from App.tsx (#770). */
export function NavSection({ canaryActive = false, backupActive = false }: NavSectionProps) {
  return (
    <nav
      className="hp-app-nav"
      data-slice="nav"
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
        {canaryActive && (
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
        {backupActive && (
          <span className="hp-app-nav-status" style={{ fontSize: '0.8rem', color: colors.teal }}>
            🛡️ State Backup Active
          </span>
        )}
        <ProvenanceBadge />
        <LanguageSwitcher />
      </div>
    </nav>
  )
}

export default NavSection
