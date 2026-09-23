#!/usr/bin/env bash
# Builds the spike #605 circuits (responder_credential + recursive_verifier).
#
# nargo 1.0.0-beta.9 resolves the OUTERMOST Nargo.toml above the working
# directory, so packages nested under circuits/ (whose Nargo.toml is the
# `aegis` package) fail with "Selected package `aegis` was not found".
# We stage both packages in a temp dir, build there, and copy the ACIR
# artifacts back into each package's target/.
#
# Usage: bash circuits/recursive_verifier/build.sh [N]   (N = proofs to fold, default 5)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CIRCUITS="$(dirname "$HERE")"
N="${1:-5}"
NARGO="${NARGO:-nargo}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -r "$CIRCUITS/responder_credential" "$STAGE/responder_credential"
cp -r "$HERE" "$STAGE/recursive_verifier"
rm -rf "$STAGE"/*/target
sed -i "s/^global N: u32 = [0-9]*;/global N: u32 = $N;/" "$STAGE/recursive_verifier/src/main.nr"

(cd "$STAGE/responder_credential" && "$NARGO" test && "$NARGO" compile)
(cd "$STAGE/recursive_verifier" && "$NARGO" test && "$NARGO" compile)

mkdir -p "$CIRCUITS/responder_credential/target" "$HERE/target"
cp "$STAGE/responder_credential/target/responder_credential.json" "$CIRCUITS/responder_credential/target/"
SUFFIX=""
[ "$N" != "5" ] && SUFFIX="_n$N"
cp "$STAGE/recursive_verifier/target/recursive_verifier.json" "$HERE/target/recursive_verifier$SUFFIX.json"
(cd "$STAGE/recursive_verifier" && "$NARGO" info) || true
echo "built N=$N -> $HERE/target/recursive_verifier$SUFFIX.json"
