# Soroban memory architecture

Issue #578 treats 64 MiB as a conservative host reference, not a protocol
guarantee. Soroban resource limits are enforced through transaction budgets
and may change with network configuration. Simulation results are authoritative.

## Findings and decision

A value commonly exists as encoded input, decoded ScVal, and an output/copy,
so the benchmark uses a 3x working-set estimate. A 500-entry vector of 1 KiB
values is about 1.5 MiB; 500 values of 64 KiB can exceed 64 MiB.

- Keep active IDs and expert histories capped at 500 for compatibility.
- Prefer get_active_requests_page(cursor, limit), capped at 100 results.
- Use paginated maps keyed by (owner, page, slot) for durable histories.
  Use a ring buffer only for deliberately lossy recent-history data.
- Reject proof blobs above 1 MiB before verifier invocation.
- Run ENTRIES=500 BYTES_PER_ENTRY=1024 bash circuits/scripts/profile-gas.sh
  and RPC simulation after every contract/toolchain upgrade.
