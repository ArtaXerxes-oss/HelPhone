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

## License compliance gate (#586)

- Script: `scripts/license-compliance.js` scans npm (`package-lock.json`) and
  Cargo (`cargo metadata`) licenses and evaluates SPDX expressions. CI fails
  on strong copyleft (GPL/AGPL/SSPL/…) that isn't listed in
  `LICENSE_EXCEPTIONS`.
- `npm run security:license-gate` runs the same check as CI.
  `npm run licenses:generate` regenerates `licenses.json`.
- Policy, exception process and triage: `docs/legal-compliance.md`.

## CVE patch bot (#599)

- Script: `scripts/auto-patch-cve.js`. It reads GitHub Security Advisories,
  either through `npm audit` (the default, backed by the GitHub Advisory DB)
  or the GitHub REST `/advisories?affects=` API (`--source github`). It then
  plans the **minimum** fixed version for every vulnerable `name@version` in
  the lockfile: the lowest published, non-deprecated, non-prerelease version
  that no known advisory matches, preferring the same major.
- Strategy:
  - For a direct dependency, the bot bumps the range in `package.json` or
    `server/package.json` and keeps the existing `^`/`~` style.
  - For a transitive dependency, it writes a root `overrides` floor
    (`"pkg": "^fixed"`) when every installed copy is on the fixed major.
    Otherwise it writes a version-keyed override (`"pkg@1.2.3": "1.2.4"`) so
    copies on other majors stay untouched.
  - Fixes that need a major bump are listed for a human. Pass `--allow-major`
    to apply them.
- Modes:
  - `npm run security:cve-patch` prints the plan only.
  - `npm run security:cve-patch:apply` writes the manifests, runs
    `npm install`, confirms that the lockfile and `npm audit` no longer report
    the patched advisories, then runs every `--verify <cmd>` (default
    `npm test`). If any step fails, it restores `package.json`,
    `server/package.json` and `package-lock.json`.
  - `--open-pr` also commits the change on `security/cve-patch-*`, pushes it,
    and opens a PR with the advisory table, verification results and the
    follow-up list.
- Automation: `.github/workflows/cve-patch-bot.yml` runs weekly and on
  manual dispatch. PRs opened with `GITHUB_TOKEN` don't trigger CI, so set a
  `CVE_BOT_TOKEN` secret (fine-grained PAT or GitHub App) to get checks on
  bot PRs. CI's `supply-chain` job runs the plan in report-only mode and fails
  only on critical advisories.
- Triage for a bot PR:
  1. Review the advisory links.
  2. Check that the version moves are patch or minor.
  3. Merge.
  4. Handle "Needs manual follow-up" items as separate PRs, for example a
     dependency upgrade that removes the vulnerable package.

## Crypto-core pins (#779)

- Policy: `crypto-pins.json` lists the Barretenberg/Noir packages
  (`@aztec/bb.js`, `@noir-lang/*`) with their exact pinned version, tier,
  rationale, ADR reference and last review date.
- Gate: `npm run security:crypto-pins` (`scripts/check-crypto-pins.js`, also
  a step of CI's `supply-chain` job and a `--verify` step of the CVE patch
  bot) fails with a readable explanation when:
  - a pinned package resolves to another version anywhere in
    `package-lock.json`;
  - the `@noir-lang` family resolves to mixed versions;
  - a `barretenberg` crate in `Cargo.lock` (none today) differs from the
    pinned `@aztec/bb.js`;
  - a pin lacks a rationale or review date.
- Stale pins: a pin not reviewed for more than `staleAfterDays` (180) is
  reported as `STALE`; `--strict-stale` turns that into a failure.
- Bot behaviour: packages in the `crypto-core` tier are never applied by
  `scripts/auto-patch-cve.js`. They appear under "Needs manual follow-up"
  and still count towards `--fail-on`.
- ABI checklist for a deliberate crypto-core bump (one PR):
  1. Bump `package.json`/`package-lock.json` and any coupled Cargo pin together.
  2. Recompile the circuits and run the real prove/verify path, not a mock.
  3. Update `version`, `rationale` and `reviewed` in `crypto-pins.json`.
  4. Roll back by reverting that single PR; never revert only one lockfile.
- Not covered here: unmocked prover smoke tests in CI, staged PWA rollout of
  WASM changes, and typosquat-hold ordering for the bot.

## Maintainer key revocation & web of trust (#619)

- Script: `scripts/security/verify_maintainer_keys.js`, configured by
  `config/maintainer-keys.json`. It verifies OpenPGP signatures on commits
  (`--range`), annotated tags (`--tags <glob>`) and release artifacts
  (`--artifact f --signature f.asc`) in-process. It includes an RFC 4880
  parser and uses node:crypto for RSA, EdDSA and ECDSA, so no gpg is needed.
- Revocation data is live. Keys are fetched from keys.openpgp.org and
  keyserver.ubuntu.com, merged, and cached in `.cache/maintainer-keys/` for
  `cacheTtlHours`. `--refresh` forces a refetch and `--offline` uses the cache
  only. Revocation certificates are verified cryptographically, so a forged
  one is ignored.
- Revocation rules (RFC 4880 §5.2.3.23):

  | Reason | Signatures before the revocation | Signatures after |
  | --- | --- | --- |
  | 0x02 key compromised / 0x00 no reason | **invalid** | invalid |
  | 0x01 superseded / 0x03 retired | valid | invalid |

  This is the case the tool exists for. A release signed *before* anyone
  discovered that the key was compromised still fails.
- Web of trust: a signer is trusted when it is a `trustedKeys` root, or when
  it has at least `minCertifications` valid, unrevoked certifications from a
  root. Certifications from a root that was itself revoked as compromised
  don't count. The roots are the GitHub web-flow keys, which cover merges made
  in the UI; add maintainer keys as the team adopts signing.
- `dependencies[]` pins critical upstream maintainers' key fingerprints
  (`{ "name", "fingerprints": [...] }`). `--pinned` checks each key against
  the live revocation lists:
  - compromised: FAIL (re-verify every release that key signed)
  - superseded: WARN (pin the successor key)
- Gates:
  - Bad signatures, compromised keys and revoked trusted roots always fail.
  - Unsigned, unknown-key, untrusted and SSH-signed objects warn, and fail
    under `--strict`.
- Where it runs:
  - CI `supply-chain`: PR commit range.
  - `verify-keys.yml`: pushes, release tags, and a nightly `--refresh` sweep
    of every `v*` tag and all pinned keys.
  - `slsa-provenance.yml`: before release builds. Set the repository variable
    `REQUIRE_SIGNED_RELEASES=true` to make release tags `--strict`.
- If it fails on a compromised key:
  1. Freeze releases.
  2. Identify every artifact signed by that fingerprint (the `signer` field in
     `--json` output).
  3. Rebuild and re-sign them with a fresh key.
  4. Rotate `trustedKeys` / `dependencies[]`.
## Rate-limit whitelist for emergency services (#536)

Verified emergency-service callers bypass the API rate limiter. Entries live in
Redis (`REDIS_URL`) so they change at runtime with no redeploy; without
`REDIS_URL` an in-process store is used (single instance, lost on restart —
dev/test only).

- Code: `server/middleware/whitelist.ts` (matching + admin API),
  `server/lib/redis.ts` (optional client), limiter hook in
  `server/middleware/rateLimiter.ts` and `createRateLimiter` in `server/index.js`.
- Match rules: request IP inside a whitelisted IPv4/IPv6 CIDR, **or** an
  `X-API-Key` header whose SHA-256 is registered. Match sets
  `req.bypassRateLimit`; nothing else is relaxed (CORS, auth and body limits
  still apply).
- **Set `TRUST_PROXY`** (`1` on Render) so `req.ip` is the real client. If it is
  wrong, either every caller looks like the proxy or `X-Forwarded-For` can be
  spoofed to fake a whitelisted IP.
- Fail closed: if Redis is unreachable the normal limit applies. Subnet lists
  are cached ~5 s per worker, so changes on other workers take up to that long.

### Admin API

Requires `Authorization: Bearer $WHITELIST_ADMIN_TOKEN`; returns 503 if the
token is unset and 401 on a bad token.

| Method & path | Body | Effect |
| --- | --- | --- |
| `GET /admin/whitelist` | – | List subnets and API-key metadata |
| `POST /admin/whitelist/subnets` | `{ "cidr": "203.0.113.0/24", "label": "County 911" }` | Add a subnet |
| `DELETE /admin/whitelist/subnets` | `{ "cidr": "203.0.113.0/24" }` | Remove a subnet |
| `POST /admin/whitelist/api-keys` | `{ "label": "Dispatch CAD" }` | Create a key; **the plaintext is returned once** and only its hash is stored |
| `DELETE /admin/whitelist/api-keys/:id` | – | Revoke a key by id |

Rotate `WHITELIST_ADMIN_TOKEN` like any other secret; treat a leaked API key as
revoked immediately.

## Dependency & license auditor (#540)

- Script: `scripts/audit-deps.js` — reads `package-lock.json` and
  `server/package-lock.json`; shares its license matrix with
  `scripts/security/license_compliance.js` (`license_policy.js`). Writes a
  deterministic `licenses.json` (no timestamps).
- Gate: `npm run security:audit-deps:check` (CI `supply-chain` job). Exit 1 =
  PR blocked. Server-only run: `npm run audit:deps --workspace server`.
- **DENIED** — GPL/AGPL/SSPL/EUPL/OSL/CPAL/RPL. Replace the dependency; only
  add to `EXCEPTIONS` in `license_policy.js` after legal review. Weak copyleft
  (LGPL/MPL/...) is a REVIEW warning; `--strict` promotes it to a failure.
- **INSTALL-SCRIPT** — a package gained a lifecycle script. Read the script
  (`npm view <pkg>@<ver> scripts`); if legitimate, add it to
  `INSTALL_SCRIPT_ALLOWLIST` with a reason. `suspicious-install-script` means
  the installed body matched curl|sh, eval, base64, remote URL or env-exfil
  patterns — treat as a possible compromise: do not install, pin the previous
  version and report upstream.
- **SOURCE** — resolved tarball is off the trusted registries (or http/git),
  or integrity is missing/weak. Usually a tampered lockfile: regenerate it
  from a clean checkout and diff.
- **STALE** — `licenses.json` no longer matches the lockfiles; run
  `npm run security:audit-deps` and commit.

## Build pipeline egress monitor

Detects and blocks malicious network egress (data exfiltration) while the
build pipeline runs: dependency installation and `npm run build`.

- Script: `scripts/monitor-build-egress.sh [options] [--] <command>` — starts
  a capture, runs the command, then classifies every captured destination.
  `--classify [file]` re-audits an existing capture log (this is what the
  tests exercise).
- Backends (`--backend auto|tcpdump|iptables|none`):
  - **tcpdump** — `tcpdump -i any -nn -l -Q out 'ip or ip6'`; uses `sudo -n`
    when not root. This is the CI backend.
  - **iptables** — root only. Installs an `EGRESS-MONITOR` chain on `OUTPUT`
    that RETURNs loopback/established/allowlisted destinations, LOGs the rest
    with the `EGRESS-DENY: ` prefix, and with `--enforce` REJECTs them so the
    build is blocked at the socket level. The chain is removed on exit.
  - **none** — no capture. `--strict` fails the run; otherwise the build
    continues with a warning (Render uses this: no `CAP_NET_RAW`).
- Classification rules, in order:
  1. deny list wins — `169.254.169.254` and friends plus
     `metadata.google.internal` / `instance-data` are always unauthorized;
  2. an allowlisted hostname in the same line legitimises the flow (DNS query
     or SNI), so CDN IPs are accepted without pinning them;
  3. destination IP inside an allowlisted CIDR → allowed;
  4. anything else → `UNAUTHORIZED` (reason `ip-not-allowlisted` /
     `domain-not-allowlisted`) and exit 1.
- Built-in allowlist: loopback, `10/8`, `172.16/12`, `192.168/16`, CGNAT
  `100.64/10`, ULA/link-local IPv6, `/etc/resolv.conf` nameservers, and
  registry/documentation hosts (npm, GitHub, PyPI, crates.io, nodejs.org).
  Allowlisted domains are resolved up-front (parallel, 3 s bound per lookup)
  so their current IPs are covered too.
- Extending the policy: `EGRESS_ALLOWLIST` (comma separated), an
  `EGRESS_ALLOWLIST_FILE` / `--allowlist-file` (one entry per line, `#`
  comments), or the `EGRESS_ALLOWLIST` env var Render exposes. Never widen a
  broad CIDR (e.g. all of `0.0.0.0/0`) to silence a finding — investigate
  first.
- Artifacts (uploaded by CI as `build-egress-audit`):
  `artifacts/build-egress/<step>/egress-capture.log` (raw),
  `egress-audit.log` (one verdict per line) and `egress-summary.log`
  (counts, allowlist size, build exit code, verdict).
- Gates:
  - `npm run security:egress` — run `npm run build` under the monitor;
  - `npm run security:egress:strict` — also fail when capture is unavailable;
  - `npm run security:egress:audit` — re-classify a saved capture;
  - CI job `build-egress-monitor` — strict install gate, then the production
    build with `--ignore-command-exit` so this job owns the *network* verdict
    (the app build's own exit code is recorded in the summary only);
  - `render.yaml` `buildCommand` — the deploy build runs with
    `--allow-no-capture` because Render build containers cannot capture.
- Triage of a finding: open `egress-audit.log`, take the `dst=`/`domain=`
  fields. If it is a legitimate build vendor, add it to the allowlist with a
  reason in the same PR. If it is not explainable, treat the dependency as
  compromised: do not publish the artifact, pin the previous version, rotate
  any secrets present in the build environment, and report upstream.

---

## Egress Anomaly Detection & Key-Rotation Incident Runbook (ISP-094)

### 1. Trigger Conditions
- CI/CD build egress transcript records unexpected DNS query (`*.exfil.invalid` or high-entropy subdomain).
- Query-string beacon (`?canary=...` or param entropy > 4.0) observed on allowed or unallowed hosts.
- Unauthorized outbound SYN/TCP connection during `install` or `build` phase.
- Leaked Stellar seed or Mapbox token detected during artifact scan.

### 2. Immediate Containment & Key Rotation Procedure
1. **Immediate Release Freeze**:
   - Abort current pipeline run; reject release artifact signing.
   - Quarantine candidate deployment in Render / GitHub Actions.
2. **Stellar Key Compromise Protocol**:
   - Rotate master operator and hot wallet signing keys immediately:
     - Generate new Ed25519 seed keypair via offline HSM / secure vault.
     - Fund new public key on Soroban network.
     - Transfer admin privileges via `set_admin` contract invocation with multi-sig approval.
     - Revoke compromised signing public key from contract maintainer set.
3. **Mapbox & Infrastructure Token Revocation**:
   - Revoke compromised Mapbox secret token (`sk.*`) in Mapbox Developer Console.
   - Issue replacement token with strict scope limited to HelPhone vector tileset URLs.
   - Update Render and GitHub secret vaults.
4. **Attestation & Post-Mortem**:
   - Produce audited egress transcript hash and compare against clean build baseline.
   - File CVE advisory and incident bundle per `docs/disaster-recovery.md`.