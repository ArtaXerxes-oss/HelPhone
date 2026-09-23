#!/usr/bin/env bash
# #624 — Soroban minimal-versions auditor.
#
# Verifies HelPhone Soroban contracts resolve + build under Cargo's
# *minimal* transitive version tree (`cargo +nightly update -Z
# minimal-versions`), catching missing lower bounds and silent breakage
# in Stellar dependencies that default (max-version) resolution hides.
#
# Usage: scripts/security/cargo_minimal_versions.sh [--check-only]
#   --check-only  static lower-bound checks only (no nightly needed)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK_ONLY=0
[[ "${1:-}" == "--check-only" ]] && CHECK_ONLY=1

# Discover real contract manifests instead of hardcoding one path.
# (Issue text names contracts/emergency_vault/Cargo.toml, which does not
# exist in this repo; the live manifests are collected below.)
mapfile -t MANIFESTS < <(
  for m in \
    "$REPO_ROOT/contracts/"*/Cargo.toml \
    "$REPO_ROOT/contract/Cargo.toml" \
    "$REPO_ROOT/contract/contracts/"*/Cargo.toml; do
    [[ -f "$m" ]] && echo "$m"
  done | sort -u
)

if [[ ${#MANIFESTS[@]} -eq 0 ]]; then
  echo "cargo-minimal-versions: no Cargo.toml manifests found" >&2
  exit 1
fi

if [[ ! -f "$REPO_ROOT/contracts/emergency_vault/Cargo.toml" ]]; then
  echo "note: contracts/emergency_vault/Cargo.toml (named in #624) does not" \
    "exist; auditing ${#MANIFESTS[@]} existing manifest(s) instead."
fi

FAIL=0

# 1. Static check: every registry dependency must pin an explicit
#    lower-bound `version`. A bare `{ git|path }` dep or `version = "*"`
#    defeats minimal-versions resolution.
echo "== lower-bound constraint check =="
for manifest in "${MANIFESTS[@]}"; do
  echo "-- $manifest"
  if grep -nE 'version\s*=\s*"\*"' "$manifest"; then
    echo "ERROR: wildcard version constraint above (no lower bound)" >&2
    FAIL=1
  fi
  # Flag inline-table deps (`dep = { ... }`) that carry none of the
  # version / path / git / workspace keys (no resolvable lower bound).
  while IFS= read -r line; do
    case "$line" in
      *"[dependencies"*|*"[dev-dependencies"*|*"[workspace"*|*"[profile"*|*"[package"*|*"[lib"*|*"[features"*|*"#"*) continue ;;
    esac
    if [[ "$line" == *"="*"{"*"}"* ]]; then
      if [[ "$line" != *"version"* && "$line" != *"path"* && "$line" != *"git"* && "$line" != *"workspace"* ]]; then
        echo "WARN: dependency without explicit version/path/git/workspace: $line"
      fi
    fi
  done < "$manifest"
done

if [[ $CHECK_ONLY -eq 1 ]]; then
  [[ $FAIL -eq 0 ]] && echo "check-only: OK"
  exit $FAIL
fi

# 2. Minimal-versions resolution + build per workspace root.
# Workspaces: contracts/* are standalone packages; contract/ is a workspace.
declare -A ROOTS=()
for manifest in "${MANIFESTS[@]}"; do
  dir="$(dirname "$manifest")"
  if [[ "$manifest" == "$REPO_ROOT/contract/Cargo.toml" ]]; then
    ROOTS["$dir"]=1
  elif [[ "$manifest" == "$REPO_ROOT/contract/contracts/"* ]]; then
    continue # covered by the contract/ workspace root
  else
    ROOTS["$dir"]=1
  fi
done

if ! rustup toolchain list 2>/dev/null | grep -q nightly; then
  echo "WARN: nightly toolchain not installed; skipping minimal-versions" \
    "resolution (CI installs nightly). Static checks only." >&2
  exit $FAIL
fi

for root in $(printf '%s\n' "${!ROOTS[@]}" | sort); do
  echo "== minimal-versions build: $root =="
  tmp="$(mktemp -d)"
  cp -r "$root"/Cargo.toml "$root"/src "$tmp"/ 2>/dev/null
  # Preserve workspace layout for contract/
  [[ -f "$root/Cargo.lock" ]] && cp "$root/Cargo.lock" "$tmp"/ || true
  if [[ "$root" == "$REPO_ROOT/contract" ]]; then
    mkdir -p "$tmp/contracts"
    cp -r "$root"/contracts/* "$tmp/contracts"/
  fi
  status=0
  (
    cd "$tmp"
    cargo +nightly update -Z minimal-versions
    cargo +nightly check --locked --all-targets 2>&1 | tail -5
  ) || status=$?
  rm -rf "$tmp"
  [[ $status -ne 0 ]] && FAIL=1
done

[[ $FAIL -eq 0 ]] && echo "cargo-minimal-versions: OK"
exit $FAIL
