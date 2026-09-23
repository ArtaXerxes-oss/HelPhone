# Security Runbook — Supply Chain

Covers the typosquatting gate (#588) and the transitive vulnerability scanner (#589).

## Typosquatting gate (#588)

- Script: `scripts/detect-typosquatting.js` — Levenshtein distance over every
  name in `package.json` + `server/package.json` vs. a curated popular-package
  list. Distance 1 flags (distance 2 only for names ≥ 8 chars; bases < 5 chars
  skipped to avoid generic-base noise like `@playwright/test` vs `jest`).
- Maintainer check: `node scripts/detect-typosquatting.js --check-maintainers`
  queries npm metadata with a 5 s timeout. Offline/network failures warn only.
- Gate: `npm run security:typosquat` (also in CI `supply-chain` job). Exit 1 =
  PR blocked. Triage: verify the flagged name on npmjs.com, check publish age
  and maintainers, then rename or exception-document.

## Transitive vulnerability scan (#589)

- Script: `scripts/transitive-vulnerability-scanner.js` — builds the DAG from
  `package-lock.json` (`node_modules` nesting = depth), maps advisories in
  OSV shape onto exact versions, isolates hits at depth ≥ 5, and suggests
  `package.json` `overrides`.
- Offline default: `npm run security:transitive-vuln` reports graph stats
  (currently 1271 packages, max depth 4) and exits 0 with no advisories.
- Live OSV: append `--audit` (best-effort, warns offline). Pinned advisories:
  `--advisories <file>`. CRITICAL/HIGH hits exit 1.
- Cargo side: `contracts/**/Cargo.lock` are resolved with `stellar contract build`
  / `cargo test --locked`; suggested `[patch]` entries go through the same
  reviewer flow as npm `overrides` — never commit either without review.
