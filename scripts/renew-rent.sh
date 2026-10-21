#!/usr/bin/env bash
set -euo pipefail

# Storage rent auto-renewal — inspects TTLs via RPC and extends any key
# dropping below the 10,000-ledger threshold. Intended to run on a
# schedule (cron / Render scheduled job); see server/indexer/rentRenewer.ts
# for the underlying extend_ttl submission logic.

RPC_URL="${SOROBAN_RPC_URL:-https://soroban-testnet.stellar.org}"
NETWORK="${SOROBAN_NETWORK:-testnet}"

if [ -z "${RENT_RENEWAL_SOURCE_SECRET:-}" ]; then
  echo "ERROR: RENT_RENEWAL_SOURCE_SECRET must be set" >&2
  exit 1
fi

echo "[renew-rent] Starting rent renewal scan at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[renew-rent] RPC: ${RPC_URL} | Network: ${NETWORK}"

node --loader ts-node/esm -e "
  import { RentRenewer } from './server/indexer/rentRenewer.ts';
  import { Keypair } from '@stellar/stellar-sdk';

  const contractIds = (process.env.RENT_RENEWAL_CONTRACT_IDS || '').split(',').filter(Boolean);
  if (contractIds.length === 0) {
    console.log('[renew-rent] No contract IDs configured, exiting.');
    process.exit(0);
  }

  const renewer = new RentRenewer('${RPC_URL}');
  const keypair = Keypair.fromSecret(process.env.RENT_RENEWAL_SOURCE_SECRET);

  renewer.scanAndRenewAll(contractIds, keypair).then((results) => {
    console.log(JSON.stringify(results, null, 2));
    const failed = results.filter(r => r.error);
    if (failed.length > 0) {
      console.error('[renew-rent] Some renewals failed:', failed);
      process.exit(1);
    }
  });
"

echo "[renew-rent] Scan complete."
