#!/usr/bin/env bash
# Rebuilds src/wasm/telemetry_reader.wasm and its SHA-256 sidecar
# (spike, ADR-014). Requires the wasm32-unknown-unknown Rust target.
set -euo pipefail
CRATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$CRATE/../telemetry_reader.wasm"
cargo build --manifest-path "$CRATE/Cargo.toml" --release --target wasm32-unknown-unknown
cp "$CRATE/target/wasm32-unknown-unknown/release/telemetry_reader.wasm" "$OUT"
sha256sum "$OUT" | awk '{print $1}' > "$OUT.sha256"
echo "wrote $OUT ($(wc -c < "$OUT") bytes, sha256 $(cat "$OUT.sha256"))"
