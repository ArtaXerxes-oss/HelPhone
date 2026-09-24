/**
 * server/middleware/cors.js — JS version for Node runtime (mirrors cors.ts)
 */

import {
  CORS_MAX_AGE,
  getAllowedOriginRegexes,
  getAllowedOriginPatterns,
  compileOriginPattern,
  parseAllowedOrigins,
} from "../env.js";

export const MAX_AGE = CORS_MAX_AGE;
export const DEFAULT_ALLOWED_ORIGINS = [
  "https://helphone.com",
  "https://staging.helphone.com",
];

export const ALLOWED_METHODS = ["GET", "POST", "OPTIONS"];
export const ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Requested-With",
  "Accept",
];

export function isOriginAllowed(origin, regexes) {
  if (!origin || typeof origin !== "string") return false;
  const trimmed = origin.trim();
  if (!trimmed) return false;
  return regexes.some((re) => re.test(trimmed));
}

export function buildOriginRegexes(input) {
  const patterns =
    typeof input === "string" ? parseAllowedOrigins(input) : input;
  return patterns.map(compileOriginPattern).filter(Boolean);
}

export function createCorsMiddleware(opts = {}) {
  const patterns = opts.allowedPatterns
    ? opts.allowedPatterns
    : opts.allowedOrigins
      ? parseAllowedOrigins(opts.allowedOrigins)
      : getAllowedOriginPatterns();

  const regexes = patterns.map(compileOriginPattern).filter(Boolean);
  const maxAge = opts.maxAge ?? MAX_AGE;
  const methods = opts.allowedMethods ?? [...ALLOWED_METHODS];
  const headers = opts.allowedHeaders ?? [...ALLOWED_HEADERS];

  if (regexes.length === 0 && patterns.length > 0) {
    console.warn(
      "[cors] No valid origin patterns compiled; CORS will deny all origins",
    );
  }

  function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;

    res.setHeader("Vary", "Origin");

    if (!origin) {
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
        res.setHeader("Access-Control-Allow-Headers", headers.join(", "));
        res.setHeader("Access-Control-Max-Age", String(maxAge));
        return res.status(204).end();
      }
      return next();
    }

    const allowed = isOriginAllowed(origin, regexes);

    if (!allowed) {
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
        return res.status(403).json({
          success: false,
          error: "Origin not allowed by CORS policy",
        });
      }
      return next();
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
    res.setHeader("Access-Control-Allow-Headers", headers.join(", "));
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Max-Age", String(maxAge));
      return res.status(204).end();
    }
    return next();
  }

  corsMiddleware.isOriginAllowed = (origin) => isOriginAllowed(origin, regexes);
  corsMiddleware.getPatterns = () => [...patterns];
  corsMiddleware.getRegexes = () => [...regexes];
  corsMiddleware.maxAge = maxAge;

  return corsMiddleware;
}

export const corsMiddleware = createCorsMiddleware();
export default corsMiddleware;
