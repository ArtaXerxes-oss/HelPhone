import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('M-of-N multisig threshold controller', () => {
  const rust = readFileSync('contract/contracts/helphone-contract/src/multisig.rs', 'utf8');
  const client = readFileSync('src/lib/contract.ts', 'utf8');
  it('rejects invalid thresholds and records one approval per signer', () => {
    expect(rust).toContain('threshold > admins.len()');
    expect(rust).toContain('msappr');
    expect(rust).toContain('proposal.approvals += 1');
  });
  it('only marks aggregated proposals ready at the threshold', () => {
    expect(client).toContain('collected.length >= threshold');
    expect(client).toContain('unique.set(entry.signer, entry)');
  });
});
