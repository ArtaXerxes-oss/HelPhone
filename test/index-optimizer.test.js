// @vitest-environment node
import { it, expect, vi } from 'vitest';
for (const extension of ['ts', 'js']) {
  it(`${extension} checks an index with EXPLAIN and does not execute the search`, async () => {
    const { verifyIndexUsage } = await import(`../server/db/indexOptimizer.${extension}`);
    const query = vi.fn().mockResolvedValue({ rows: [{ 'QUERY PLAN': 'Index Scan using idx_requests_status_created_at on requests' }] });
    const result = await verifyIndexUsage('SELECT id FROM requests WHERE status = $1', ['active'], ['idx_requests_status_created_at'], query);
    expect(result.usesExpectedIndex).toBe(true);
    expect(query).toHaveBeenCalledWith('EXPLAIN SELECT id FROM requests WHERE status = $1', ['active']);
    expect((await verifyIndexUsage('SELECT id FROM requests', [], ['missing_index'], query)).usesExpectedIndex).toBe(false);
  });
}
