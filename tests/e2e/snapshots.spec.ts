import { expect, test } from '@playwright/test';

const themes = ['light', 'dark', 'high-contrast'] as const;
const pages = [
  { name: 'help', path: '/help', mask: ['.mapboxgl-map'] },
  { name: 'ranking', path: '/ranking', mask: [] },
  { name: 'admin', path: '/admin', mask: [] },
] as const;

for (const theme of themes) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme === 'dark' ? 'dark' : 'light' });

    for (const target of pages) {
      test(`${target.name} visual snapshot`, async ({ page }) => {
        await page.addInitScript((selectedTheme) => {
          localStorage.setItem('helphone-theme-mode', selectedTheme);
          document.documentElement.dataset.theme = selectedTheme;
        }, theme);
        await page.goto(target.path);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => {
          document.querySelectorAll('video').forEach((video) => video.pause());
          document.documentElement.dataset.snapshot = 'true';
        });
        await expect(page).toHaveScreenshot(`${target.name}-${theme}.png`, {
          fullPage: true,
          animations: 'disabled',
          caret: 'hide',
          mask: target.mask.map((selector) => page.locator(selector)),
          maxDiffPixelRatio: 0.002,
        });
      });
    }
  });
}
