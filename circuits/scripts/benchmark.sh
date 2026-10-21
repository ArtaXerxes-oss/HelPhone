#!/usr/bin/env bash
set -euo pipefail

# ── Circuit Proving Benchmark ────────────────────────────────────────────────
# Issue #132: Automated benchmarking for the aegis Noir circuit.
#
# Records proof generation time and proof size for circuits/src/main.nr
# using `nargo info` and `time` commands. Results are appended to a CSV
# file so regressions can be tracked over time.
#
# Usage:
#   bash circuits/scripts/benchmark.sh [iterations] [output_dir]
#
# Defaults:
#   iterations = 3
#   output_dir = circuits/benchmarks

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CIRCUIT_DIR="$(dirname "$SCRIPT_DIR")"
CIRCUIT_SRC="$CIRCUIT_DIR/src"
CIRCUIT_TARGET="$CIRCUIT_DIR/target"
NARGO_TOML="$CIRCUIT_DIR/Nargo.toml"
PROVER_TOML="$CIRCUIT_DIR/Prover.toml"

MAX_CONSTRAINTS="${MAX_CONSTRAINTS:-50000}"
MAX_BROWSER_PROVE_SECONDS="${MAX_BROWSER_PROVE_SECONDS:-3}"
ITERATIONS="${1:-3}"
OUTPUT_DIR="${2:-$CIRCUIT_DIR/benchmarks}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RESULTS_CSV="$OUTPUT_DIR/results.csv"

mkdir -p "$OUTPUT_DIR"

# ── Helpers ──────────────────────────────────────────────────────────────────

log() { printf '[benchmark] %s\n' "$*"; }

header_printed=false

append_csv_row() {
  local run="$1" gen_time="$2" proof_size="$3" constraint_count="$4" notes="$5"

  if [ ! -f "$RESULTS_CSV" ]; then
    echo "timestamp,run,gen_time_s,proof_size_bytes,constraint_count,notes" > "$RESULTS_CSV"
  fi

  if [ "$header_printed" = false ]; then
    header_printed=true
  fi

  echo "$TIMESTAMP,$run,$gen_time,$proof_size,$constraint_count,$notes" >> "$RESULTS_CSV"
}

# ── Prerequisite checks ─────────────────────────────────────────────────────

for cmd in nargo time bc; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "[benchmark] ERROR: required command '$cmd' not found in PATH" >&2
    exit 1
  fi
done

if [ ! -f "$NARGO_TOML" ]; then
  echo "[benchmark] ERROR: Nargo.toml not found at $NARGO_TOML" >&2
  exit 1
fi

if [ ! -f "$PROVER_TOML" ]; then
  echo "[benchmark] ERROR: Prover.toml not found at $PROVER_TOML" >&2
  exit 1
fi

log "Circuit dir:    $CIRCUIT_DIR"
log "Iterations:     $ITERATIONS"
log "Results CSV:    $RESULTS_CSV"
log "Timestamp:      $TIMESTAMP"
echo

# ── Step 1: nargo info (constraint count + circuit metadata) ─────────────────

log "── nargo info ──"
NARGO_INFO_OUTPUT=$(cd "$CIRCUIT_DIR" && nargo info 2>&1) || true
echo "$NARGO_INFO_OUTPUT"

NARGO_INFO_FILE="$OUTPUT_DIR/nargo_info_${TIMESTAMP}.txt"
echo "$NARGO_INFO_OUTPUT" > "$NARGO_INFO_FILE"

# Extract constraint count — nargo info prints a line like:
#   "Constraint count: 12345"
CONSTRAINT_COUNT=$(echo "$NARGO_INFO_OUTPUT" | grep -oP 'Constraint count:\s*\K[0-9]+' || echo "0")
log "Constraint count: $CONSTRAINT_COUNT (budget: $MAX_CONSTRAINTS)"
if [ "$CONSTRAINT_COUNT" -gt 0 ] && [ "$CONSTRAINT_COUNT" -gt "$MAX_CONSTRAINTS" ]; then
  log "ERROR: circuit exceeds browser feasibility budget"
  exit 2
fi
echo

# ── Step 2: Compile ─────────────────────────────────────────────────────────

log "── Compile ──"
COMPILE_START=$(date +%s%N)
(cd "$CIRCUIT_DIR" && nargo compile 2>&1) || {
  log "ERROR: nargo compile failed"
  exit 1
}
COMPILE_END=$(date +%s%N)
COMPILE_ELAPSED=$(( (COMPILE_END - COMPILE_START) / 1000000 ))
log "Compiled in ${COMPILE_ELAPSED}ms"
echo

# ── Step 3: Proving benchmarks ──────────────────────────────────────────────

log "── Proving benchmarks ($ITERATIONS runs) ──"

TOTAL_GEN_TIME=0
TOTAL_PROOF_SIZE=0

for i in $(seq 1 "$ITERATIONS"); do
  log "Run $i/$ITERATIONS ..."

  # Time the proof generation using /usr/bin/time or bash TIMEFORMAT
  START_NS=$(date +%s%N)
  PROVE_OUTPUT=$(cd "$CIRCUIT_DIR" && nargo prove 2>&1) || {
    log "WARNING: nargo prove failed on run $i — skipping"
    continue
  }
  END_NS=$(date +%s%N)

  ELAPSED_NS=$(( END_NS - START_NS ))
  GEN_TIME=$(echo "scale=3; $ELAPSED_NS / 1000000000" | bc)

  # Proof size: nargo prove writes to circuit_target/<name>.proof
  PROOF_FILE="$CIRCUIT_TARGET/aegis.proof"
  if [ -f "$PROOF_FILE" ]; then
    PROOF_SIZE=$(wc -c < "$PROOF_FILE" | tr -d ' ')
  else
    PROOF_SIZE=0
  fi

  log "  Run $i: ${GEN_TIME}s, proof ${PROOF_SIZE} bytes"

  TOTAL_GEN_TIME=$(echo "$TOTAL_GEN_TIME + $GEN_TIME" | bc)
  TOTAL_PROOF_SIZE=$(( TOTAL_PROOF_SIZE + PROOF_SIZE ))

  append_csv_row "$i" "$GEN_TIME" "$PROOF_SIZE" "$CONSTRAINT_COUNT" ""
done

echo

# ── Step 4: Summary ─────────────────────────────────────────────────────────

SUCCESSFUL_RUNS=$(grep -c "^$TIMESTAMP," "$RESULTS_CSV" 2>/dev/null || echo 0)

if [ "$SUCCESSFUL_RUNS" -gt 0 ]; then
  AVG_GEN_TIME=$(echo "scale=3; $TOTAL_GEN_TIME / $SUCCESSFUL_RUNS" | bc)
  AVG_PROOF_SIZE=$(( TOTAL_PROOF_SIZE / SUCCESSFUL_RUNS ))

  SUMMARY_FILE="$OUTPUT_DIR/summary_${TIMESTAMP}.txt"
  cat <<EOF > "$SUMMARY_FILE"
=== Circuit Benchmark Summary ===
Timestamp:       $TIMESTAMP
Circuit:         aegis (main.nr)
Constraint count: $CONSTRAINT_COUNT
Iterations:      $ITERATIONS
Successful runs: $SUCCESSFUL_RUNS
Avg gen time:    ${AVG_GEN_TIME}s
Avg proof size:  ${AVG_PROOF_SIZE} bytes
Browser target:  < ${MAX_BROWSER_PROVE_SECONDS}s at <= ${MAX_CONSTRAINTS} constraints
=================================
EOF

  cat "$SUMMARY_FILE"
  echo
  log "Results appended to $RESULTS_CSV"
  if [ "$(echo "$AVG_GEN_TIME > $MAX_BROWSER_PROVE_SECONDS" | bc)" -eq 1 ]; then
    log "DECISION: offload proving; measured latency exceeds browser target"
  else
    log "DECISION: browser proving remains feasible on this benchmark host"
  fi
  log "Summary written to $SUMMARY_FILE"
  log "nargo info saved to $NARGO_INFO_FILE"
else
  log "WARNING: All runs failed — no summary generated"
fi
