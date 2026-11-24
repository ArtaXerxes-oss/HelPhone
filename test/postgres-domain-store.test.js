// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { loadConfiguredDomainStore, loadPostgresDomainStore } from '../server/lib/postgresDomainStore.ts';

describe('postgres domain store adapter', () => {
  it('loads a tenant-scoped snapshot with three queries', async () => {
    const query = vi.fn(async (sql) => ({
      rows: sql.includes('FROM incidents')
        ? [{ id: 'I-1', status: 'open', priority: 'normal', createdAt: '2026-01-01T00:00:00Z', version: 1, location: { lat: 1, lng: 2 } }]
        : [],
    }));
    const store = await loadPostgresDomainStore(query, 'tenant-a');
    expect(store.getIncident('I-1')).toMatchObject({ id: 'I-1' });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.every(([, params]) => params[0] === 'tenant-a')).toBe(true);
  });

  it('keeps memory mode as the default feature-flag path', async () => {
    const query = vi.fn();
    const store = await loadConfiguredDomainStore(query, {});
    expect(store.getIncident('INC-1042')).not.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});
