/**
 * server/env.js — Centralized environment validation (ESM JS version)
 * Mirrors server/env.ts for runtime when using server/index.js
 */

export const CORS_MAX_AGE = 86400;

const DEFAULT_ALLOWED_ORIGINS = [
  "https://helphone.com",
  "https://staging.helphone.com",
];

export function escapeOriginPattern(pattern) {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileOriginPattern(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const isExplicitRegex =
    /\\|\.\*|^\^|\$$/.test(trimmed) || trimmed.startsWith("^");
  let source;
  if (isExplicitRegex) {
    source = trimmed;
    if (!source.startsWith("^")) source = "^" + source;
    if (!source.endsWith("$")) source = source + "$";
  } else if (trimmed.includes("*")) {
    const escaped = trimmed.split("*").map(escapeOriginPattern).join(".*");
    source = `^${escaped}$`;
  } else {
    source = `^${escapeOriginPattern(trimmed)}$`;
  }
  try {
    return new RegExp(source);
  } catch {
    try {
      return new RegExp(`^${escapeOriginPattern(trimmed)}$`);
    } catch {
      return null;
    }
  }
}

export function parseAllowedOrigins(raw) {
  if (!raw || !raw.trim()) return [...DEFAULT_ALLOWED_ORIGINS];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getAllowedOriginPatterns() {
  const raw = process.env.ALLOWED_ORIGINS;
  return parseAllowedOrigins(raw);
}

export function getAllowedOriginRegexes() {
  const patterns = getAllowedOriginPatterns();
  return patterns.map(compileOriginPattern).filter(Boolean);
}

export function validateCorsEnv() {
  const patterns = getAllowedOriginPatterns();
  const regexes = [];
  const invalid = [];
  for (const p of patterns) {
    const re = compileOriginPattern(p);
    if (!re) invalid.push(p);
    else regexes.push(re);
  }
  if (invalid.length) {
    throw new Error(`Invalid ALLOWED_ORIGINS entries: ${invalid.join(", ")}`);
  }
  return { patterns, regexes };
}

export function getCorsConfig() {
  return {
    maxAge: CORS_MAX_AGE,
    allowedOrigins: getAllowedOriginPatterns(),
    allowedRegexes: getAllowedOriginRegexes(),
    allowedMethods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
    ],
  };
}
