#!/usr/bin/env bash
# ==============================================================================
# fire-drill.sh
# Backup/restore fire-drill harness (ISP-129). Restores into an isolated clone
# and never touches production. This file currently implements the safety
# guards and the ordered plan only; restore steps are not wired yet.
#
# Usage:
#   CLONE_DATABASE_URL=postgres://.../helphone_clone scripts/fire-drill.sh --plan
#   CLONE_DATABASE_URL=postgres://.../helphone_drill scripts/fire-drill.sh --run --i-understand-this-wipes
# ==============================================================================

set -euo pipefail

MODE="plan"
WIPE_ACK="no"

for arg in "$@"; do
  case "$arg" in
    --plan) MODE="plan" ;;
    --run) MODE="run" ;;
    --i-understand-this-wipes) WIPE_ACK="yes" ;;
    *)
      echo "[fire-drill] unknown argument: ${arg}" >&2
      exit 2
      ;;
  esac
done

CLONE_DATABASE_URL="${CLONE_DATABASE_URL:-}"

if [ -z "${CLONE_DATABASE_URL}" ]; then
  echo "[fire-drill] CLONE_DATABASE_URL is required. Refusing to guess a target." >&2
  exit 1
fi

# Database name is the last path segment, without any query string.
DB_NAME="${CLONE_DATABASE_URL%%\?*}"
DB_NAME="${DB_NAME##*/}"

# Guard 1: the target must be explicitly a clone or drill database.
case "${DB_NAME}" in
  *_clone | *_drill) ;;
  *)
    echo "[fire-drill] refusing target database '${DB_NAME}': name must end in _clone or _drill." >&2
    exit 1
    ;;
esac

# Guard 2: refuse anything that looks like production, even with a clone suffix.
if printf '%s' "${CLONE_DATABASE_URL}" | grep -qiE '(prod|production|live)'; then
  echo "[fire-drill] refusing target: URL contains a production-like marker." >&2
  exit 1
fi

# Guard 3: destructive mode needs an explicit acknowledgement flag.
if [ "${MODE}" = "run" ] && [ "${WIPE_ACK}" != "yes" ]; then
  echo "[fire-drill] --run wipes the clone. Re-run with --i-understand-this-wipes." >&2
  exit 1
fi

echo "[fire-drill] target database: ${DB_NAME} (mode: ${MODE})"
echo "[fire-drill] ordered plan:"
echo "  1. restore PostgreSQL to target time on clone"
echo "  2. reset indexer cursor to restored high-water mark"
echo "  3. restore Redis RDB with backlog quarantine (no refire)"
echo "  4. import field kits (IDB export)"
echo "  5. reconcile contract truth vs PG projections"
echo "  6. emit cutover signal"

if [ "${MODE}" = "plan" ]; then
  echo "[fire-drill] plan only; no changes made."
  exit 0
fi

echo "[fire-drill] --run is not implemented yet: restore steps 1-6 are pending." >&2
exit 3
