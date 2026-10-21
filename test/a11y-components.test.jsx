import { describe, it, expect, vi } from 'vitest'
import { axe } from 'jest-axe'
import { render } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Issue #129 — Automated Accessibility Testing (Component-level)
//
// Uses jest-axe to catch WCAG violations in React components. Fails tests
// when critical or serious violations are found.
// ---------------------------------------------------------------------------

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock('react-map-gl/mapbox', () => ({
  default: Object.assign(({ children }) => <div>{children}</div>, { displayName: 'Map' }),
  Marker: Object.assign(({ children }) => <div>{children}</div>, { displayName: 'Marker' }),
  Popup: Object.assign(({ children }) => <div>{children}</div>, { displayName: 'Popup' }),
  Source: () => null,
  Layer: () => null,
  NavigationControl: () => null,
  useMap: () => ({ current: { flyTo: vi.fn() } }),
}))

vi.mock('react-router-dom', () => ({
  Link: Object.assign(({ children, ...props }) => <a {...props}>{children}</a>, { displayName: 'Link' }),
}))

vi.mock('@creit-tech/stellar-wallets-kit/sdk', () => ({
  StellarWalletsKit: {
    getAddress: vi.fn().mockResolvedValue({ address: '' }),
    on: vi.fn().mockReturnValue(() => {}),
    authModal: vi.fn(),
  },
}))

vi.mock('@creit-tech/stellar-wallets-kit/types', () => ({
  KitEventType: { STATE_UPDATED: 'STATE_UPDATED', DISCONNECT: 'DISCONNECT' },
}))

vi.mock('../src/lib/contract', () => ({
  getRequest: vi.fn(),
  getActiveRequests: vi.fn().mockResolvedValue([]),
  getResponder: vi.fn(),
  getResponderCount: vi.fn().mockResolvedValue(0),
  createRequest: vi.fn(),
  acceptRequest: vi.fn(),
  markArrived: vi.fn(),
  resolveRequest: vi.fn(),
  cancelRequest: vi.fn(),
  getRanking: vi.fn().mockResolvedValue([]),
  ensureAccountFunded: vi.fn(),
  updateLocation: vi.fn(),
  recordExpertVerification: vi.fn(),
  subscribeToContractEvents: vi.fn().mockReturnValue(() => {}),
}))

vi.mock('../src/lib/zk', () => ({
  buildLocationProofZone: vi.fn(),
  generateLocationProof: vi.fn(),
  shortProofId: vi.fn(s => s?.slice(0, 8) || ''),
}))

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Component accessibility', () => {
  it('HelpOnboardingModal has no critical a11y violations', async () => {
    const { HelpOnboardingModal } = await import('../src/pages/Help.jsx')
    const { container } = render(
      <HelpOnboardingModal
        open={true}
        onClose={() => {}}
        onConnectWallet={async () => {}}
      />,
    )
    const results = await axe(container)
    const critical = results.violations.filter(v => v.impact === 'critical')
    expect(critical).toHaveLength(0)
  })

  it('HelpOnboardingModal closed state has no violations', async () => {
    const { HelpOnboardingModal } = await import('../src/pages/Help.jsx')
    const { container } = render(
      <HelpOnboardingModal
        open={false}
        onClose={() => {}}
        onConnectWallet={async () => {}}
      />,
    )
    const results = await axe(container)
    expect(results.violations).toHaveLength(0)
  })

  it('ExplorerLink renders with accessible markup', async () => {
    const { ExplorerLink } = await import('../src/pages/Help.jsx')
    const { container } = render(
      <ExplorerLink label="On-chain action" hash="a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" />,
    )
    const results = await axe(container)
    const critical = results.violations.filter(v => v.impact === 'critical')
    expect(critical).toHaveLength(0)
  })

  it('HelpOnboardingModal step 1 has no missing form labels', async () => {
    const { HelpOnboardingModal } = await import('../src/pages/Help.jsx')
    const { container } = render(
      <HelpOnboardingModal
        open={true}
        onClose={() => {}}
        onConnectWallet={async () => {}}
      />,
    )
    const results = await axe(container, {
      rules: { 'label': { enabled: true } },
    })
    const labelViolations = results.violations.filter(v => v.id === 'label')
    expect(labelViolations).toHaveLength(0)
  })

  it('HelpOnboardingModal buttons have accessible names', async () => {
    const { HelpOnboardingModal } = await import('../src/pages/Help.jsx')
    const { container } = render(
      <HelpOnboardingModal
        open={true}
        onClose={() => {}}
        onConnectWallet={async () => {}}
      />,
    )
    const results = await axe(container, {
      rules: { 'button-name': { enabled: true } },
    })
    const buttonViolations = results.violations.filter(v => v.id === 'button-name')
    expect(buttonViolations).toHaveLength(0)
  })

  it('HelpOnboardingModal has no color contrast issues', async () => {
    const { HelpOnboardingModal } = await import('../src/pages/Help.jsx')
    const { container } = render(
      <HelpOnboardingModal
        open={true}
        onClose={() => {}}
        onConnectWallet={async () => {}}
      />,
    )
    const results = await axe(container, {
      rules: { 'color-contrast': { enabled: true } },
    })
    const contrastViolations = results.violations.filter(v => v.id === 'color-contrast')
    expect(contrastViolations).toHaveLength(0)
  })

  it('HelpOnboardingModal dialog has no ARIA violations', async () => {
    const { HelpOnboardingModal } = await import('../src/pages/Help.jsx')
    const { container } = render(
      <HelpOnboardingModal
        open={true}
        onClose={() => {}}
        onConnectWallet={async () => {}}
      />,
    )
    const results = await axe(container, {
      rules: {
        'aria-dialog-name': { enabled: true },
        'aria-required-attr': { enabled: true },
        'aria-valid-attr': { enabled: true },
        'aria-valid-attr-value': { enabled: true },
      },
    })
    const ariaViolations = results.violations.filter(v => v.id.startsWith('aria-'))
    expect(ariaViolations).toHaveLength(0)
  })
})
