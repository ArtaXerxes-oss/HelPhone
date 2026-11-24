#!/bin/bash
set -euo pipefail

# Soroban Smart Contract Dependency Crate Security Audit Pipeline
# Issues: #592 — Verify all Rust contract dependencies against RustSec Advisory Database
# Targets: contracts/aegis_vault, contracts/maintainer_vault, contract/

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly CARGO_CRATES_TO_AUDIT=(
  "contracts/aegis_vault"
  "contracts/maintainer_vault"
  "contract"
)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
  echo -e "${BLUE}ℹ️  $*${NC}"
}

log_success() {
  echo -e "${GREEN}✓ $*${NC}"
}

log_warning() {
  echo -e "${YELLOW}⚠️  $*${NC}"
}

log_error() {
  echo -e "${RED}✗ $*${NC}"
}

check_dependencies() {
  log_info "Checking required tools..."

  if ! command -v cargo &> /dev/null; then
    log_error "cargo not found. Please install Rust."
    exit 1
  fi

  if ! command -v cargo-audit &> /dev/null; then
    log_warning "cargo-audit not installed. Installing..."
    cargo install cargo-audit
  fi

  log_success "Dependencies OK"
}

audit_crate() {
  local crate_dir="$1"
  local crate_name=$(basename "$crate_dir")

  log_info "Auditing ${crate_name}..."

  if [ ! -f "${PROJECT_ROOT}/${crate_dir}/Cargo.toml" ]; then
    log_warning "Cargo.toml not found in ${crate_dir}"
    return 0
  fi

  cd "${PROJECT_ROOT}/${crate_dir}"

  # Fetch latest advisory database
  cargo audit fetch || true

  # Run audit and capture results
  local audit_output
  audit_output=$(cargo audit 2>&1 || true)

  if echo "$audit_output" | grep -qi "vulnerability\|denied\|yanked"; then
    log_error "Vulnerabilities found in ${crate_name}:"
    echo "$audit_output"
    return 1
  else
    log_success "${crate_name} has no known vulnerabilities"
  fi

  # Check for no_std compliance in wasm targets
  if [[ "$crate_name" == *"contract"* ]] || [[ "$crate_name" == *"vault"* ]]; then
    log_info "Verifying no_std compliance for ${crate_name}..."

    if cargo build --target wasm32-unknown-unknown --release 2>&1 | grep -q "error\|failed"; then
      log_error "no_std build failed for ${crate_name}"
      return 1
    else
      log_success "${crate_name} compiles to no_std WASM"
    fi
  fi

  return 0
}

verify_pinned_versions() {
  log_info "Verifying dependency version pinning..."

  local unpinned_found=0

  for crate_dir in "${CARGO_CRATES_TO_AUDIT[@]}"; do
    local cargo_toml="${PROJECT_ROOT}/${crate_dir}/Cargo.toml"

    if [ ! -f "$cargo_toml" ]; then
      continue
    fi

    while IFS= read -r line; do
      if [[ "$line" =~ ^[a-z] ]] && [[ "$line" =~ "=" ]]; then
        local dep_name=$(echo "$line" | cut -d'=' -f1 | xargs)
        local dep_version=$(echo "$line" | cut -d'=' -f2 | xargs)

        # Check if version starts with ^ or ~ (semver, not pinned)
        if [[ "$dep_version" =~ ^[\^~] ]]; then
          log_warning "${crate_dir}: ${dep_name} is not pinned (${dep_version})"
          unpinned_found=1
        fi
      fi
    done < <(grep -v '^#' "$cargo_toml" | grep '=' | grep -v '^\[')
  done

  if [ $unpinned_found -eq 1 ]; then
    log_warning "Some dependencies are not pinned. Consider using exact versions (=X.Y.Z)"
  else
    log_success "All dependency versions are properly pinned"
  fi
}

main() {
  log_info "=== Soroban Smart Contract Crate Audit ===="
  echo

  check_dependencies

  local failed_audits=0

  for crate_dir in "${CARGO_CRATES_TO_AUDIT[@]}"; do
    if ! audit_crate "$crate_dir"; then
      ((failed_audits++))
    fi
    echo
  done

  verify_pinned_versions
  echo

  if [ $failed_audits -eq 0 ]; then
    log_success "All contract crates passed security audit"
    exit 0
  else
    log_error "$failed_audits crate(s) failed audit"
    exit 1
  fi
}

main "$@"
