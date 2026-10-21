#!/usr/bin/env node
// Scan node_modules for native binaries (ELF / Mach-O / PE) and shell scripts,
// and check each against the sha256 whitelist in config/binary_whitelist.json.
//
//   node scripts/security/strip_executables.js                   report, exit 1 on unapproved
//   node scripts/security/strip_executables.js --strip           delete unapproved files
//   node scripts/security/strip_executables.js --write-whitelist approve everything found now
//
// The build toolchain (rolldown, esbuild, lightningcss, ...) ships native
// binaries, so deletion is opt-in. Whitelist hashes are per-platform: approve
// on each OS/arch you build on.
import { createHash } from "node:crypto";
import {
  lstatSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const WHITELIST_PATH = join(ROOT, "config/binary_whitelist.json");

const MAGIC = [
  ["ELF", [0x7f, 0x45, 0x4c, 0x46]],
  ["Mach-O", [0xfe, 0xed, 0xfa, 0xce]],
  ["Mach-O", [0xfe, 0xed, 0xfa, 0xcf]],
  ["Mach-O", [0xce, 0xfa, 0xed, 0xfe]],
  ["Mach-O", [0xcf, 0xfa, 0xed, 0xfe]],
  ["Mach-O", [0xca, 0xfe, 0xba, 0xbe]], // universal (also Java .class — both are executable code)
  ["PE", [0x4d, 0x5a]],
];
const SHELL_SHEBANG = /^#!\s*\S*\b(?:env\s+)?(?:ba|z|da|k)?sh\b/;
const SHELL_EXT = /\.(?:sh|bash|bat|cmd|ps1)$/i;

/** Classify a file by header; returns kind string or null. */
export function classify(path) {
  const buf = Buffer.alloc(64);
  const fd = openSync(path, "r");
  const n = readSync(fd, buf, 0, 64, 0);
  closeSync(fd);
  for (const [kind, sig] of MAGIC) {
    if (n >= sig.length && sig.every((b, i) => buf[i] === b)) return kind;
  }
  if (SHELL_EXT.test(path)) return "shell";
  if (SHELL_SHEBANG.test(buf.subarray(0, n).toString("latin1").split("\n")[0]))
    return "shell";
  return null;
}

export function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue; // .bin links point at files scanned elsewhere
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Returns [{ path, kind, sha256, approved }] for every executable under `dir`. */
export function scan(dir, whitelist = {}) {
  const found = [];
  for (const path of walk(dir)) {
    if (lstatSync(path).size < 2) continue;
    const kind = classify(path);
    if (!kind) continue;
    const sha256 = sha256File(path);
    found.push({
      path,
      kind,
      sha256,
      approved: Object.hasOwn(whitelist, sha256),
    });
  }
  return found;
}

function main(argv) {
  const nodeModules = join(ROOT, "node_modules");
  let whitelist = {};
  try {
    whitelist = JSON.parse(readFileSync(WHITELIST_PATH, "utf8")).binaries || {};
  } catch {
    /* no whitelist yet */
  }

  const found = scan(nodeModules, whitelist);
  const rel = (p) => relative(ROOT, p);

  if (argv.includes("--write-whitelist")) {
    const binaries = Object.fromEntries(
      found
        .map((f) => [f.sha256, `${f.kind} ${rel(f.path)}`])
        .sort(([, a], [, b]) => a.localeCompare(b)),
    );
    writeFileSync(WHITELIST_PATH, JSON.stringify({ binaries }, null, 2) + "\n");
    console.log(
      `Approved ${found.length} executables → ${rel(WHITELIST_PATH)}`,
    );
    return 0;
  }

  const unapproved = found.filter((f) => !f.approved);
  console.log(
    `Scanned node_modules: ${found.length} executables, ${unapproved.length} unapproved`,
  );
  for (const f of unapproved) {
    console.log(
      `  ${argv.includes("--strip") ? "REMOVED" : "UNAPPROVED"} [${f.kind}] ${rel(f.path)} sha256:${f.sha256}`,
    );
    if (argv.includes("--strip")) rmSync(f.path);
  }
  return unapproved.length && !argv.includes("--strip") ? 1 : 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main(process.argv.slice(2)));
}
