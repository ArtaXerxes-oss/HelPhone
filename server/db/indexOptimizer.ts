/**
 * Inspects `pg_stat_user_indexes` to find unused and duplicate indexes,
 * and verifies that critical search queries use the composite indexes
 * added in migrations/20260506000000_indexes.sql (via EXPLAIN ANALYZE).
 */
import { query } from './connection.js';

export interface IndexUsageStat {
  schemaName: string;
  tableName: string;
  indexName: string;
  indexScans: number;
  sizeBytes: number;
}

export interface DuplicateIndexGroup {
  tableName: string;
  columnSignature: string;
  indexNames: string[];
}

/** Indexes with zero scans since the last stats reset — candidates for removal. */
export async function findUnusedIndexes(minAgeDays = 7): Promise<IndexUsageStat[]> {
  const result = await query(
    `
    SELECT
      schemaname AS "schemaName",
      relname AS "tableName",
      indexrelname AS "indexName",
      idx_scan AS "indexScans",
      pg_relation_size(indexrelid) AS "sizeBytes"
    FROM pg_stat_user_indexes
    WHERE idx_scan = 0
      AND indexrelname NOT LIKE '%_pkey'
    ORDER BY pg_relation_size(indexrelid) DESC
    `,
    [],
  );
  return result.rows as IndexUsageStat[];
}

/** Groups indexes on the same table + column set — duplicates that waste write throughput. */
export async function findDuplicateIndexes(): Promise<DuplicateIndexGroup[]> {
  const result = await query(
    `
    SELECT
      tablename AS "tableName",
      indexdef,
      indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
    `,
    [],
  );

  const bySignature = new Map<string, DuplicateIndexGroup>();
  for (const row of result.rows as Array<{ tableName: string; indexdef: string; indexname: string }>) {
    const columnMatch = row.indexdef.match(/\(([^)]+)\)/);
    const signature = `${row.tableName}:${columnMatch ? columnMatch[1] : row.indexdef}`;

    if (!bySignature.has(signature)) {
      bySignature.set(signature, {
        tableName: row.tableName,
        columnSignature: signature,
        indexNames: [],
      });
    }
    bySignature.get(signature)!.indexNames.push(row.indexname);
  }

  return Array.from(bySignature.values()).filter((g) => g.indexNames.length > 1);
}

/** Runs EXPLAIN ANALYZE on `sql` and checks the plan mentions one of `expectedIndexes`. */
export async function verifyIndexUsage(
  sql: string,
  params: unknown[],
  expectedIndexes: string[],
): Promise<{ usesExpectedIndex: boolean; plan: string }> {
  const result = await query(`EXPLAIN ANALYZE ${sql}`, params);
  const plan = result.rows.map((r: any) => r['QUERY PLAN']).join('\n');
  const usesExpectedIndex = expectedIndexes.some((idx) => plan.includes(idx));
  return { usesExpectedIndex, plan };
}

/** Drops an unused, non-primary-key index. Caller is responsible for confirming safety. */
export async function dropUnusedIndex(indexName: string): Promise<void> {
  if (!/^[a-zA-Z0-9_]+$/.test(indexName)) {
    throw new Error(`Invalid index name: ${indexName}`);
  }
  await query(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName}`, []);
}
