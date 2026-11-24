# Storage, Proof Cache, and Audit Pipeline

This document covers the operational pieces added for database partitioning,
Soroban state budgeting, client-side ZK proof caching, and auditable contract
event streaming.

## Multi-Tenant Partitions

`server/db/partitioning.js` builds a deterministic tenant-hash plus monthly
range partition plan. Use it from migrations or maintenance scripts to pre-create
hot partitions:

```js
import { createPartitionManifest } from "../server/db/partitioning.js";

const manifest = createPartitionManifest({
  baseTable: "audit_events",
  tenantId: "hospital-1",
  months: 6,
  buckets: 32,
});
console.log(manifest.ddl);
```

The generated names are deterministic, so jobs can safely retry with
`CREATE TABLE IF NOT EXISTS`.

## Soroban Storage Budgeting

`src/services/sorobanStorageBudget.js` estimates read, write, and rent costs
for candidate layouts. The estimator is intentionally parameterized: pass the
current network fee config instead of hard-coding testnet or mainnet numbers.

## ZK Proof Cache

`src/services/zkProofCache.js` provides a bounded LRU cache for client-generated
proofs. Entries expire by TTL and are evicted by count or serialized byte size.
The cache defaults to `localStorage` in browsers and can run in memory for tests
or private browsing fallback.

## Audit Event Streamer

`server/indexer/auditStreamer.js` normalizes contract events into deterministic
audit records, deduplicates by event id, and advances a cursor after each poll.
Wire the streamer to the Soroban RPC event fetcher or an indexer export job, and
replace `InMemoryAuditSink` with a database sink for production retention.
