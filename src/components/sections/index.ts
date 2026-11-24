export { NavSection } from './NavSection'
export type { NavSectionProps } from './NavSection'
export { HeroSection } from './HeroSection'
export type { HeroSectionProps } from './HeroSection'

/** Ordered strangler slices for the landing shell (#770 / ISP-100). */
export const SLICE_ORDER = [
  { id: 'nav', blast: 'low', status: 'extracted' },
  { id: 'hero', blast: 'low', status: 'extracted' },
  { id: 'footer', blast: 'low', status: 'planned' },
  { id: 'trust', blast: 'low', status: 'planned' },
  { id: 'features', blast: 'medium', status: 'planned' },
  { id: 'map', blast: 'high', status: 'planned' },
  { id: 'help', blast: 'critical', status: 'planned-last' },
] as const
