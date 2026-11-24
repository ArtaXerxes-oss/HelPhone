#!/usr/bin/env bash
# Deterministic build for the telemetry frame reader.
#
# Usage:
#   bash src/wasm/telemetry_reader/build.sh          # build + record SHA-256
#   bash src/wasm/telemetry_reader/build.sh --check  # verify committed artifact
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
ARTIFACT="$ROOT/src/wasm/telemetry_reader.wasm"
SIDECAR="$ROOT/src/wasm/telemetry_reader.wasm.sha256"
TARGET="wasm32-unknown-unknown"

if [[ "${1:-}" == "--check" ]]; then
  if [[ ! -f "$ARTIFACT" || ! -f "$SIDECAR" ]]; then
    echo "telemetry-wasm: FAIL (missing artifact or sidecar)" >&2
    exit 1
  fi
  expected="$(tr -d ' \t\r\n' < "$SIDECAR")"
  actual="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
  if [[ "$expected" != "$actual" ]]; then
    echo "telemetry-wasm: FAIL (SHA-256 mismatch)" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
  echo "telemetry-wasm: SHA-256 OK ($actual)"
  exit 0
fi

cd "$HERE"
cargo build --target "$TARGET" --release
mkdir -p "$(dirname "$ARTIFACT")"
cp "target/$TARGET/release/telemetry_reader.wasm" "$ARTIFACT"
sha256sum "$ARTIFACT" | awk '{print $1}' > "$SIDECAR"

echo "telemetry-wasm: built $ARTIFACT"
echo "telemetry-wasm: sha256 $(cat "$SIDECAR")"
