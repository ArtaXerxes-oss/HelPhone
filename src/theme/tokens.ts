/**
 * Design tokens for landing-page sections extracted from App.tsx (#770 / ISP-100).
 * Keep hex values here so section components do not invent new brand colours.
 */

export const colors = {
  background: '#1c2c24',
  cream: '#ECE0CC',
  coral: '#FF7A6B',
  purple: '#7357FF',
  teal: '#3F8487',
  muted: '#a2a586',
  navGlass: 'rgba(28, 44, 36, 0.92)',
  borderSubtle: 'rgba(255,255,255,0.1)',
  white: '#fff',
} as const

export const spacing = {
  navPadTop: '6rem',
  sectionPadBottom: '4rem',
  linkGap: '0.75rem',
} as const

export const motion = {
  revealThreshold: 0.12,
  revealRootMargin: '0px 0px -7% 0px',
  revealFallbackMs: 4500,
  revealViewportRatio: 0.85,
} as const

export type BrandColor = keyof typeof colors
