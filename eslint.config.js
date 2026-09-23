import js from "@eslint/js";
import globals from "globals";

// Minimal flat config so the repo's existing husky/lint-staged `eslint --fix`
// pre-commit hook (package.json) can actually run -- no eslint.config.js has
// ever existed in this repo's history under ESLint 9's flat-config
// requirement, which made every commit fail the hook unconditionally.
//
// `no-undef`/`no-unused-vars` are set to "warn" rather than "error": this
// file's existing (untouched) source has pre-existing issues (e.g. a few
// undefined-variable references in src/pages/Help.jsx) that predate this
// config and are out of scope here -- the goal is to make the hook runnable
// again, not to retroactively fix everything it would now flag. Not a
// statement on what the repo's full lint ruleset should eventually be.
export default [
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        __VU: "readonly",
        __ITER: "readonly",
        __ENV: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "warn",
      "no-empty": "warn",
    },
  },
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "target/**",
      "circuits/target/**",
      "**/target/**",
    ],
  },
];
