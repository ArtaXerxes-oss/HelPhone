import { Client } from 'pg';
import { verifyIndexUsage } from '../server/db/indexOptimizer.js';

const client = new Client({ connectionString: process.env.DATABASE_URL });
const searches = [
  ['SELECT id FROM requests WHERE status = $1 ORDER BY created_at DESC LIMIT 10', ['active'], 'idx_requests_status_created_at'],
  ['SELECT id FROM responders WHERE request_id = $1 AND arrived = $2 LIMIT 10', [1, false], 'idx_responders_request_id_arrived'],
  ['SELECT id FROM expert_verifications WHERE wallet = $1 ORDER BY recorded_at DESC LIMIT 10', ['GTEST'], 'idx_verifications_wallet_recorded_at'],
] as const;

try {
  await client.connect();
  await client.query('SET enable_seqscan = off');
  for (const [sql, params, index] of searches) {
    const result = await verifyIndexUsage(sql, [...params], [index], (statement, values) => client.query(statement, values));
    if (!result.usesExpectedIndex) throw new Error(`${index} missing from query plan:\n${result.plan}`);
    console.log(`[index-plan] ${index}: OK`);
  }
} finally {
  await client.end();
}
