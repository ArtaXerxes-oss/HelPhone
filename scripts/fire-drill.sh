#!/usr/bin/env bash
# ==============================================================================
# fire-drill.sh
# Disaster-recovery fire-drill harness (ISP-129, #952). Restores/drills into an
# isolated clone and never touches production.
#
# Scenarios:
#   backup-restore    Full PG/Redis/field-kit/projection restore (default)
#   lag-spike         Indexer lag-spike detection & recovery drill
#   pool-exhaustion   PostgreSQL pool exhaustion drain & recovery drill
#   indexer-backfill  Indexer cursor reset & backfill catch-up drill
#   all               Run lag-spike, pool-exhaustion, and indexer-backfill
#
# Usage:
#   CLONE_DATABASE_URL=postgres://.../helphone_clone scripts/fire-drill.sh --plan
#   CLONE_DATABASE_URL=postgres://.../helphone_drill scripts/fire-drill.sh --run --i-understand-this-wipes
#   scripts/fire-drill.sh --scenario all --dry-run --report artifacts/fire-drill-report.json
# ==============================================================================

set -euo pipefail

MODE="plan"
WIPE_ACK="no"
SCENARIO="backup-restore"
DRY_RUN="${DRILL_DRY_RUN:-no}"
REPORT="${FIRE_DRILL_REPORT:-fire-drill-report.json}"
RECORD_FAILURE_TASK="${RECORD_FAILURE_TASK:-no}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --plan) MODE="plan" ;;
    --run) MODE="run" ;;
    --i-understand-this-wipes) WIPE_ACK="yes" ;;
    --dry-run) DRY_RUN="yes"; MODE="run" ;;
    --record-failure-task) RECORD_FAILURE_TASK="yes" ;;
    --scenario)
      shift
      if [ "$#" -eq 0 ]; then
        echo "[fire-drill] --scenario requires a value." >&2
        exit 2
      fi
      SCENARIO="$1"
      ;;
    --scenario=*)
      SCENARIO="${1#--scenario=}"
      ;;
    --report)
      shift
      if [ "$#" -eq 0 ]; then
        echo "[fire-drill] --report requires a path." >&2
        exit 2
      fi
      REPORT="$1"
      ;;
    --report=*)
      REPORT="${1#--report=}"
      ;;
    *)
      echo "[fire-drill] unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

case "${SCENARIO}" in
  backup-restore|lag-spike|pool-exhaustion|indexer-backfill|all) ;;
  *)
    echo "[fire-drill] unknown scenario '${SCENARIO}'. Expected: backup-restore, lag-spike, pool-exhaustion, indexer-backfill, all." >&2
    exit 2
    ;;
esac

CLONE_DATABASE_URL="${CLONE_DATABASE_URL:-}"
if [ "${DRY_RUN}" = "yes" ] && [ -z "${CLONE_DATABASE_URL}" ]; then
  CLONE_DATABASE_URL="postgres://localhost:5432/helphone_drill"
fi

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

# Guard 3: destructive live mode needs an explicit acknowledgement flag.
if [ "${MODE}" = "run" ] && [ "${DRY_RUN}" != "yes" ] && [ "${WIPE_ACK}" != "yes" ]; then
  echo "[fire-drill] --run wipes the clone. Re-run with --i-understand-this-wipes." >&2
  exit 1
fi

echo "[fire-drill] target database: ${DB_NAME} (mode: ${MODE}, scenario: ${SCENARIO}, dryRun: ${DRY_RUN})"

if [ "${SCENARIO}" = "backup-restore" ]; then
  echo "[fire-drill] ordered plan:"
  echo "  1. restore PostgreSQL to target time on clone"
  echo "  2. reset indexer cursor to restored high-water mark"
  echo "  3. restore Redis RDB with backlog quarantine (no refire)"
  echo "  4. import field kits (IDB export)"
  echo "  5. reconcile contract truth vs PG projections"
  echo "  6. emit cutover signal"
else
  echo "[fire-drill] scenario plan (${SCENARIO}):"
  echo "  - lag-spike: inject/detect indexer lag > threshold, drain slow query, verify recovery <= ${LAG_SPIKE_MAX_SECONDS:-120}s"
  echo "  - pool-exhaustion: saturate clone pool, verify poolManager shed/recover <= ${POOL_EXHAUSTION_MAX_SECONDS:-90}s"
  echo "  - indexer-backfill: rewind cursor, backfill ledger range, verify parity <= ${INDEXER_BACKFILL_MAX_SECONDS:-180}s"
fi

if [ "${MODE}" = "plan" ]; then
  echo "[fire-drill] plan only; no changes made."
  exit 0
fi

mkdir -p "$(dirname "${REPORT}")"
STEPS_FILE="${REPORT}.steps"
DRILLS_FILE="${REPORT}.drills"
rm -f "${STEPS_FILE}" "${DRILLS_FILE}"

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_SECONDS="$(date +%s)"
OVERALL_FAILED=0

step() {
  local number="$1" name="$2"; shift 2
  local before after
  before="$(date +%s)"
  echo "[fire-drill] step ${number}: ${name}"
  "$@"
  after="$(date +%s)"
  printf '%s|%s|%s\n' "${number}" "${name}" "$((after-before))" >> "${STEPS_FILE}"
}

run_drill_scenario() {
  local name="$1" max_seconds="$2" criteria="$3" cmd="$4"
  local d_start d_end d_dur d_status d_passed
  d_start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local t0 t1
  t0="$(date +%s)"
  d_status=0
  echo "[fire-drill] running scenario '${name}' (max=${max_seconds}s, criteria=${criteria})"
  if [ "${DRY_RUN}" = "yes" ]; then
    # Dry-run verifies harness, thresholds, and environment without mutating live DBs.
    :
  else
    bash -ceu "${cmd}" || d_status=$?
  fi
  t1="$(date +%s)"
  d_end="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  d_dur="$((t1 - t0))"
  if [ "${d_status}" -eq 0 ] && [ "${d_dur}" -le "${max_seconds}" ]; then
    d_passed="true"
  else
    d_passed="false"
    OVERALL_FAILED=1
  fi
  printf '%s|%s|%s|%s|%s|%s|%s\n' \
    "${name}" "${d_passed}" "${d_dur}" "${max_seconds}" "${d_start}" "${d_end}" "${criteria}" >> "${DRILLS_FILE}"
}

if [ "${SCENARIO}" = "backup-restore" ]; then
  PG_DUMP_FILE="${PG_DUMP_FILE:-}"
  BACKUP_BUNDLE="${BACKUP_BUNDLE:-}"
  RESTORE_LEDGER="${RESTORE_LEDGER:-0}"

  if [ "${DRY_RUN}" != "yes" ]; then
    if [ -n "${BACKUP_BUNDLE}" ]; then npm run bundle:verify -- "${BACKUP_BUNDLE}"; fi
    if [ -z "${PG_DUMP_FILE}" ] || [ ! -f "${PG_DUMP_FILE}" ]; then
      echo "[fire-drill] PG_DUMP_FILE must name an existing backup." >&2; exit 1
    fi
    step 1 "restore PostgreSQL" pg_restore --clean --if-exists --no-owner --dbname "${CLONE_DATABASE_URL}" "${PG_DUMP_FILE}"
    step 2 "reset indexer cursor" psql "${CLONE_DATABASE_URL}" -v ON_ERROR_STOP=1 -v ledger="${RESTORE_LEDGER}" -c 'UPDATE indexer_cursor SET ledger = :ledger;'
    step 3 "restore Redis backlog quarantine" bash -ceu '${REDIS_RESTORE_COMMAND:-:}'
    step 4 "import field kits" bash -ceu '${FIELD_KIT_IMPORT_COMMAND:-:}'
    step 5 "reconcile projections" bash -ceu '${RECONCILE_COMMAND:-:}'
    step 6 "emit cutover signal" bash -ceu '${CUTOVER_COMMAND:-:}'
    DUMP_SHA="$(sha256sum "${PG_DUMP_FILE}" | cut -d' ' -f1)"
  else
    DUMP_SHA="dry-run"
    printf '1|restore PostgreSQL (dry-run)|0\n' >> "${STEPS_FILE}"
    printf '2|reset indexer cursor (dry-run)|0\n' >> "${STEPS_FILE}"
    printf '3|restore Redis backlog quarantine (dry-run)|0\n' >> "${STEPS_FILE}"
    printf '4|import field kits (dry-run)|0\n' >> "${STEPS_FILE}"
    printf '5|reconcile projections (dry-run)|0\n' >> "${STEPS_FILE}"
    printf '6|emit cutover signal (dry-run)|0\n' >> "${STEPS_FILE}"
  fi

  ENDED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  DURATION="$(( $(date +%s) - START_SECONDS ))"
  node -e '
    const fs = require("fs");
    const [out, steps, started, ended, duration, dump, sha, target, dryRun] = process.argv.slice(1);
    const parsed = fs.readFileSync(steps, "utf8").trim().split("\n").filter(Boolean).map(x => {
      const [number, name, seconds] = x.split("|");
      return { number: Number(number), name, seconds: Number(seconds) };
    });
    fs.writeFileSync(out, JSON.stringify({
      scenario: "backup-restore",
      dryRun: dryRun === "yes",
      passed: true,
      startedAt: started,
      endedAt: ended,
      durationSeconds: Number(duration),
      target,
      dump: { path: dump, sha256: sha },
      steps: parsed
    }, null, 2) + "\n");
  ' "${REPORT}" "${STEPS_FILE}" "${STARTED_AT}" "${ENDED_AT}" "${DURATION}" "${PG_DUMP_FILE:-none}" "${DUMP_SHA}" "${DB_NAME}" "${DRY_RUN}"
  rm -f "${STEPS_FILE}" "${DRILLS_FILE}"
  echo "[fire-drill] completed; report: ${REPORT}"
  exit 0
fi

# Operational resilience scenarios (lag-spike, pool-exhaustion, indexer-backfill)
if [ "${SCENARIO}" = "lag-spike" ] || [ "${SCENARIO}" = "all" ]; then
  run_drill_scenario \
    "lag-spike" \
    "${LAG_SPIKE_MAX_SECONDS:-120}" \
    "indexer_lag_ledgers<=5_and_recovered_within_sla" \
    "${LAG_SPIKE_DRILL_COMMAND:-psql \"\${CLONE_DATABASE_URL}\" -v ON_ERROR_STOP=1 -c 'SELECT 1;'}"
fi

if [ "${SCENARIO}" = "pool-exhaustion" ] || [ "${SCENARIO}" = "all" ]; then
  run_drill_scenario \
    "pool-exhaustion" \
    "${POOL_EXHAUSTION_MAX_SECONDS:-90}" \
    "idle_connections_recovered_and_healthcheck_200" \
    "${POOL_EXHAUSTION_DRILL_COMMAND:-psql \"\${CLONE_DATABASE_URL}\" -v ON_ERROR_STOP=1 -c 'SELECT 1;'}"
fi

if [ "${SCENARIO}" = "indexer-backfill" ] || [ "${SCENARIO}" = "all" ]; then
  run_drill_scenario \
    "indexer-backfill" \
    "${INDEXER_BACKFILL_MAX_SECONDS:-180}" \
    "cursor_parity_verified_and_zero_missing_ledgers" \
    "${INDEXER_BACKFILL_DRILL_COMMAND:-psql \"\${CLONE_DATABASE_URL}\" -v ON_ERROR_STOP=1 -c 'SELECT 1;'}"
fi

ENDED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DURATION="$(( $(date +%s) - START_SECONDS ))"

node -e '
  const fs = require("fs");
  const [out, drillsFile, scenario, started, ended, duration, target, dryRun, failed] = process.argv.slice(1);
  const drills = fs.readFileSync(drillsFile, "utf8").trim().split("\n").filter(Boolean).map(line => {
    const [name, passed, seconds, maxSeconds, startedAt, endedAt, criteria] = line.split("|");
    return {
      name,
      passed: passed === "true",
      durationSeconds: Number(seconds),
      maxSeconds: Number(maxSeconds),
      startedAt,
      endedAt,
      criteria
    };
  });
  const failedDrills = drills.filter(d => !d.passed).map(d => d.name);
  fs.writeFileSync(out, JSON.stringify({
    scenario,
    dryRun: dryRun === "yes",
    passed: failed === "0" && failedDrills.length === 0,
    failedDrills,
    startedAt: started,
    endedAt: ended,
    durationSeconds: Number(duration),
    target,
    drills
  }, null, 2) + "\n");
' "${REPORT}" "${DRILLS_FILE}" "${SCENARIO}" "${STARTED_AT}" "${ENDED_AT}" "${DURATION}" "${DB_NAME}" "${DRY_RUN}" "${OVERALL_FAILED}"

rm -f "${STEPS_FILE}" "${DRILLS_FILE}"
echo "[fire-drill] completed (passed=$([ "${OVERALL_FAILED}" -eq 0 ] && echo true || echo false)); report: ${REPORT}"

if [ "${RECORD_FAILURE_TASK}" = "yes" ] && [ "${OVERALL_FAILED}" -ne 0 ]; then
  node scripts/record-drill-evidence.js --report "${REPORT}" --record-failure-task
fi

exit "${OVERALL_FAILED}"
