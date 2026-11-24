import { query } from './connection.js';

export async function findUnusedIndexes(minAgeDays = 7, runQuery = query) {
  const result = await runQuery(`
    SELECT schemaname AS "schemaName", relname AS "tableName",
      indexrelname AS "indexName", idx_scan AS "indexScans",
      pg_relation_size(indexrelid) AS "sizeBytes"
    FROM pg_stat_user_indexes
    WHERE idx_scan = 0
      AND indexrelname NOT LIKE '%_pkey'
      AND COALESCE((SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()), pg_postmaster_start_time())
          <= now() - ($1::integer * interval '1 day')
    ORDER BY pg_relation_size(indexrelid) DESC
  `, [minAgeDays]);
  return result.rows;
}

export async function findDuplicateIndexes(runQuery = query) {
  const result = await runQuery(`
    SELECT tablename AS "tableName", indexdef, indexname
    FROM pg_indexes WHERE schemaname = 'public'
  `, []);
  const bySignature = new Map();
  for (const row of result.rows) {
    const columnMatch = row.indexdef.match(/\(([^)]+)\)/);
    const signature = `${row.tableName}:${columnMatch ? columnMatch[1] : row.indexdef}`;
    if (!bySignature.has(signature)) {
      bySignature.set(signature, { tableName: row.tableName, columnSignature: signature, indexNames: [] });
    }
    bySignature.get(signature).indexNames.push(row.indexname);
  }
  return Array.from(bySignature.values()).filter((group) => group.indexNames.length > 1);
}

export async function verifyIndexUsage(sql, params, expectedIndexes, runQuery = query) {
  const result = await runQuery(`EXPLAIN ${sql}`, params);
  const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n');
  return { usesExpectedIndex: expectedIndexes.some((index) => plan.includes(index)), plan };
}

export async function dropUnusedIndex(indexName) {
  if (!/^[a-zA-Z0-9_]+$/.test(indexName)) throw new Error(`Invalid index name: ${indexName}`);
  await query(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName}`, []);
}
