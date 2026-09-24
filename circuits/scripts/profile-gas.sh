#!/usr/bin/env bash
set -euo pipefail
entries="${ENTRIES:-500}"
bytes_per_entry="${BYTES_PER_ENTRY:-1024}"
host_cap=$((64 * 1024 * 1024))
payload=$((entries * bytes_per_entry))
working_set=$((payload * 3))
printf 'entries=%s\npayload_bytes=%s\nestimated_peak_bytes=%s\nhost_reference_bytes=%s\nheadroom_bytes=%s\n' \
  "$entries" "$payload" "$working_set" "$host_cap" "$((host_cap - working_set))"
if (( entries > 500 || working_set >= host_cap / 2 )); then
  echo 'FAIL: payload exceeds the contract bound or consumes >=50% of reference cap' >&2
  exit 1
fi
