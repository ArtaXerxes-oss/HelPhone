import { quoteIdent } from './partitioning.js';

export function partitionAgeDays(name, now = new Date()) {
  const match = String(name).match(/_(\d{4})_(\d{2})$/);
  if (!match) return null;
  return Math.floor((new Date(now).getTime() - Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)) / 86400000);
}

export function planEviction(partitions, { now = new Date(), retentionDays = 90, held = new Set() } = {}) {
  return partitions.map((partition) => ({ ...partition, ageDays: partitionAgeDays(partition.name, now) }))
    .filter((partition) => partition.ageDays !== null && partition.ageDays >= retentionDays && !held.has(partition.name));
}

export async function runPartitionEviction({ query, now = new Date(), dryRun = false, retentionDays = 90, reversalDays = 7, log = () => {} } = {}) {
  if (typeof query !== 'function') throw new Error('query is required');
  const holds = await query('SELECT scope FROM legal_holds WHERE released_at IS NULL');
  const partitions = await query(`SELECT child.relname AS name, parent.relname AS parent,
    pg_get_expr(child.relpartbound, child.oid) AS bounds
    FROM pg_inherits JOIN pg_class child ON child.oid = inhrelid
    JOIN pg_class parent ON parent.oid = inhparent WHERE child.relkind = 'r'`);
  const candidates = planEviction(partitions.rows.map((row) => ({ name: String(row.name), parent: String(row.parent), bounds: String(row.bounds || '') })), {
    now, retentionDays, held: new Set((holds.rows || []).map((row) => String(row.scope))),
  });
  if (dryRun) return { dryRun: true, candidates };
  const evicted = [];
  for (const candidate of candidates) {
    const existing = await query('SELECT 1 FROM retention_manifest WHERE partition = $1 AND dropped_at IS NOT NULL', [candidate.name]);
    if (existing.rows?.length) continue;
    const reversibleUntil = new Date(new Date(now).getTime() + reversalDays * 86400000);
    try {
      await query(`ALTER TABLE ${quoteIdent(candidate.parent)} DETACH PARTITION ${quoteIdent(candidate.name)}`);
      await query(`INSERT INTO retention_manifest (partition, policy, hold_ids, parent_table, partition_bounds, reversible_until, dropped_at)
        VALUES ($1, 'cold', '{}', $2, $3, $4, now())
        ON CONFLICT (partition) DO UPDATE SET dropped_at = EXCLUDED.dropped_at, reversible_until = EXCLUDED.reversible_until`,
      [candidate.name, candidate.parent, candidate.bounds, reversibleUntil]);
      evicted.push({ ...candidate, reversibleUntil: reversibleUntil.toISOString() });
      log('[db-eviction] detached partition', { partition: candidate.name, reversibleUntil: reversibleUntil.toISOString() });
    } catch (error) {
      evicted.push({ ...candidate, error: error.message });
      log('[db-eviction] failed', { partition: candidate.name, error: error.message });
    }
  }
  return { dryRun: false, candidates, evicted };
}
