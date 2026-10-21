#!/usr/bin/env bash
# Spin up a local Soroban standalone network via Docker (the official
# stellar/quickstart image) for integration testing against a real,
# localized blockchain state instead of mocks.
#
# Usage:
#   scripts/soroban-local-node.sh up      # start the node, wait until healthy
#   scripts/soroban-local-node.sh down    # stop and remove it
#
# Requires: Docker running locally. This script is not run as part of the
# standard `npm test` (see tests/integration/README.md) — it's opt-in for
# the integration suite specifically, since it needs Docker and takes tens
# of seconds to become healthy.
set -euo pipefail

CONTAINER_NAME="helphone-soroban-standalone"
RPC_PORT="${SOROBAN_LOCAL_RPC_PORT:-8000}"
IMAGE="stellar/quickstart:testing"

up() {
  if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}\$"; then
    echo "[soroban-local-node] already running"
    exit 0
  fi

  echo "[soroban-local-node] starting standalone network on port ${RPC_PORT}..."
  docker run -d \
    --name "${CONTAINER_NAME}" \
    -p "${RPC_PORT}:8000" \
    "${IMAGE}" \
    --standalone \
    --enable-soroban-rpc

  echo "[soroban-local-node] waiting for RPC to become healthy..."
  for _ in $(seq 1 60); do
    if curl -s -X POST "http://localhost:${RPC_PORT}/soroban/rpc" \
        -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
        | grep -q '"status":"healthy"'; then
      echo "[soroban-local-node] ready at http://localhost:${RPC_PORT}/soroban/rpc"
      exit 0
    fi
    sleep 2
  done

  echo "[soroban-local-node] ERROR: node did not become healthy within 120s" >&2
  docker logs "${CONTAINER_NAME}" --tail 50 >&2 || true
  exit 1
}

down() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  echo "[soroban-local-node] stopped"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *)
    echo "Usage: $0 {up|down}" >&2
    exit 1
    ;;
esac
