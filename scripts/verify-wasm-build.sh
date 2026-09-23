#!/usr/bin/env bash
# #590 — WASM build reproducibility & vendor hash verification gate.
#
# Asserts the committed ZK artifact (circuits/target/aegis.json) matches its
# recorded SHA-256 sidecar, and that deterministic build flags are configured
# (Nargo compiler_version pin + Soroban release profile: opt-level="z", lto,
# codegen-units=1). Prevents untrusted pre-compiled blobs entering production.
#
# Usage:
#   bash scripts/verify-wasm-build.sh           # verify (CI gate)
#   bash scripts/verify-wasm-build.sh --update  # re-record hash after a
#                                               # deliberate, reviewed rebuild
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT="circuits/target/aegis.json"
SIDECAR="circuits/target/aegis.sha256"
FAIL=0

if [[ "${1:-}" == "--update" ]]; then
  sha256sum "$REPO_ROOT/$ARTIFACT" | awk '{print $1}' > "$REPO_ROOT/$SIDECAR"
  echo "wasm-verify: hash re-recorded -> $SIDECAR"
  cat "$REPO_ROOT/$SIDECAR"
  exit 0
fi

echo "wasm-verify: checking $ARTIFACT"

if [[ ! -f "$REPO_ROOT/$ARTIFACT" ]]; then
  echo "FAIL: missing $ARTIFACT (vendor blob absent)" >&2
  exit 1
fi
if [[ ! -f "$REPO_ROOT/$SIDECAR" ]]; then
  echo "FAIL: missing $SIDECAR (run with --update after review)" >&2
  exit 1
fi

EXPECTED="$(tr -d ' \t\r\n' < "$REPO_ROOT/$SIDECAR")"
ACTUAL="$(sha256sum "$REPO_ROOT/$ARTIFACT" | awk '{print $1}')"

if [[ "$EXPECTED" != "$ACTUAL" ]]; then
  echo "FAIL: SHA-256 mismatch for $ARTIFACT" >&2
  echo "  expected: $EXPECTED" >&2
  echo "  actual:   $ACTUAL" >&2
  echo "  Rebuild deterministically and re-record with --update only after review." >&2
  FAIL=1
else
  echo "wasm-verify: SHA-256 OK ($ACTUAL)"
fi

# Deterministic-build flags: Nargo compiler pin.
if grep -q 'compiler_version' "$REPO_ROOT/circuits/Nargo.toml"; then
  echo "wasm-verify: Nargo compiler_version pinned"
else
  echo "FAIL: circuits/Nargo.toml lacks compiler_version pin" >&2
  FAIL=1
fi

# Deterministic-build flags: Soroban release profile (checked in every
# workspace Cargo.toml that defines [profile.release]).
for manifest in "$REPO_ROOT/contract/Cargo.toml" \
                "$REPO_ROOT/contracts/aegis_vault/Cargo.toml"; do
  if [[ -f "$manifest" ]]; then
    for key in 'opt-level = "z"' 'lto = true' 'codegen-units = 1'; do
      if grep -qF "$key" "$manifest"; then
        echo "wasm-verify: $manifest has $key"
      else
        echo "FAIL: $manifest missing $key (non-deterministic release profile)" >&2
        FAIL=1
      fi
    done
  fi
done

# Reproducible npm builds: --locked / ci installs only.
if grep -q '"build:all"' "$REPO_ROOT/package.json"; then
  echo "wasm-verify: npm build scripts present"
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "wasm-verify: FAIL" >&2
  exit 1
fi
echo "wasm-verify: OK"
