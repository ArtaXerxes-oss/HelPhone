// HelPhone ESLint Configuration
// ================================
// ONBOARDING NOTE: ESLint checks run automatically on `git commit` (husky pre-commit)
// and in CI. To run manually: `npx eslint src/`
// To auto-fix: `npx eslint src/ --fix`
//
// Why rules are set the way they are:
//
//  no-unused-vars: off — TypeScript's own unused-variable checking (tsc --noEmit)
//    is stricter and language-aware. We rely on tsc, not ESLint, for this.
//    If you see an unused variable, remove it or prefix with _ to signal intent.
//
//  no-undef: off — TypeScript's type-checker catches undefined variables with
//    better context. Global browser APIs (window, document, crypto…) are listed
//    in globals below so tsc can resolve them.
//
//  no-eval / no-implied-eval / no-new-func: error — These allow arbitrary code
//    execution and are the #1 vector for AI-generated code security issues.
//    If you legitimately need dynamic code, use a WebWorker sandbox
//    (see src/lib/workerSandbox.ts).
//
// Adding a new rule? Leave a comment explaining the 'why' so the next
// maintainer doesn't silently revert it.

import js from '@eslint/js'

export default [
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        // Browser APIs — adding a global here avoids spurious no-undef errors
        // for well-known browser APIs. If you add a new API, add it here too.
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        NodeJS: 'readonly',
        Buffer: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        IntersectionObserver: 'readonly',
        PublicKeyCredential: 'readonly',
        crypto: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      // ── Disabled (TypeScript handles these better) ────────────────────────
      // See comments at the top of this file for the rationale.
      'no-unused-vars': 'off',
      'no-console': 'off',
      'no-undef': 'off',

      // ── Security rules (always on) ────────────────────────────────────────
      // These are enforced by CI and scripts/audit-ai-code.js.
      // If you're seeing one of these in AI-generated code, remove the dynamic
      // code pattern and use the appropriate safe API instead.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
]
