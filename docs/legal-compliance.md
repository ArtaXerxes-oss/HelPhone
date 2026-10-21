# Legal Compliance — Band Plan, Radio Redaction, Incident Bundles

## Amateur (Part 97 / ham) bands

- **Encryption is prohibited** on amateur frequencies in most jurisdictions.
  Ham-mode radio traffic stays plaintext.
- **PII is prohibited on-air** by HelPhone policy: ham mode transmits only
  the minimal schema enforced in `src/lib/radio/bandPlan.js`
  (`HAM_WIRE_FIELDS`): triage code, 6-char Maidenhead grid square, severity
  1–3, short id, timestamp, callsigns. Names, phones, notes, addresses and
  full-precision coordinates are structurally redacted before fragmentation
  (`redactForHam` + `assertHamSafe` — enforced by unit tests that fail the
  build on any leak).
- Operators must hold a valid amateur license and identify with their
  callsign (`from` field) per local regulations.

## Licensed (Part 90 / commercial) bands

- Licensed mode encrypts every frame with compact AEAD (AES-256-GCM,
  12-byte IV) via `bandPlan.encryptLicensed` inside the 150-byte MTU budget.
- Session keys are provisioned out-of-band; never on-air, never in
  `localStorage` exports or incident bundles.

## Incident bundles (ISP-130)

- Default tier `volunteer-safe`: secrets + PII scrubbed by
  `scripts/security/env_firewall.js` (`scrubText`), verified with
  `scanForPii` before the archive is written — a single hit fails collection.
- `command-internal` tier requires `--break-glass`, writes an `audit-log.json`
  (actor, time, reason, expiry) into the bundle, and expires in 7 days.
- Bundle access must be recorded in the incident postmortem; expired bundles
  are deleted per retention policy (`docs/disaster-recovery.md`).

## Staging NFC tags

- Tags carry only `stagingId + nonce + HMAC` (`x-helphone/staging` mime) —
  zero PII on the air, per `docs/privacy-policy.md`. Cloned/static tags
  fail HMAC verification and are logged as tamper events.

## Hardware key interception (ISP-131)

- Hardware SOS/PTT interception is opt-in via the `hardwareSos` feature flag
  and consented on first use in the Help page. Handlers are unregistered on
  unmount; media keys outside the PWA scope are never touched.

## Consent & audit logging

- SOS dispatches, staging check-ins and break-glass bundle collections are
  idempotently logged with timestamps for liability audit; free-text notes
  never traverse amateur bands.

---

*Appendix (from main): Legal Compliance: Open Source Licenses*

HelPhone's code is permissively licensed (MIT / Apache-2.0). Any dependency
we ship has to be compatible with that. This page describes the license gate
that enforces it (#586) and what to do when the gate fails.

## What runs

| Where | Command | Effect |
| --- | --- | --- |
| CI `supply-chain` job (every PR/push) | `node scripts/license-compliance.js --no-write` | Fails the build on an unapproved copyleft license |
| Release pipeline (`slsa-provenance.yml`) | `npm run build:release` | Writes `dist/licenses.json`, which is covered by the signed digests |
| Locally | `npm run licenses:generate` | Regenerates the committed `licenses.json` |
| Locally | `npm run security:license-gate` | Runs the same check as CI without writing files |

`scripts/license-compliance.js` has no runtime dependencies. It reads:

- **npm:** every entry in `package-lock.json`, direct and transitive. The
  license comes from the lockfile, or from the installed
  `node_modules/<pkg>/package.json` when the lockfile omits it. That is the
  same source `license-checker` uses. Workspace links (`server/`) are our own
  code and are skipped.
- **Cargo:** `cargo metadata --locked` for the root workspace (`contracts/*`)
  and for `contract/`. Only registry and git crates count; path crates are our
  own code.

## Policy

Each license is evaluated as an SPDX expression. `OR` takes the most
permissive branch, `AND` takes the most restrictive term, and a `WITH`
exception keeps a permissive license approved.

| Category | Licenses | Gate |
| --- | --- | --- |
| **approved** | MIT, MIT-0, ISC, Apache-2.0, BSD-2/3-Clause, 0BSD, BlueOak-1.0.0, CC0-1.0, CC-BY-3.0/4.0, Unlicense, Zlib, BSL-1.0, Python-2.0, Unicode-3.0, Unicode-DFS-2016, WTFPL | pass |
| **review** | Weak copyleft (LGPL, MPL, EPL, CDDL), `SEE LICENSE IN …`, `UNKNOWN`, anything non-SPDX | warning; fails with `--strict` |
| **denied** | GPL, AGPL, SSPL, EUPL, OSL, RPL, CPAL, Sleepycat, CC-BY-NC/SA/ND | **fails CI** |

Dev-only dependencies are gated too. Build and test tooling runs in CI and
release infrastructure, and AGPL/SSPL obligations can apply there.

## Exceptions

`LICENSE_EXCEPTIONS` in `scripts/license-compliance.js` lists the denied
packages that have been legally reviewed, each with a justification:

| Package | License | Why it's allowed |
| --- | --- | --- |
| `@lobstrco/signer-extension-api` | GPL-3.0 | Transitive dependency of `@creit-tech/stellar-wallets-kit`. It is a messaging shim to the LOBSTR browser extension. Tracked for replacement (#625). |

To add an exception:

1. Get written sign-off from a maintainer who owns legal review.
2. Add `"<ecosystem>:<name>": "<justification + tracking issue>"` to
   `LICENSE_EXCEPTIONS`.
3. Run `npm run licenses:generate` and commit the updated `licenses.json` in
   the same PR.

## When the gate fails

```
DENIED: npm:some-lib@2.1.0 (AGPL-3.0)
license-compliance: FAIL — 1 copyleft license(s) not approved for this permissive codebase
```

1. Find what pulled it in: `npm explain some-lib`, or `cargo tree -i some-lib`.
2. Prefer a permissively licensed alternative, or pin a version released
   before the license change.
3. If neither is possible, go through the exception process above.

## Attribution manifest (`licenses.json`)

`licenses.json` lists every third-party package with its ecosystem, name,
version, SPDX license, category and repository (when known), plus a summary
and the policy in force. The output is deterministic, with no timestamps, so
diffs show only real dependency changes. `THIRD_PARTY_LICENSES.md` (#625,
npm only) is still the human-readable BOM.
