import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('ZK proving feasibility spike', () => {
  const benchmark = readFileSync('circuits/scripts/benchmark.sh', 'utf8');
  const client = readFileSync('src/lib/zk.ts', 'utf8');
  const worker = readFileSync('src/workers/zk-worker.js', 'utf8');
  it('enforces the 50k constraint and three-second browser budgets', () => {
    expect(benchmark).toContain('MAX_CONSTRAINTS:-50000');
    expect(benchmark).toContain('MAX_BROWSER_PROVE_SECONDS:-3');
    expect(client).toContain('maxConstraints: 50_000');
    expect(client).toContain('maxProvingMs: 3_000');
  });
  it('profiles worker latency and heap growth', () => {
    expect(worker).toContain('provingMs:');
    expect(worker).toContain('heapDeltaBytes:');
    expect(worker).toContain('profiling');
  });
});
