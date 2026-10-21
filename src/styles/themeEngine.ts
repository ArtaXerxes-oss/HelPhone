/**
 * Dynamic accessibility theme engine: injects CSS variable overrides for
 * Light / Dark / High-Contrast modes and senses `prefers-contrast` /
 * `prefers-color-scheme` to switch automatically when the user hasn't
 * made an explicit choice.
 */

export type ThemeMode = 'light' | 'dark' | 'high-contrast';

interface ThemeTokens {
  '--color-bg': string;
  '--color-fg': string;
  '--color-accent': string;
  '--color-border': string;
  '--color-danger': string;
}

// High-contrast tokens are chosen to guarantee >= 7:1 contrast (WCAG AAA)
// between --color-fg/--color-bg and --color-accent/--color-bg.
const THEMES: Record<ThemeMode, ThemeTokens> = {
  light: {
    '--color-bg': '#ffffff',
    '--color-fg': '#1a1a1a',
    '--color-accent': '#0057b7',
    '--color-border': '#d0d0d0',
    '--color-danger': '#b00020',
  },
  dark: {
    '--color-bg': '#0f1419',
    '--color-fg': '#e8e8e8',
    '--color-accent': '#4db8ff',
    '--color-border': '#3a3f45',
    '--color-danger': '#ff6b6b',
  },
  'high-contrast': {
    '--color-bg': '#000000',
    '--color-fg': '#ffffff',
    '--color-accent': '#ffff00',
    '--color-border': '#ffffff',
    '--color-danger': '#ff3333',
  },
};

const STORAGE_KEY = 'helphone-theme-mode';
const STYLE_ELEMENT_ID = 'helphone-theme-vars';

function contrastRatio(hex1: string, hex2: string): number {
  const luminance = (hex: string): number => {
    const rgb = hex
      .replace('#', '')
      .match(/.{2}/g)!
      .map((c) => parseInt(c, 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const l1 = luminance(hex1) + 0.05;
  const l2 = luminance(hex2) + 0.05;
  return l1 > l2 ? l1 / l2 : l2 / l1;
}

export function verifyMinimumContrast(mode: ThemeMode, minRatio = 7): boolean {
  const tokens = THEMES[mode];
  return (
    contrastRatio(tokens['--color-fg'], tokens['--color-bg']) >= minRatio &&
    contrastRatio(tokens['--color-accent'], tokens['--color-bg']) >= 4.5
  );
}

function detectPreferredMode(): ThemeMode {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  if (window.matchMedia('(prefers-contrast: more)').matches) return 'high-contrast';
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

function injectThemeVariables(mode: ThemeMode): void {
  const tokens = THEMES[mode];
  let styleEl = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ELEMENT_ID;
    document.head.appendChild(styleEl);
  }

  const declarations = Object.entries(tokens)
    .map(([key, value]) => `${key}: ${value};`)
    .join(' ');

  styleEl.textContent = `:root { ${declarations} }`;
  document.documentElement.setAttribute('data-theme', mode);
}

export function setThemeMode(mode: ThemeMode, persist = true): void {
  injectThemeVariables(mode);
  if (persist) {
    localStorage.setItem(STORAGE_KEY, mode);
  }
}

export function getThemeMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
  return stored && stored in THEMES ? stored : detectPreferredMode();
}

/** Initialize the theme engine: apply the stored/detected mode and watch for system changes. */
export function initThemeEngine(): () => void {
  setThemeMode(getThemeMode(), false);

  const contrastQuery = window.matchMedia('(prefers-contrast: more)');
  const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

  const handleChange = () => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      setThemeMode(detectPreferredMode(), false);
    }
  };

  contrastQuery.addEventListener('change', handleChange);
  colorSchemeQuery.addEventListener('change', handleChange);

  return () => {
    contrastQuery.removeEventListener('change', handleChange);
    colorSchemeQuery.removeEventListener('change', handleChange);
  };
}
