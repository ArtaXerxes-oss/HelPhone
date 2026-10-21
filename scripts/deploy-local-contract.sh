#!/usr/bin/env bash
# Build and deploy contract/contracts/helphone-contract to the local Soroban
# standalone network (see scripts/soroban-local-node.sh), then write the
# resulting contract ID + a funded test identity's secret key to
# tests/integration/.local-deployment.json so contract.integration.test.js
# can pick them up without redeploying per test run.
#
# Requires: the Stellar CLI (`stellar`, formerly `soroban-cli`) and the
# local node already running (`scripts/soroban-local-node.sh up`).
set -euo pipefail

RPC_PORT="${SOROBAN_LOCAL_RPC_PORT:-8000}"
RPC_URL="http://localhost:${RPC_PORT}/soroban/rpc"
NETWORK_PASSPHRASE="Standalone Network ; February 2017"
IDENTITY="helphone-integration-test"
OUT_FILE="$(dirname "$0")/../tests/integration/.local-deployment.json"

echo "[deploy-local-contract] configuring 'local' network alias..."
stellar network add local \
  --rpc-url "${RPC_URL}" \
  --network-passphrase "${NETWORK_PASSPHRASE}" \
  --overwrite

echo "[deploy-local-contract] generating + funding test identity '${IDENTITY}'..."
stellar keys generate "${IDENTITY}" --network local --overwrite
stellar keys fund "${IDENTITY}" --network local

echo "[deploy-local-contract] building contract..."
( cd "$(dirname "$0")/../contract" && stellar contract build )

WASM_PATH="$(dirname "$0")/../contract/target/wasm32v1-none/release/helphone_contract.wasm"

echo "[deploy-local-contract] deploying..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm "${WASM_PATH}" \
  --network local \
  --source "${IDENTITY}")

SECRET_KEY=$(stellar keys show "${IDENTITY}")
PUBLIC_KEY=$(stellar keys address "${IDENTITY}")

mkdir -p "$(dirname "${OUT_FILE}")"
cat > "${OUT_FILE}" <<EOF
{
  "contractId": "${CONTRACT_ID}",
  "rpcUrl": "${RPC_URL}",
  "networkPassphrase": "${NETWORK_PASSPHRASE}",
  "testAccount": { "publicKey": "${PUBLIC_KEY}", "secretKey": "${SECRET_KEY}" }
}
EOF

echo "[deploy-local-contract] deployed ${CONTRACT_ID} — wrote ${OUT_FILE}"
