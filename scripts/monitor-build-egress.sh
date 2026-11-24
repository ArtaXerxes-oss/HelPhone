#!/usr/bin/env bash
#
# monitor-build-egress.sh — automated malicious network egress detector for
# build pipelines (CI/CD, network security, sandbox, build tooling).
#
# Wraps a build command (default: `npm run build`) with a network capture,
# classifies every observed destination against a security allowlist, and
# fails the build when a third-party dependency attempts an unauthorized
# HTTP/TCP connection to an external IP during the build phase.
#
# Usage:
#   scripts/monitor-build-egress.sh [options] [--] <command> [args...]
#   scripts/monitor-build-egress.sh --classify [capture.log]
#
# Options:
#   --strict               Fail when no packet-capture backend is available.
#   --allow-no-capture      Warn and continue without capture (default).
#   --ignore-command-exit   Report the wrapped command's exit code in the
#                           summary but only fail on egress findings (used by
#                           the CI egress job, which owns the network verdict).
#   --report-only           Never fail on unauthorized egress (audit only).
#   --backend <name>        auto | tcpdump | iptables | none  (default: auto)
#   --enforce               Also REJECT unauthorized egress (iptables backend).
#   --no-enforce            Log only, even when the iptables backend is used.
#   --allowlist-file <f>    Extra allowlist entries (one per line, # comments).
#   --log-dir <dir>         Audit log directory (default: artifacts/build-egress).
#   --classify              Classify an existing capture log instead of building.
#   -h, --help              Show this help.
#
# Environment overrides: EGRESS_LOG_DIR, EGRESS_BACKEND, EGRESS_ENFORCE,
# EGRESS_STRICT, EGRESS_REPORT_ONLY, EGRESS_ALLOWLIST (comma/space separated
# extra entries), EGRESS_ALLOWLIST_FILE.
#
# Exit codes:
#   0  build succeeded and no unauthorized egress was observed
#   1  unauthorized egress observed, or capture was required but unavailable
#   2  usage error
#   *  the wrapped build command's own exit code (unless --ignore-command-exit)

set -euo pipefail

PROGRAM_NAME="${0##*/}"

# ---------------------------------------------------------------------------
# Configuration (env overridable, flags override env)
# ---------------------------------------------------------------------------
EGRESS_LOG_DIR="${EGRESS_LOG_DIR:-artifacts/build-egress}"
EGRESS_BACKEND="${EGRESS_BACKEND:-auto}"
EGRESS_ENFORCE="${EGRESS_ENFORCE:-auto}"
EGRESS_ALLOWLIST="${EGRESS_ALLOWLIST:-}"
EGRESS_ALLOWLIST_FILE="${EGRESS_ALLOWLIST_FILE:-}"

BACKEND="none"
ENFORCE=false
STRICT=false
REPORT_ONLY=false
IGNORE_COMMAND_EXIT=false
MODE="monitor"
CMD=()

# Runtime allowlist buckets (filled by prepare_allowlist)
ALLOWLIST_CIDRS=()
ALLOWLIST_DOMAINS=()
ALLOWLIST_IP6=()

# Cloud instance metadata endpoints are never legitimate build destinations.
DENY_CIDRS=( "169.254.169.254/32" "100.100.100.200/32" "192.0.0.192/32" "fd00:ec2::254/128" )
DENY_DOMAINS=( "metadata.google.internal" "instance-data" "metadata.google.com" )

# Capture state
CAPTURE_LOG=""
CAPTURE_PID=""
IPTABLES_INSTALLED=false
LAST_TOTAL=0
LAST_ALLOWED=0
LAST_UNAUTHORIZED=0
LAST_UNKNOWN=0

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
usage() {
  awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"
}

# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------
timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

is_ipv4() { [[ "${1:-}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; }
is_ipv6() { [[ "${1:-}" == *:* && "${1:-}" =~ ^[0-9a-fA-F:]+$ ]]; }

# ip2int <dotted-quad> -> unsigned 32-bit integer
ip2int() {
  local a b c d
  local IFS=.
  read -r a b c d <<<"$1"
  printf '%s' "$(( (10#$a << 24) | (10#$b << 16) | (10#$c << 8) | 10#$d ))"
}

# cidr_contains <cidr-or-ip> <ipv4> -> 0 when the address falls inside
cidr_contains() {
  local cidr="$1" ip="$2" net prefix ipi neti mask
  if [[ "$cidr" == */* ]]; then
    net="${cidr%/*}"
    prefix="${cidr#*/}"
  else
    net="$cidr"
    prefix=32
  fi
  is_ipv4 "$ip" && is_ipv4 "$net" || return 1
  ipi="$(ip2int "$ip")"
  neti="$(ip2int "$net")"
  if (( prefix == 0 )); then
    mask=0
  else
    mask=$(( (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF ))
  fi
  (( (ipi & mask) == (neti & mask) ))
}

# ---------------------------------------------------------------------------
# Allowlist construction
# ---------------------------------------------------------------------------
# Built-in policy: loopback + RFC1918/CGNAT for local tooling, and the
# package/documentation registries the build legitimately needs.
default_allowlist_entries() {
  cat <<'EOF'
127.0.0.0/8
0.0.0.0/32
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
100.64.0.0/10
::1/128
fe80::/10
fc00::/7
registry.npmjs.org
registry.yarnpkg.com
npmjs.com
github.com
githubusercontent.com
githubassets.com
raw.githubusercontent.com
pypi.org
pythonhosted.org
crates.io
static.crates.io
nodejs.org
EOF
}

add_allowlist_entry() {
  local entry="$1"
  entry="${entry%%#*}"
  entry="$(printf '%s' "$entry" | tr -d '[:space:]')"
  [[ -z "$entry" ]] && return 0
  if [[ "$entry" == *:* ]]; then
    ALLOWLIST_IP6+=("$entry")
  elif [[ "$entry" == */* ]] || is_ipv4 "$entry"; then
    ALLOWLIST_CIDRS+=("$entry")
  else
    ALLOWLIST_DOMAINS+=("${entry,,}")
  fi
}

# Resolver addresses must stay reachable or no domain can be resolved.
load_resolver_addresses() {
  local ns
  while read -r ns; do
    [[ -z "$ns" ]] && continue
    is_ipv4 "$ns" && add_allowlist_entry "$ns/32"
  done < <(awk '/^nameserver/ { print $2 }' /etc/resolv.conf 2>/dev/null || true)
  return 0
}

prepare_allowlist() {
  ALLOWLIST_CIDRS=()
  ALLOWLIST_DOMAINS=()
  ALLOWLIST_IP6=()
  local entry
  while IFS= read -r entry; do
    add_allowlist_entry "$entry"
  done < <(default_allowlist_entries)
  if [[ -n "$EGRESS_ALLOWLIST" ]]; then
    while IFS= read -r entry; do
      add_allowlist_entry "$entry"
    done < <(printf '%s' "$EGRESS_ALLOWLIST" | tr ',' '\n')
  fi
  if [[ -n "$EGRESS_ALLOWLIST_FILE" ]]; then
    [[ -r "$EGRESS_ALLOWLIST_FILE" ]] || {
      echo "EGRESS: allowlist file not readable: $EGRESS_ALLOWLIST_FILE" >&2
      return 2
    }
    while IFS= read -r entry; do
      add_allowlist_entry "$entry"
    done < "$EGRESS_ALLOWLIST_FILE"
  fi
  load_resolver_addresses
}

# Resolve allowlisted domains up-front so CDN IPs are covered even when the
# captured packet only carries an address. Lookups run in parallel and are
# bounded so a broken resolver can never stall the build.
resolve_allowlist_domains() {
  local domain ip tmp pid
  tmp="$(mktemp "${TMPDIR:-/tmp}/egress-resolve.XXXXXX")"
  local -a pids=()
  for domain in ${ALLOWLIST_DOMAINS[@]+"${ALLOWLIST_DOMAINS[@]}"}; do
    (
      timeout 3 getent ahostsv4 "$domain" 2>/dev/null \
        | awk '{ print $1 }' >> "$tmp"
    ) &
    pids+=($!)
  done
  for pid in ${pids[@]+"${pids[@]}"}; do
    wait "$pid" 2>/dev/null || true
  done
  if [[ -s "$tmp" ]]; then
    while IFS= read -r ip; do
      if is_ipv4 "$ip"; then
        add_allowlist_entry "$ip/32"
      fi
    done < <(sort -u "$tmp")
  fi
  rm -f "$tmp"
  return 0
}

allowlist_counts() {
  printf 'cidr=%s domain=%s ip6=%s' \
    "${#ALLOWLIST_CIDRS[@]}" "${#ALLOWLIST_DOMAINS[@]}" "${#ALLOWLIST_IP6[@]}"
}

# ---------------------------------------------------------------------------
# Classification primitives
# ---------------------------------------------------------------------------
domain_allowed() {
  local host="${1,,}"
  host="${host%.}"
  [[ -z "$host" ]] && return 1
  local entry
  for entry in ${ALLOWLIST_DOMAINS[@]+"${ALLOWLIST_DOMAINS[@]}"}; do
    if [[ "$host" == "$entry" || "$host" == *."$entry" ]]; then
      return 0
    fi
  done
  return 1
}

domain_denied() {
  local host="${1,,}"
  host="${host%.}"
  [[ -z "$host" ]] && return 1
  local entry
  for entry in "${DENY_DOMAINS[@]}"; do
    if [[ "$host" == "$entry" || "$host" == *."$entry" ]]; then
      return 0
    fi
  done
  return 1
}

ip_denied() {
  local ip="$1" entry
  for entry in "${DENY_CIDRS[@]}"; do
    if is_ipv4 "$ip"; then
      cidr_contains "$entry" "$ip" && return 0
    elif is_ipv6 "$ip"; then
      local net="${entry%/*}"
      [[ "${ip,,}" == "${net,,}"* ]] && return 0
    fi
  done
  return 1
}

ip_allowed() {
  local ip="$1" entry
  if is_ipv6 "$ip"; then
    for entry in ${ALLOWLIST_IP6[@]+"${ALLOWLIST_IP6[@]}"}; do
      local net="${entry%/*}"
      [[ "${ip,,}" == "${net,,}"* ]] && return 0
    done
    return 1
  fi
  for entry in ${ALLOWLIST_CIDRS[@]+"${ALLOWLIST_CIDRS[@]}"}; do
    cidr_contains "$entry" "$ip" && return 0
  done
  return 1
}

# extract_dst_ip <capture line> -> destination address ("" when absent)
extract_dst_ip() {
  local line="$1" token
  if [[ "$line" =~ DST=([0-9a-fA-F:.]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  if [[ "$line" == *'>'* ]]; then
    token="${line#*> }"
    token="${token%% *}"
    token="${token%:}"
    # tcpdump prints "addr.port"; the last dot separates the port.
    if [[ "$token" =~ ^(.+)\.[0-9]+$ ]]; then
      token="${BASH_REMATCH[1]}"
    fi
    if is_ipv4 "$token" || is_ipv6 "$token"; then
      printf '%s' "$token"
      return 0
    fi
  fi
  printf ''
}

# extract_domains <capture line> -> newline separated hostnames (DNS query
# names, SNI hints, log URLs). Purely numeric tokens (IPv4, versions) are dropped.
extract_domains() {
  local line="$1"
  printf '%s' "$line" \
    | grep -Eo '[A-Za-z0-9][A-Za-z0-9-]*([.][A-Za-z0-9-]+)+' 2>/dev/null \
    | tr '[:upper:]' '[:lower:]' \
    | while IFS= read -r candidate; do
        candidate="${candidate%.}"
        [[ "$candidate" =~ ^[0-9.]+$ ]] && continue
        [[ "$candidate" =~ ^[0-9]+$ ]] && continue
        printf '%s\n' "$candidate"
      done || true
}

# classify_line <line> -> "VERDICT|reason|dst|domain"
classify_line() {
  local line="$1"
  local dst domain
  local domains=()
  local candidate

  dst="$(extract_dst_ip "$line")"
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] && domains+=("$candidate")
  done < <(extract_domains "$line")

  # 1. Explicit deny list wins over everything (metadata exfiltration).
  if [[ -n "$dst" ]] && ip_denied "$dst"; then
    printf 'UNAUTHORIZED|metadata-endpoint|%s|-\n' "$dst"
    return 0
  fi
  for candidate in ${domains[@]+"${domains[@]}"}; do
    if domain_denied "$candidate"; then
      printf 'UNAUTHORIZED|metadata-endpoint|%s|%s\n' "${dst:--}" "$candidate"
      return 0
    fi
  done

  # 2. An allowlisted hostname in the same line legitimises the flow.
  local allowed_domain=false unauthorized_domain=false unauthorized_name="" allowed_name=""
  for candidate in ${domains[@]+"${domains[@]}"}; do
    if domain_allowed "$candidate"; then
      allowed_domain=true
      allowed_name="$candidate"
    else
      unauthorized_domain=true
      unauthorized_name="$candidate"
    fi
  done

  if [[ -n "$dst" ]]; then
    if ip_allowed "$dst"; then
      printf 'ALLOWED|ip-allowlist|%s|-\n' "$dst"
      return 0
    fi
    if [[ "$allowed_domain" == true ]]; then
      printf 'ALLOWED|domain-allowlist|%s|%s\n' "$dst" "$allowed_name"
      return 0
    fi
    if [[ "$unauthorized_domain" == true ]]; then
      printf 'UNAUTHORIZED|domain-not-allowlisted|%s|%s\n' "$dst" "$unauthorized_name"
      return 0
    fi
    printf 'UNAUTHORIZED|ip-not-allowlisted|%s|-\n' "$dst"
    return 0
  fi

  if [[ "$unauthorized_domain" == true ]]; then
    printf 'UNAUTHORIZED|domain-not-allowlisted|-|%s\n' "$unauthorized_name"
    return 0
  fi
  if [[ "$allowed_domain" == true ]]; then
    printf 'ALLOWED|domain-allowlist|-|%s\n' "$allowed_name"
    return 0
  fi
  printf 'UNKNOWN|no-destination|-|-\n'
}

# ---------------------------------------------------------------------------
# Audit log + summary writers
# ---------------------------------------------------------------------------
write_summary() {
  local verdict="$1" backend_used="$2" capture_state="$3" command_label="$4" rc="$5"
  local summary="$EGRESS_LOG_DIR/egress-summary.log"
  {
    echo "=== Build Egress Audit Summary ==="
    echo "timestamp_utc: $(timestamp)"
    echo "command: $command_label"
    echo "backend: $backend_used"
    echo "enforce: $ENFORCE"
    echo "capture: $capture_state"
    echo "allowlist: $(allowlist_counts)"
    echo "lines_total: $LAST_TOTAL"
    echo "allowed: $LAST_ALLOWED"
    echo "unauthorized: $LAST_UNAUTHORIZED"
    echo "unknown: $LAST_UNKNOWN"
    echo "build_exit_code: $rc"
    echo "verdict: $verdict"
    echo "artifacts: $EGRESS_LOG_DIR/egress-capture.log $EGRESS_LOG_DIR/egress-audit.log"
    if (( LAST_UNAUTHORIZED > 0 )) && [[ -r "$EGRESS_LOG_DIR/egress-audit.log" ]]; then
      echo "unauthorized_findings:"
      grep 'verdict=UNAUTHORIZED' "$EGRESS_LOG_DIR/egress-audit.log" | sed 's/^/  - /' || true
    fi
  } > "$summary"
  cat "$summary"
}

# classify_log <file|-> : stream a capture log through the classifier.
# Populates LAST_* counters and appends per-line verdicts to egress-audit.log.
classify_log() {
  local src="${1:--}"
  local input="/dev/stdin"
  if [[ "$src" != "-" && -n "$src" ]]; then
    if [[ ! -r "$src" ]]; then
      echo "EGRESS: capture log not readable: $src" >&2
      return 2
    fi
    input="$src"
  fi

  mkdir -p "$EGRESS_LOG_DIR"
  local audit="$EGRESS_LOG_DIR/egress-audit.log"
  : > "$audit"

  LAST_TOTAL=0
  LAST_ALLOWED=0
  LAST_UNAUTHORIZED=0
  LAST_UNKNOWN=0

  local line out verdict reason dst domain
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "${line// /}" ]] && continue
    LAST_TOTAL=$(( LAST_TOTAL + 1 ))
    out="$(classify_line "$line")"
    IFS='|' read -r verdict reason dst domain <<<"$out"
    printf '%s verdict=%s reason=%s dst=%s domain=%s raw=%s\n' \
      "$(timestamp)" "$verdict" "$reason" "$dst" "$domain" "$line" >> "$audit"
    case "$verdict" in
      ALLOWED) LAST_ALLOWED=$(( LAST_ALLOWED + 1 )) ;;
      UNAUTHORIZED) LAST_UNAUTHORIZED=$(( LAST_UNAUTHORIZED + 1 )) ;;
      *) LAST_UNKNOWN=$(( LAST_UNKNOWN + 1 )) ;;
    esac
  done < "$input"
  return 0
}

# ---------------------------------------------------------------------------
# Capture backends
# ---------------------------------------------------------------------------
select_backend() {
  case "$EGRESS_BACKEND" in
    tcpdump|iptables|none)
      BACKEND="$EGRESS_BACKEND"
      ;;
    auto)
      if command -v tcpdump >/dev/null 2>&1; then
        BACKEND="tcpdump"
      elif command -v iptables >/dev/null 2>&1 && [[ "$(id -u)" -eq 0 ]]; then
        BACKEND="iptables"
      else
        BACKEND="none"
      fi
      ;;
    *)
      echo "EGRESS: unknown backend '$EGRESS_BACKEND'" >&2
      return 2
      ;;
  esac
}

start_tcpdump() {
  local -a cmd=( tcpdump -i any -nn -l -Q out -s 96 'ip or ip6' )
  if [[ "$(id -u)" -ne 0 ]]; then
    if sudo -n true 2>/dev/null; then
      cmd=( sudo -n "${cmd[@]}" )
    else
      return 1
    fi
  fi
  "${cmd[@]}" > "$CAPTURE_LOG" 2> "${CAPTURE_LOG}.err" &
  CAPTURE_PID=$!
  sleep 1
  if ! kill -0 "$CAPTURE_PID" 2>/dev/null; then
    CAPTURE_PID=""
    return 1
  fi
  return 0
}

install_iptables_rules() {
  local entry
  iptables -N EGRESS-MONITOR 2>/dev/null || iptables -F EGRESS-MONITOR
  iptables -A EGRESS-MONITOR -o lo -j RETURN
  iptables -A EGRESS-MONITOR -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN 2>/dev/null \
    || iptables -A EGRESS-MONITOR -m state --state ESTABLISHED,RELATED -j RETURN
  for entry in ${ALLOWLIST_CIDRS[@]+"${ALLOWLIST_CIDRS[@]}"}; do
    [[ "$entry" == *:* ]] && continue
    iptables -A EGRESS-MONITOR -d "$entry" -j RETURN || true
  done
  iptables -A EGRESS-MONITOR -m limit --limit 20/min --limit-burst 40 \
    -j LOG --log-prefix "EGRESS-DENY: " --log-level 4
  if [[ "$ENFORCE" == true ]]; then
    iptables -A EGRESS-MONITOR -j REJECT --reject-with icmp-port-unreachable
  else
    iptables -A EGRESS-MONITOR -j RETURN
  fi
  iptables -I OUTPUT 1 -j EGRESS-MONITOR
  IPTABLES_INSTALLED=true
}

start_iptables() {
  [[ "$(id -u)" -eq 0 ]] || return 1
  install_iptables_rules
}

start_capture() {
  case "$BACKEND" in
    tcpdump) start_tcpdump ;;
    iptables) start_iptables ;;
    none) return 1 ;;
    *) return 1 ;;
  esac
}

collect_iptables_log() {
  [[ "$IPTABLES_INSTALLED" == true ]] || return 0
  {
    dmesg 2>/dev/null | grep 'EGRESS-DENY:' || \
      sudo -n dmesg 2>/dev/null | grep 'EGRESS-DENY:' || true
  } >> "$CAPTURE_LOG"
  return 0
}

stop_capture() {
  if [[ -n "$CAPTURE_PID" ]]; then
    kill "$CAPTURE_PID" 2>/dev/null || true
    wait "$CAPTURE_PID" 2>/dev/null || true
    CAPTURE_PID=""
  fi
  if [[ "$IPTABLES_INSTALLED" == true ]]; then
    iptables -D OUTPUT -j EGRESS-MONITOR 2>/dev/null || true
    iptables -F EGRESS-MONITOR 2>/dev/null || true
    iptables -X EGRESS-MONITOR 2>/dev/null || true
    IPTABLES_INSTALLED=false
  fi
  return 0
}

cleanup() { stop_capture; }

# ---------------------------------------------------------------------------
# Monitor mode: run the build inside a capture window
# ---------------------------------------------------------------------------
run_monitored() {
  prepare_allowlist
  resolve_allowlist_domains

  mkdir -p "$EGRESS_LOG_DIR"
  CAPTURE_LOG="$EGRESS_LOG_DIR/egress-capture.log"
  : > "$CAPTURE_LOG"

  select_backend

  trap cleanup EXIT INT TERM

  local capture_state="ok"
  if ! start_capture; then
    BACKEND="none"
    capture_state="unavailable"
    CAPTURE_LOG="$EGRESS_LOG_DIR/egress-capture.log"
    echo "EGRESS: no packet capture backend available (install tcpdump or run as root)." >&2
    if [[ "$STRICT" == true ]]; then
      echo "EGRESS: --strict set, refusing to run an unmonitored build." >&2
      write_summary "FAIL" "none" "$capture_state" "${CMD[*]}" "-1"
      return 1
    fi
    echo "EGRESS: continuing without capture (use --strict to fail instead)." >&2
  fi

  local build_rc=0
  echo "EGRESS: monitoring '${CMD[*]}' (backend=$BACKEND, enforce=$ENFORCE)"
  set +e
  "${CMD[@]}"
  build_rc=$?
  set -e

  stop_capture
  trap - EXIT INT TERM

  collect_iptables_log

  classify_log "$CAPTURE_LOG"

  local verdict="PASS"
  if (( LAST_UNAUTHORIZED > 0 )) && [[ "$REPORT_ONLY" != true ]]; then
    verdict="FAIL"
  fi

  write_summary "$verdict" "$BACKEND" "$capture_state" "${CMD[*]}" "$build_rc"

  if [[ "$verdict" == "FAIL" ]]; then
    echo "EGRESS: BLOCKED — unauthorized build egress detected ($LAST_UNAUTHORIZED finding(s))." >&2
    return 1
  fi
  if [[ "$IGNORE_COMMAND_EXIT" == true ]]; then
    return 0
  fi
  return "$build_rc"
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
if [[ "${EGRESS_STRICT:-}" == "true" || "${EGRESS_STRICT:-}" == "1" ]]; then
  STRICT=true
fi
if [[ "${EGRESS_REPORT_ONLY:-}" == "true" || "${EGRESS_REPORT_ONLY:-}" == "1" ]]; then
  REPORT_ONLY=true
fi

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --strict) STRICT=true; shift ;;
      --allow-no-capture) STRICT=false; shift ;;
      --report-only) REPORT_ONLY=true; shift ;;
      --ignore-command-exit) IGNORE_COMMAND_EXIT=true; shift ;;
      --enforce) EGRESS_ENFORCE=true; shift ;;
      --no-enforce) EGRESS_ENFORCE=false; shift ;;
      --backend)
        [[ $# -ge 2 ]] || { echo "EGRESS: --backend needs a value" >&2; return 2; }
        EGRESS_BACKEND="$2"; shift 2 ;;
      --allowlist-file)
        [[ $# -ge 2 ]] || { echo "EGRESS: --allowlist-file needs a value" >&2; return 2; }
        EGRESS_ALLOWLIST_FILE="$2"; shift 2 ;;
      --log-dir)
        [[ $# -ge 2 ]] || { echo "EGRESS: --log-dir needs a value" >&2; return 2; }
        EGRESS_LOG_DIR="$2"; shift 2 ;;
      --classify) MODE="classify"; shift ;;
      -h|--help) usage; return 0 ;;
      --) shift; break ;;
      -*) echo "EGRESS: unknown option '$1'" >&2; return 2 ;;
      *) break ;;
    esac
  done
  CMD=("$@")

  case "$EGRESS_ENFORCE" in
    true|1|yes) ENFORCE=true ;;
    *) ENFORCE=false ;;
  esac

  if [[ "$MODE" == "classify" ]]; then
    prepare_allowlist
    local src="${CMD[0]:--}"
    local label="--classify ${CMD[0]:-}"
    classify_log "$src"
    local classify_verdict="PASS"
    if (( LAST_UNAUTHORIZED > 0 )) && [[ "$REPORT_ONLY" != true ]]; then
      classify_verdict="FAIL"
    fi
    write_summary "$classify_verdict" "$EGRESS_BACKEND" "classify-mode" "$label" "-"
    if (( LAST_UNAUTHORIZED > 0 )) && [[ "$REPORT_ONLY" != true ]]; then
      echo "EGRESS: BLOCKED — unauthorized egress in capture log ($LAST_UNAUTHORIZED finding(s))." >&2
      return 1
    fi
    return 0
  fi

  if [[ ${#CMD[@]} -eq 0 ]]; then
    CMD=( npm run build )
  fi
  run_monitored
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
