/**
 * Server-side environment variable validation using Zod.
 *
 * Validates all required server environment variables at startup.
 * Fails loudly if required variables are missing or invalid.
 */
import { z } from 'zod';

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  STELLAR_SECRET_KEY: z.string().min(56),
  STELLAR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Mask a secret value for safe logging.
 * Shows first 4 and last 4 characters, masks the rest.
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
}

function validateServerEnv(): ServerEnv {
  const result = serverEnvSchema.safeParse(process.env);

  if (!result.success) {
    if (process.env.NODE_ENV === 'test') {
      return {
        NODE_ENV: 'test',
        PORT: 3001,
        DATABASE_URL: 'postgresql://test:test@localhost:5432/helphone_test',
        STELLAR_SECRET_KEY: 'SB' + 'A'.repeat(54),
        STELLAR_NETWORK: 'testnet',
        LOG_LEVEL: 'info',
      };
    }
    const errors = result.error.flatten().fieldErrors;
    console.error('❌ Invalid server environment variables:');
    for (const [key, msgs] of Object.entries(errors)) {
      console.error(`  ${key}: ${msgs?.join(', ')}`);
    }
    throw new Error('Server environment validation failed');
  }

  return result.data;
}

export const serverEnv = validateServerEnv();

export interface MaintenanceConfig {
  enabled: boolean;
  bloatThresholdPct: number;
  windowStartHour: number;
  windowEndHour: number;
  intervalMs: number;
  reindexCooldownMs: number;
  minTableTuples: number;
}

function envNumber(raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= bounds.min && n <= bounds.max ? n : fallback;
}

export function getMaintenanceConfig(env: NodeJS.ProcessEnv = process.env): MaintenanceConfig {
  return {
    enabled: env.DB_MAINTENANCE_ENABLED === 'true',
    bloatThresholdPct: envNumber(env.DB_BLOAT_THRESHOLD_PCT, 20, { min: 1, max: 100 }),
    windowStartHour: Math.trunc(envNumber(env.DB_MAINTENANCE_WINDOW_START_UTC, 2, { min: 0, max: 23 })),
    windowEndHour: Math.trunc(envNumber(env.DB_MAINTENANCE_WINDOW_END_UTC, 5, { min: 0, max: 23 })),
    intervalMs: envNumber(env.DB_MAINTENANCE_INTERVAL_MS, 15 * 60_000, { min: 1_000, max: 24 * 3_600_000 }),
    reindexCooldownMs: envNumber(env.DB_REINDEX_COOLDOWN_MS, 7 * 24 * 3_600_000, { min: 0, max: 365 * 24 * 3_600_000 }),
    minTableTuples: envNumber(env.DB_MAINTENANCE_MIN_TUPLES, 1_000, { min: 0, max: Number.MAX_SAFE_INTEGER }),
  };
}
