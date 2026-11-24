// @vitest-environment node
import { it, expect, vi } from 'vitest';

vi.mock('pg', () => ({
  Client: class {
    async connect() {}
    async query(sql) { return { rows: [{ source: 'postgres', sql }] }; }
    async end() {}
  },
}));

for (const extension of ['ts', 'js']) {
  it(`${extension} uses PostgreSQL when DATABASE_URL is configured`, async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://localhost/helphone_test';
    const { query, shutdownPool } = await import(`../server/db/connection.${extension}`);
    try {
      expect((await query('SELECT source')).rows).toEqual([{ source: 'postgres', sql: 'SELECT source' }]);
    } finally {
      await shutdownPool();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
}
