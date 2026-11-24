# ADR-017 — Multi-Tenant Database Architecture: RLS Policy Design & Partition Strategy

**Date:** 2026-10-16
**Status:** Proposed
**ISP / Spike:** ISP-143
**Decision owner:** @helphone-db-owner
**Review required:** @helphone-maintainers, @helphone-db-owner

---

## Context

`migrations/20260501000000_tenant_rls.sql` introduces Row-Level Security on
`contract_events`, `expert_verifications`, `requests`, and `responders`.
`server/db/poolManager.ts` manages a single pg pool. `server/db/partitioning.js`
applies range partitioning to `contract_events` by `ledger_seq`.

As HelPhone scales to multi-tenant deployments (municipal operators, NGO
deployments, regional federated nodes — see ADR-018), three architectural
tensions emerge:

1. **Tenant isolation vs connection pool efficiency.** A per-tenant database
   guarantees isolation but defeats `poolManager.ts`'s pool ceiling. Row-Level
   Security on a single database is pool-friendly but requires the application
   layer to correctly set `app.current_tenant` on every connection.
2. **Partition key drift.** The current partition is by `ledger_seq` (monotonic,
   Soroban-native). Under multi-tenancy, cross-tenant queries must either scan
   all partitions or include `tenant_id` in the partition key, which changes
   the partition routing entirely.
3. **Migration safety.** `server/db/migrator.ts` runs migrations without
   coordinating across tenants. A migration that adds a column is safe; one
   that changes an RLS policy may silently break a tenant that relies on the
   old policy.

The forcing function is ISP-143: a HelPhone deployment for City A must never
leak incident data to City B, even under a compromised application server, and
the compliance requirement is enforced at the database layer.

---

## Options considered

### Option A — Database-per-tenant (full isolation)

Each tenant gets a separate Postgres database. `poolManager.ts` is extended with
a `TenantPoolRegistry` that selects the correct connection string based on
a JWT claim decoded in `server/middleware/auth.ts`.

**Evidence:** Pool overhead measured at ~120 MB RAM per 10 idle connections in
`test/db-pool.test.js`. At 10 tenants × 10 connections, overhead is 120 MB —
acceptable. At 100 tenants, 1.2 GB — problematic on Render's 512 MB plan
(`render.yaml`).

**Pros:**
- True blast-radius isolation: compromised application code cannot leak cross-tenant data.
- Schema drift is tenant-local; one tenant can be on a different migration level.

**Cons:**
- Pool explosion past ~20 tenants.
- Migration coordination requires tenant enumeration; `migrator.ts` needs a
  tenant-registry abstraction.
- `server/db/partitioning.js` must be replicated per tenant database.

**Cost / effort:** ~3 days refactor + per-tenant provisioning tooling.

---

### Option B — Single database + RLS with `app.current_tenant` session variable

`migrations/20260501000000_tenant_rls.sql` already implements this pattern.
The application sets `SET LOCAL app.current_tenant = $tenant_id` at the
start of every transaction. `poolManager.ts` is extended with a
`withTenant(tenantId, fn)` helper that wraps every query in the correct
session variable.

**Evidence:** `migrations/20260501000000_tenant_rls.sql` shows the RLS policy
`USING (tenant_id = current_setting('app.current_tenant')::uuid)`. The
`server/db/connection.ts` `query` wrapper can be extended to inject the SET
statement.

**Pros:**
- Single pool; no memory explosion at scale.
- All tenants share the same migration level; `migrator.ts` needs no changes.
- Partitioning by `(tenant_id, ledger_seq)` composite key is straightforward.

**Cons:**
- Application code *must* always call `withTenant`; a bare `query()` call will
  see rows from all tenants (regression risk).
- A compromised application server can set any `current_tenant` and read any
  tenant's data.
- Shared vacuum and autovacuum contention across tenants at high write volume.

**Cost / effort:** ~1.5 days — extend `connection.ts`, update `partitioning.js`,
add linting guard to prevent bare `query()` on tenant tables.

---

### Option C — Schema-per-tenant (Postgres schemas)

Each tenant gets a Postgres schema (`city_a.requests`, `city_b.requests`).
`search_path` is set per connection. No RLS required.

**Pros:** Stronger isolation than RLS; no session-variable risk.

**Cons:** Schema proliferation breaks standard tooling (`pg_dump`, index
advisors, `migrator.ts`). Not supported by the current `partitioning.js` design.
Deferred for now.

---

## Decision

**Chosen:** Option B — Single database with RLS + `withTenant` wrapper,
**with a linting guard that fails CI on any bare `query()` call against a
tenant-isolated table.**

**Partition key change:** `partitioning.js` will migrate from partition-by-`ledger_seq`
to partition-by-`(tenant_id, ledger_seq)` composite. The existing single-tenant
partition is treated as `tenant_id = DEFAULT_TENANT_UUID`. Migration:
`migrations/20261001000000_tenant_partition.sql` (to be authored in ISP-143).

**Rationale:** Option A's pool explosion is disqualifying on Render's memory
tier. Option C's schema proliferation breaks the migration toolchain. Option B
is already 80% implemented; the `withTenant` wrapper and the composite
partition key are the only new pieces. The linting guard (`scripts/audit-ai-code.js`
pattern, extended for `query()` bare calls) enforces the invariant in CI.

---

## Consequences

### Subsystems affected

| Subsystem | Impact | Follow-up action | Owner | Due |
|---|---|---|---|---|
| `server/db/connection.ts` | Add `withTenant(tenantId, fn)` wrapper | Implementation | @helphone-db-owner | 2026-Q4 |
| `server/db/partitioning.js` | Composite partition key `(tenant_id, ledger_seq)` | Migration + code | @helphone-db-owner | 2026-Q4 |
| `migrations/` | `tenant_partition.sql` migration file | Author + test | @helphone-db-owner | 2026-Q4 |
| `scripts/audit-ai-code.js` | Add bare `query()` guard for tenant tables | Security rule | @helphone-security-owner | 2026-Q4 |
| `server/middleware/auth.ts` | Extract `tenant_id` claim and pass to `withTenant` | Auth integration | @helphone-security-owner | 2026-Q4 |

### Risks

- **Silent miss:** A developer adds a new query without `withTenant` and the
  linting guard misses it if the table name is aliased. The guard must match
  all table names in the tenant-isolated list, maintained in `server/db/connection.ts`.
- **Migration window:** During the partition key migration, the table must be
  briefly locked. Schedule during low-activity window; document in
  `docs/disaster-recovery.md`.

### Follow-up ADRs

- ADR-018: Centerless Federation — the tenant model must align with the
  federation node identity scheme.

---

## Done-definition checklist

- [x] Status set
- [x] Context names the forcing function
- [x] ≥2 options considered with trade-offs
- [x] Decision cites evidence
- [x] Consequences table filled
- [x] Added to `docs/adr/README.md` index
- [ ] CODEOWNERS review obtained
