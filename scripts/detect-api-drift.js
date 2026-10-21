#!/usr/bin/env node
/**
 * detect-api-drift.js — automated dependency version drift & breaking API
 * change analyzer for the build pipeline.
 *
 * Uses the TypeScript Compiler API to extract the exported type surface of a
 * dependency (functions, classes, interfaces, members and call signatures)
 * from its `.d.ts` entry point, then compares the installed surface against
 * the reviewed baseline committed in `package.json` → `apiDrift.baseline`.
 *
 * Findings:
 *   - dropped exports / dropped methods  (removed keys)
 *   - altered parameter or return types  (changed values)
 *   - version drift with no breaking change (reported, not fatal)
 *   - semver-compatible (minor/patch) upgrade that introduces a breaking
 *     signature change  →  Version Pinning Guard fails the build (exit 1)
 *   - non-exact version ranges for protected packages (`--require-exact-pin`)
 *   - Rust half: unpinned version requirements in Cargo.toml
 *     `[workspace.dependencies]` when `require-exact-pin` is set.
 *
 * Usage:
 *   node scripts/detect-api-drift.js [--check|--update] [options]
 *
 * Options:
 *   --check                 Compare installed packages against the baseline
 *                           (default).
 *   --update                Re-extract and write the baseline into package.json.
 *   --packages a,b,c        Override the protected package list.
 *   --root <dir>            Package root to inspect (default: repository root).
 *   --config <file>         tsconfig.json holding `apiDrift.compilerOptions`.
 *   --require-exact-pin     Fail packages declared with ^ / ~ / >= ranges.
 *   --json                  Emit machine-readable JSON instead of a report.
 *   -h, --help              Show this help.
 *
 * Exit codes: 0 clean · 1 drift findings · 2 usage/config error.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");

export const DEFAULT_COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  strict: false,
  skipLibCheck: true,
  noEmit: true,
  esModuleInterop: true,
  allowJs: false,
  checkJs: false,
  resolveJsonModule: false,
  types: [],
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without the compiler)
// ---------------------------------------------------------------------------

function normalizeSpecifier(spec) {
  const marker = "node_modules/";
  const idx = spec.lastIndexOf(marker);
  if (idx !== -1) return spec.slice(idx + marker.length);
  if (spec.startsWith("/") || /^[A-Za-z]:[\\/]/.test(spec)) {
    const parts = spec.split(/[/\\]+/).filter(Boolean);
    return parts.slice(-2).join("/");
  }
  return spec;
}

/**
 * Collapse whitespace and rewrite `import("…")` module specifiers so the same
 * package produces byte-identical signatures on every machine (CI runners,
 * developer laptops, different checkout paths).
 */
export function normalizeSignature(text) {
  if (text === undefined || text === null) return "";
  let out = String(text).replace(/\s+/g, " ").trim();
  out = out.replace(/import\(\s*(["'])([^"']*)\1\s*\)/g, (_m, q, spec) => `import(${q}${normalizeSpecifier(spec)}${q})`);
  out = out.replace(/\btypeof import\(/g, "typeof import(");
  return out;
}

/**
 * TypeScript renders well-known symbol members as `__@captureRejectionSymbol@123`
 * where the trailing number is an internal id that changes between TS versions.
 * Those names are not part of a package's authored API surface — drop them.
 */
export function isInternalMemberName(name) {
  return typeof name === "string" && name.includes("@");
}

function parseVersion(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? "" };
}

/** 'major' | 'minor' | 'patch' | 'none' | 'downgrade' | 'unknown' */
export function classifyUpgrade(from, to) {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return "unknown";
  if (a.major !== b.major) return b.major > a.major ? "major" : "downgrade";
  if (a.minor !== b.minor) return b.minor > a.minor ? "minor" : "downgrade";
  if (a.patch !== b.patch) return b.patch > a.patch ? "patch" : "downgrade";
  if (a.prerelease !== b.prerelease) return "none";
  return "none";
}

/** npm: "1.2.3" is exact; "^1.2.3", "~1.2.3", ">=1.2.3", "1.x" are not. */
export function isExactNpmPin(range) {
  if (typeof range !== "string") return false;
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(range.trim());
}

/** Cargo: only "=1.2.3" is exact — a bare "1.2.3" means "^1.2.3". */
export function isExactCargoPin(requirement) {
  if (typeof requirement !== "string") return false;
  return /^=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requirement.trim());
}

/**
 * @param {Record<string,string>} before reviewed surface
 * @param {Record<string,string>} after installed surface
 * @returns {{breaking: Array, additive: Array}}
 *   breaking: dropped (`removed`) or re-typed (`changed`) signatures.
 *   additive: brand-new signatures (never a compatibility break).
 */
export function diffSurface(before = {}, after = {}) {
  const breaking = [];
  const additive = [];
  for (const key of Object.keys(before)) {
    if (!Object.prototype.hasOwnProperty.call(after, key)) {
      breaking.push({ type: "removed", key, before: before[key] });
    } else if (before[key] !== after[key]) {
      breaking.push({ type: "changed", key, before: before[key], after: after[key] });
    }
  }
  for (const key of Object.keys(after)) {
    if (!Object.prototype.hasOwnProperty.call(before, key)) {
      additive.push({ type: "added", key, after: after[key] });
    }
  }
  return { breaking, additive };
}

/**
 * Version Pinning Guard: a semver-compatible upgrade may never change the
 * public type surface. Major upgrades are allowed to break (reported as a
 * warning), everything else is an error.
 */
export function evaluateDrift({
  name,
  range = "",
  baselineVersion = null,
  baselineTypesVersion = null,
  installedVersion = null,
  typesPackage = null,
  typesVersion = null,
  breaking = [],
  additive = [],
  hasBaseline = true,
  requireExactPin = false,
}) {
  const findings = [];
  const effective = typesVersion || installedVersion || baselineVersion || null;
  // The type surface comes from @types/<name> when a package does not bundle
  // its own declarations: in that case the meaningful version pair is the
  // types-package version, otherwise the runtime package version.
  const typeDrift = Boolean(baselineTypesVersion && typesVersion && baselineTypesVersion !== typesVersion);
  const from = typeDrift ? baselineTypesVersion : baselineVersion ?? installedVersion;
  const to = typeDrift ? typesVersion : installedVersion ?? typesVersion;
  const upgrade = classifyUpgrade(from, to);
  const hint = typeDrift
    ? `Pin ${typesPackage ?? "the types package"} to "${baselineTypesVersion}" or re-baseline after reviewing the full diff.`
    : `Pin ${name} to "${baselineVersion ?? "the reviewed version"}" or re-baseline after reviewing the full diff.`;

  if (!hasBaseline) {
    findings.push({
      level: "error",
      code: "missing-baseline",
      message: `${name}: no baseline recorded — run \`npm run security:api-drift:update\` and review the diff before committing`,
    });
  } else if (breaking.length > 0) {
    const compatible = upgrade === "none" || upgrade === "minor" || upgrade === "patch";
    const detail = breaking
      .slice(0, 3)
      .map((b) => (b.type === "removed" ? `-${b.key}` : `~${b.key}`))
      .join(", ");
    const more = breaking.length > 3 ? ` (+${breaking.length - 3} more)` : "";
    if (compatible) {
      findings.push({
        level: "error",
        code: "breaking-compatible-upgrade",
        message:
          `${name}: breaking API change in a ${upgrade} upgrade ` +
          `(${from} → ${to})${typeDrift ? ` via ${typesPackage}` : ""}: ${detail}${more}. ${hint}`,
      });
    } else if (upgrade === "major") {
      findings.push({
        level: "warning",
        code: "breaking-major-upgrade",
        message: `${name}: breaking API change in major upgrade ${from} → ${to}: ${detail}${more} (expected for a major bump — re-baseline after migrating call sites)`,
      });
    } else {
      findings.push({
        level: "error",
        code: "breaking-unexpected-version-change",
        message: `${name}: breaking API change while the version moved ${upgrade} (${from} → ${to}): ${detail}${more}`,
      });
    }
  }

  if (requireExactPin && range && !isExactNpmPin(range)) {
    findings.push({
      level: "error",
      code: "range-not-exact",
      message: `${name}: declared range "${range}" allows automatic minor upgrades — pin it exactly ("${installedVersion ?? baselineVersion ?? "<version>"}")`,
    });
  }

  return {
    name,
    range,
    baselineVersion,
    baselineTypesVersion,
    installedVersion,
    typesPackage,
    typesVersion,
    effectiveVersion: effective,
    upgrade,
    breaking,
    additive,
    findings,
    ok: !findings.some((f) => f.level === "error"),
  };
}

// ---------------------------------------------------------------------------
// Minimal TOML reader (comments, sections, multi-line arrays, inline tables)
// ---------------------------------------------------------------------------

function tomlLogicalLines(text) {
  const lines = [];
  let buf = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "\n" && depth === 0) {
      lines.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) lines.push(buf);
  return lines;
}

function parseTomlValue(raw) {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map(parseTomlValue);
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const inner = value.slice(1, -1).trim();
    const table = {};
    for (const pair of splitTopLevel(inner)) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      table[pair.slice(0, eq).trim().replace(/^["']|["']$/g, "")] = parseTomlValue(pair.slice(eq + 1));
    }
    return table;
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function splitTopLevel(text) {
  const parts = [];
  let buf = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

/**
 * Parse the subset of TOML used by Cargo manifests.
 * @returns {{sections: Record<string, Record<string, unknown>>, error: string|null}}
 */
export function parseCargoManifest(text) {
  const sections = {};
  let current = null;
  for (const raw of tomlLogicalLines(text)) {
    const line = raw.trim();
    if (!line) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = header[1].trim();
      if (!sections[current]) sections[current] = {};
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*([\s\S]+)$/);
    if (!kv) return { sections, error: `unparsable line: ${line}` };
    if (!current) return { sections, error: `key outside of a section: ${line}` };
    sections[current][kv[1]] = parseTomlValue(kv[2]);
  }
  return { sections, error: null };
}

const DEP_SECTIONS = ["workspace.dependencies", "dependencies", "dev-dependencies"];

/**
 * Rust half of the version pinning guard.
 * @param {string} text Cargo.toml contents
 * @param {{requireExactPin?: boolean, protectedCrates?: string[]}} [overrides]
 */
export function checkCargoPinning(text, overrides = {}) {
  const { sections, error } = parseCargoManifest(text);
  const findings = [];
  if (error) {
    findings.push({ level: "error", code: "invalid-manifest", message: `Cargo.toml: ${error}` });
    return { ok: false, findings, config: null };
  }

  const meta = sections["workspace.metadata.api-drift"];
  if (!meta) {
    findings.push({
      level: "error",
      code: "missing-guard-config",
      message: "Cargo.toml: missing [workspace.metadata.api-drift] (require-exact-pin / protected-crates)",
    });
    return { ok: false, findings, config: null };
  }

  const requireExactPin = overrides.requireExactPin ?? Boolean(meta["require-exact-pin"]);
  const protectedCrates = overrides.protectedCrates ?? (Array.isArray(meta["protected-crates"]) ? meta["protected-crates"] : []);
  const config = { requireExactPin, protectedCrates };

  for (const section of DEP_SECTIONS) {
    const deps = sections[section];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      const requirement =
        spec && typeof spec === "object" && !Array.isArray(spec) ? String(spec.version ?? "") : String(spec ?? "");
      const mustPin = requireExactPin || protectedCrates.includes(name);
      if (!requirement) continue;
      if (mustPin && !isExactCargoPin(requirement)) {
        findings.push({
          level: "error",
          code: "range-not-exact",
          message: `Cargo.toml [${section}] ${name} = "${requirement}" — use "=${requirement.replace(/^=/, "")}" so cargo update cannot pull a semver-compatible API change`,
        });
      }
    }
  }

  return { ok: !findings.some((f) => f.level === "error"), findings, config };
}

// ---------------------------------------------------------------------------
// TypeScript API surface extraction
// ---------------------------------------------------------------------------

function createHost(files, options) {
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    if (Object.prototype.hasOwnProperty.call(files, fileName)) {
      const text = files[fileName];
      const kind = fileName.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : fileName.endsWith(".js") || fileName.endsWith(".mjs")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
      return ts.createSourceFile(fileName, text, languageVersionOrOptions, true, kind);
    }
    return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
  };
  const originalFileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) =>
    Object.prototype.hasOwnProperty.call(files, fileName) || originalFileExists(fileName);
  const originalReadFile = host.readFile.bind(host);
  host.readFile = (fileName) =>
    Object.prototype.hasOwnProperty.call(files, fileName) ? files[fileName] : originalReadFile(fileName);
  return host;
}

function resolveAlias(symbol, checker) {
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      const target = checker.getAliasedSymbol(symbol);
      if (target && target.flags && !(target.flags & ts.SymbolFlags.Unknown)) return target;
    } catch {
      /* fall through to the alias itself */
    }
  }
  return symbol;
}

function declarationKind(decl) {
  if (!decl) return "value";
  if (ts.isClassDeclaration(decl)) return "class";
  if (ts.isInterfaceDeclaration(decl)) return "interface";
  if (ts.isTypeAliasDeclaration(decl)) return "type";
  if (ts.isFunctionDeclaration(decl)) return "function";
  if (ts.isEnumDeclaration(decl)) return "enum";
  if (ts.isModuleDeclaration(decl)) return "namespace";
  if (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl)) return "const";
  if (ts.isExportSpecifier(decl) || ts.isExportAssignment(decl)) return "value";
  return "value";
}

function describeSymbol(symbol, baseKey, surface, checker, fallbackNode) {
  if (!symbol) return;
  const decls = symbol.getDeclarations() || [];
  const decl = decls[0] || fallbackNode;
  const kind = declarationKind(decls[0]);

  const valueType = checker.getTypeOfSymbolAtLocation(symbol, decl || fallbackNode);
  const callSignatures = valueType.getCallSignatures();

  if (kind === "class" || kind === "interface" || kind === "type" || kind === "namespace" || kind === "enum") {
    const declared = checker.getDeclaredTypeOfSymbol(symbol);
    const summary = normalizeSignature(checker.typeToString(declared));
    surface[baseKey] = `${kind}: ${summary}`.trim();

    if (kind === "enum" && decls.some(ts.isEnumDeclaration)) {
      const enumDecl = decls.find(ts.isEnumDeclaration);
      for (const member of enumDecl.members) {
        const memberName = member.name && ts.isIdentifier(member.name) ? member.name.text : null;
        if (memberName) surface[`${baseKey}.${memberName}`] = "enum-member";
      }
      return;
    }

    if (kind === "class" || kind === "interface") {
      for (const prop of checker.getPropertiesOfType(declared)) {
        if (isInternalMemberName(prop.getName())) continue;
        const propDecl = (prop.getDeclarations() || [])[0] || decl;
        const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : "";
        const text = normalizeSignature(checker.typeToString(checker.getTypeOfSymbolAtLocation(prop, propDecl)));
        surface[`${baseKey}.${prop.getName()}`] = `${optional}${text}`.trim();
      }
      for (const ctor of declared.getConstructSignatures()) {
        surface[`${baseKey}.new`] = normalizeSignature(checker.signatureToString(ctor));
      }
    }

    if (kind === "interface" || kind === "type" || kind === "namespace") {
      callSignatures.forEach((sig, index) => {
        const key = index === 0 ? `${baseKey}.call` : `${baseKey}.call${index + 1}`;
        surface[key] = normalizeSignature(checker.signatureToString(sig));
      });
      if (kind === "namespace") {
        for (const prop of valueType.getProperties()) {
          if (isInternalMemberName(prop.getName())) continue;
          const propDecl = (prop.getDeclarations() || [])[0] || decl;
          const text = normalizeSignature(checker.typeToString(checker.getTypeOfSymbolAtLocation(prop, propDecl)));
          surface[`${baseKey}.${prop.getName()}`] = text;
        }
      }
    }
    return;
  }

  if (callSignatures.length > 0) {
    surface[baseKey] = `function: ${normalizeSignature(checker.signatureToString(callSignatures[0]))}`;
    callSignatures.forEach((sig, index) => {
      if (index === 0) return;
      surface[`${baseKey}#${index}`] = `function: ${normalizeSignature(checker.signatureToString(sig))}`;
    });
    return;
  }

  surface[baseKey] = `${kind}: ${normalizeSignature(checker.typeToString(valueType))}`.trim();
}

function sortKeys(surface) {
  const sorted = {};
  for (const key of Object.keys(surface).sort()) sorted[key] = surface[key];
  return sorted;
}

/**
 * Extract the exported API surface of a program's entry file.
 * Works from in-memory `files` (fixtures in tests) and/or the real filesystem.
 */
export function extractSurface({ entryFile, files = {}, compilerOptions = {} }) {
  const options = { ...DEFAULT_COMPILER_OPTIONS, ...compilerOptions };
  const program = ts.createProgram([entryFile], options, createHost(files, options));
  return describeProgramEntry(program, entryFile);
}

/** Describe one entry file of an existing program (shared program for speed). */
export function describeProgramEntry(program, entryFile) {
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(entryFile);
  if (!sourceFile) throw new Error(`type entry not found: ${entryFile}`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) throw new Error(`no module symbol for: ${entryFile}`);

  const surface = {};
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const name = exported.getName();
    if (name === "default" || isInternalMemberName(name)) continue;
    describeSymbol(resolveAlias(exported, checker), name, surface, checker, sourceFile);
  }

  // `export = foo` modules (common in @types): the callable/class the module
  // itself resolves to is not part of the export list.
  const exportEquals = moduleSymbol.exports ? moduleSymbol.exports.get("export=") : undefined;
  if (exportEquals) {
    describeSymbol(resolveAlias(exportEquals, checker), "module", surface, checker, sourceFile);
  }

  return sortKeys(surface);
}

// ---------------------------------------------------------------------------
// Package resolution
// ---------------------------------------------------------------------------

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findPackageDir(pkgName, require_) {
  try {
    return path.dirname(require_.resolve(`${pkgName}/package.json`));
  } catch {
    /* package.json hidden by "exports" — fall back to the entry point */
  }
  let entry;
  try {
    entry = require_.resolve(pkgName);
  } catch {
    return null;
  }
  if (!isFile(entry)) entry = path.join(entry, "index.js");
  // Walk up from the entry point. Bundles ship type-marker package.json files
  // (`lib/cjs/package.json`, `lib/esm/package.json`) that must not stop the walk,
  // so only a manifest with a `name` identifies the package root.
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    const manifestPath = path.join(dir, "package.json");
    if (isFile(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (manifest && typeof manifest.name === "string" && manifest.name) return dir;
      } catch {
        /* unreadable or invalid manifest — keep walking */
      }
    }
    dir = path.dirname(dir);
  }
  return null;
}

function typesPackageName(pkgName) {
  if (pkgName.startsWith("@types/")) return pkgName;
  if (pkgName.startsWith("@")) return `@types/${pkgName.slice(1).replace("/", "__")}`;
  return `@types/${pkgName}`;
}

/**
 * Locate the `.d.ts` entry point for a package: its own bundled types first,
 * then DefinitelyTyped. Returns null when the package has no types at all.
 */
export function resolveTypesEntry(pkgName, root = REPO_ROOT) {
  const require_ = createRequire(path.join(path.resolve(root), "noop.js"));
  const dir = findPackageDir(pkgName, require_);
  if (!dir) return null;

  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }

  const candidates = [];
  if (manifest.types) candidates.push(manifest.types);
  if (manifest.typings) candidates.push(manifest.typings);
  const exportsField = manifest.exports;
  const entryExport = exportsField && typeof exportsField === "object" ? (exportsField["."] ?? exportsField) : null;
  if (entryExport && typeof entryExport === "object" && typeof entryExport.types === "string") {
    candidates.push(entryExport.types);
  }
  if (manifest.main) {
    candidates.push(manifest.main.replace(/\.(c|m)?js$/, ".d.$1ts"));
    candidates.push(manifest.main.replace(/\.(c|m)?js$/, ".d.ts"));
    candidates.push(path.join(path.dirname(manifest.main), "index.d.ts"));
  }
  candidates.push("index.d.ts");
  for (const candidate of candidates) {
    const file = path.resolve(dir, candidate);
    if (isFile(file)) return file;
  }

  if (pkgName.startsWith("@types/")) return null;
  return resolveTypesEntry(typesPackageName(pkgName), root);
}

/** Installed version + type-provider metadata for a package. */
export function readPackageMeta(pkgName, root = REPO_ROOT) {
  const require_ = createRequire(path.join(path.resolve(root), "noop.js"));
  const dir = findPackageDir(pkgName, require_);
  if (!dir) return null;
  const read = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(name, "package.json"), "utf8"));
    } catch {
      return null;
    }
  };
  const manifest = read(dir) || {};
  const entry = resolveTypesEntry(pkgName, root);
  let typesPackage = null;
  let typesVersion = null;
  if (entry) {
    // Who owns the declarations? DefinitelyTyped packages keep them in
    // node_modules/@types/<name>, a *different* package than `pkgName`, so
    // walk up from the .d.ts to the nearest manifest and stop at our own dir.
    let owner = path.dirname(entry);
    while (owner && owner !== dir && !isFile(path.join(owner, "package.json"))) {
      const parent = path.dirname(owner);
      if (parent === owner) break;
      owner = parent;
    }
    if (owner && owner !== dir && isFile(path.join(owner, "package.json"))) {
      const ownerManifest = read(owner);
      if (ownerManifest) {
        typesPackage = ownerManifest.name ?? null;
        typesVersion = ownerManifest.version ?? null;
      }
    }
  }
  return {
    version: manifest.version ?? null,
    entry,
    typesPackage: typesPackage && typesPackage !== pkgName ? typesPackage : null,
    typesVersion,
  };
}

/**
 * Extract surfaces for several packages with one shared program.
 * @returns {Record<string, {surface: Record<string,string>, meta: object}>}
 */
export function extractPackageSurfaces(packages, { root = REPO_ROOT, compilerOptions = {} } = {}) {
  const entries = [];
  const skipped = {};
  for (const pkg of packages) {
    const meta = readPackageMeta(pkg, root);
    if (!meta || !meta.entry) {
      skipped[pkg] = "no TypeScript declarations found";
      continue;
    }
    entries.push({ pkg, meta });
  }
  const options = { ...DEFAULT_COMPILER_OPTIONS, ...compilerOptions };
  const program = ts.createProgram(
    entries.map((e) => e.meta.entry),
    options,
    createHost({}, options),
  );
  const out = {};
  for (const { pkg, meta } of entries) {
    out[pkg] = { surface: describeProgramEntry(program, meta.entry), meta };
  }
  return { surfaces: out, skipped };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function readJsonc(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  if (filePath.endsWith(".json")) {
    const parsed = ts.readConfigFile(filePath, (p) => fs.readFileSync(p, "utf8"));
    if (parsed.error) throw new Error(`failed to parse ${filePath}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, " ")}`);
    return parsed.config ?? {};
  }
  return JSON.parse(raw);
}

/**
 * Merge tool configuration:
 *   - `apiDrift.compilerOptions` from tsconfig.json  (extraction program)
 *   - `apiDrift` from <root>/package.json            (packages + baseline)
 */
export function loadConfig({ root = REPO_ROOT, configPath = null } = {}) {
  const manifestPath = path.join(path.resolve(root), "package.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`no package.json under ${root}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const candidates = [configPath, path.join(path.resolve(root), "tsconfig.json"), path.join(REPO_ROOT, "tsconfig.json")].filter(
    Boolean,
  );
  const tsconfigPath = candidates.find((p) => fs.existsSync(p));
  const tsconfig = tsconfigPath ? readJsonc(tsconfigPath) : {};

  const fromTsconfig = tsconfig.apiDrift ?? {};
  const fromManifest = manifest.apiDrift ?? {};

  let compilerOptions = {};
  if (fromTsconfig.compilerOptions) {
    const converted = ts.convertCompilerOptionsFromJson(fromTsconfig.compilerOptions, path.dirname(tsconfigPath ?? REPO_ROOT));
    if (converted.errors.length) {
      const first = ts.flattenDiagnosticMessageText(converted.errors[0].messageText, " ");
      throw new Error(`apiDrift.compilerOptions in ${tsconfigPath}: ${first}`);
    }
    compilerOptions = converted.options;
  }

  return {
    root: path.resolve(root),
    manifestPath,
    manifest,
    tsconfigPath,
    packages: fromManifest.packages ?? fromTsconfig.packages ?? [],
    baseline: fromManifest.baseline ?? {},
    requireExactPin: Boolean(fromManifest.requireExactPin ?? fromTsconfig.requireExactPin ?? false),
    compilerOptions,
  };
}

// ---------------------------------------------------------------------------
// Check / update orchestration
// ---------------------------------------------------------------------------

function sortObject(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

/**
 * Compare installed surfaces against the committed baseline.
 * @returns {{results: Array, cargo: object|null, ok: boolean}}
 */
export function runCheck({ root = REPO_ROOT, configPath = null, packages: packageOverride = null, requireExactPin = null } = {}) {
  const config = loadConfig({ root, configPath });
  const packages = packageOverride ?? config.packages;
  const pinning = requireExactPin ?? config.requireExactPin;
  const { surfaces, skipped } = extractPackageSurfaces(packages, { root: config.root, compilerOptions: config.compilerOptions });

  const results = packages.map((pkg) => {
    const range = config.manifest.dependencies?.[pkg] ?? config.manifest.devDependencies?.[pkg] ?? "";
    const baselineEntry = config.baseline[pkg];
    const meta = surfaces[pkg]?.meta ?? null;

    if (!meta) {
      const reason = skipped[pkg] ?? "package not installed";
      const drift = evaluateDrift({
        name: pkg,
        range,
        baselineVersion: baselineEntry?.version ?? null,
        installedVersion: null,
        breaking: [],
        additive: [],
        // The finding below already carries the whole story for this branch.
        hasBaseline: true,
        requireExactPin: pinning,
      });
      drift.skipped = reason;
      drift.findings.push({
        level: "error",
        code: "types-unavailable",
        message: `${pkg}: ${reason}${baselineEntry ? "" : " (and no baseline recorded)"}`,
      });
      drift.ok = false;
      return drift;
    }

    const { breaking, additive } = diffSurface(baselineEntry?.surface ?? {}, surfaces[pkg].surface);
    return evaluateDrift({
      name: pkg,
      range,
      baselineVersion: baselineEntry?.version ?? null,
      baselineTypesVersion: baselineEntry?.typesVersion ?? null,
      installedVersion: meta.version,
      typesPackage: meta.typesPackage,
      typesVersion: meta.typesVersion,
      breaking,
      additive,
      hasBaseline: Boolean(baselineEntry),
      requireExactPin: pinning,
    });
  });

  const cargo = checkRepoCargoManifest(config.root);
  const ok = results.every((r) => r.ok) && (cargo ? cargo.ok : true);
  return { config, results, cargo, ok, surfaces };
}

function checkRepoCargoManifest(root) {
  const cargoPath = path.join(root, "Cargo.toml");
  if (!fs.existsSync(cargoPath)) return null;
  return checkCargoPinning(fs.readFileSync(cargoPath, "utf8"));
}

/** Re-extract the surfaces and write them back into package.json (merges into any existing baseline). */
export function runUpdate({ root = REPO_ROOT, configPath = null, packages: packageOverride = null } = {}) {
  const config = loadConfig({ root, configPath });
  const requested = packageOverride ?? config.packages;
  const { surfaces, skipped } = extractPackageSurfaces(requested, { root: config.root, compilerOptions: config.compilerOptions });

  const next = JSON.parse(fs.readFileSync(config.manifestPath, "utf8"));
  const apiDrift = { ...(next.apiDrift ?? {}) };
  const packages = [...(apiDrift.packages ?? [])];
  const baseline = { ...(apiDrift.baseline ?? {}) };

  for (const pkg of requested) {
    const found = surfaces[pkg];
    if (!found) {
      throw new Error(`${pkg}: cannot baseline — ${skipped[pkg] ?? "package not installed"}`);
    }
    baseline[pkg] = {
      version: found.meta.version,
      ...(found.meta.typesPackage ? { typesPackage: found.meta.typesPackage, typesVersion: found.meta.typesVersion } : {}),
      surface: sortObject(found.surface),
    };
    if (!packages.includes(pkg)) packages.push(pkg);
  }

  apiDrift.packages = packages;
  apiDrift.baseline = sortObject(baseline);
  next.apiDrift = apiDrift;
  fs.writeFileSync(config.manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  return { manifestPath: config.manifestPath, baseline, count: requested.length };
}

// ---------------------------------------------------------------------------
// Reporting / CLI
// ---------------------------------------------------------------------------

function formatResult(result) {
  const via = result.typesPackage
    ? ` via ${result.typesPackage}${result.typesVersion ? `@${result.typesVersion}` : ""}`
    : "";
  const head = `  ${result.name.padEnd(24)} ${result.installedVersion ?? "(not installed)"}${via}  baseline ${result.baselineVersion ?? "—"}  (${result.upgrade}${
    result.breaking.length ? `, ${result.breaking.length} breaking` : ""
  }, ${result.additive.length} added)`;
  const lines = [head];
  for (const finding of result.findings) {
    lines.push(`    [${finding.level}] ${finding.message}`);
  }
  for (const b of result.breaking.slice(0, 10)) {
    if (b.type === "removed") lines.push(`    - removed  ${b.key}: ${b.before}`);
    else lines.push(`    ~ changed  ${b.key}: ${b.before}  →  ${b.after}`);
  }
  if (result.breaking.length > 10) lines.push(`    … ${result.breaking.length - 10} more breaking signatures`);
  return lines.join("\n");
}

function formatReport({ results, cargo, ok }) {
  const lines = ["API drift report", "================"];
  for (const result of results) lines.push(formatResult(result));
  if (cargo) {
    lines.push("", "Rust version pinning guard", "--------------------------");
    if (cargo.findings.length === 0) lines.push("  Cargo.toml pinned as configured.");
    for (const finding of cargo.findings) lines.push(`    [${finding.level}] ${finding.message}`);
  }
  lines.push("", `verdict: ${ok ? "PASS — no unreviewed breaking API changes" : "FAIL — breaking API change or unpinned version range detected"}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const opts = { mode: "check", json: false, packages: null, root: REPO_ROOT, configPath: null, requireExactPin: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--check":
        opts.mode = "check";
        break;
      case "--update":
        opts.mode = "update";
        break;
      case "--packages":
        opts.packages = next()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--root":
        opts.root = path.resolve(next());
        break;
      case "--config":
        opts.configPath = path.resolve(next());
        break;
      case "--require-exact-pin":
        opts.requireExactPin = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "-h":
      case "--help":
        opts.mode = "help";
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

function usage() {
  const header = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const lines = header.split("\n");
  const start = lines.findIndex((line) => line.startsWith("/**"));
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith(" *") || line.trim() === "*/") break;
    out.push(line.replace(/^ \* ?/, ""));
  }
  return out.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`api-drift: ${err.message}`);
    return 2;
  }
  if (opts.mode === "help") {
    console.log(usage());
    return 0;
  }

  try {
    if (opts.mode === "update") {
      const { manifestPath, count } = runUpdate({
        root: opts.root,
        configPath: opts.configPath,
        packages: opts.packages,
      });
      console.log(`api-drift: baseline updated for ${count} package(s) → ${path.relative(REPO_ROOT, manifestPath)}`);
      return 0;
    }

    const outcome = runCheck({
      root: opts.root,
      configPath: opts.configPath,
      packages: opts.packages,
      requireExactPin: opts.requireExactPin,
    });
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: outcome.ok,
            results: outcome.results.map((r) => ({
              name: r.name,
              baselineVersion: r.baselineVersion,
              installedVersion: r.installedVersion,
              typesPackage: r.typesPackage,
              typesVersion: r.typesVersion,
              upgrade: r.upgrade,
              breaking: r.breaking,
              additiveCount: r.additive.length,
              findings: r.findings,
              ok: r.ok,
            })),
            cargo: outcome.cargo,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(formatReport(outcome));
    }
    return outcome.ok ? 0 : 1;
  } catch (err) {
    console.error(`api-drift: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
