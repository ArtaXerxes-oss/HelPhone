#!/usr/bin/env bash
set -euo pipefail

scan_lifecycle_scripts() {
  local scan_root="${1:-node_modules}"
  [[ -d "$scan_root" ]] || { echo "Lifecycle scan skipped: $scan_root does not exist"; return 0; }
  node --input-type=module - "$scan_root" <<'NODE'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
const root = process.argv[2]
const rules = [
  ['remote shell pipe', /(?:curl|wget)\b[^\n;&|]*\|\s*(?:sh|bash|zsh)\b/i],
  ['sensitive system-file read', /(?:cat|head|tail|less|more)\s+[^\n;&|]*\/(?:etc\/(?:passwd|shadow)|\.ssh\b)/i],
  ['environment exfiltration', /(?:curl|wget|nc|netcat)\b[^\n]*(?:\$\{?(?:ENV|TOKEN|SECRET|KEY|PASSWORD)|\bprintenv\b)/i],
]
const lifecycle = new Set(['preinstall', 'install', 'postinstall', 'prepublish', 'prepare'])
const findings = []
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (entry.name === 'package.json') {
      let pkg
      try { pkg = JSON.parse(await readFile(path, 'utf8')) } catch { continue }
      for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        if (!lifecycle.has(name) || typeof command !== 'string') continue
        for (const [rule, pattern] of rules) if (pattern.test(command)) findings.push({ package: pkg.name ?? path, script: name, rule })
      }
    }
  }
}
await walk(root)
if (findings.length) {
  console.error('SECURITY: suspicious dependency lifecycle scripts detected')
  for (const finding of findings) console.error(`- ${finding.package}#${finding.script}: ${finding.rule}`)
  process.exit(1)
}
console.log('Dependency lifecycle script scan passed.')
NODE
}

if [[ "${1:-}" == "--scan" ]]; then scan_lifecycle_scripts "${2:-node_modules}"; exit; fi
npm ci --ignore-scripts
scan_lifecycle_scripts node_modules
if [[ "$#" -eq 0 ]]; then echo "Install complete; all lifecycle scripts remained disabled."; exit; fi
for package in "$@"; do
  [[ "$package" =~ ^@?[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)?$ ]] || { echo "Invalid package allowlist entry: $package" >&2; exit 2; }
done
runtime="${CONTAINER_RUNTIME:-}"
if [[ -z "$runtime" ]]; then command -v podman >/dev/null && runtime=podman || runtime=docker; fi
command -v "$runtime" >/dev/null || { echo "docker or podman is required for lifecycle scripts" >&2; exit 2; }
image="${SANDBOX_NODE_IMAGE:-node:22-bookworm-slim}"
"$runtime" image inspect "$image" >/dev/null 2>&1 || { echo "Image $image must be pulled explicitly before the network-isolated run" >&2; exit 2; }
workspace="$(pwd -P)"
"$runtime" run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=128m \
  --user "$(id -u):$(id -g)" --env HOME=/tmp/home \
  --volume "$workspace:/workspace:rw" --workdir /workspace \
  "$image" npm rebuild "$@"
