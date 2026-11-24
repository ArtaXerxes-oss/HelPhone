# Zero-downtime deploy runbook (#758)

The release workflow is
`.github/workflows/zero-downtime-deploy.yml`. It is manual-only
(`workflow_dispatch`) and requires a protected GitHub environment review.
`render.yaml` sets `autoDeploy: false` so the workflow is the single cutover
path — two paths must never race.

## Stages

| Stage | What happens | Gate |
|---|---|---|
| 1. Migrate | `acquireMigrationLock()` takes advisory lock `88442211`; only one replica runs DDL | lock acquired, else wait |
| 2. Indexer catch-up | Leader lock `99553322`; `updateIndexerProgress()` tracks head | lag ≤ `DEPLOY_MAX_INDEXER_LAG` (50) |
| 3. Health | `/healthz` (liveness) stays 200; `/readyz` returns 503 until migrations + lag are ready | `/readyz` 200 |
| 4. Drain | SIGTERM triggers `initiateGracefulDrain()`: `DEPLOY_DRAIN` + `resumeSeq` + 500–2500 ms jitter, then close code `1001` | `DEPLOY_DRAIN_TIMEOUT_MS` (15 s) |
| 5. Deploy | Render builds the new release; WS clients reconnect with their resume token | build succeeded |
| 6. Cutover | Traffic shifts to the drained release | manual abort gate clear |
| 7. Rollback | Any failed stage before cutover calls the rollback endpoint | automatic |

## Manual abort gate

- The dispatch form has `abort_before_cutover`. Setting it runs the rehearsal
  only; the `cutover` job is skipped and nothing is released.
- `DEPLOY_ABORT_GATE=true` in the target environment also blocks cutover.
- The `production` environment has required reviewers; a single approver is
  the human abort gate. Rehearse in `staging` first.

## Automatic rollback

The health loop polls `/readyz` for up to 5 minutes after the build. If it
never reaches 200, the workflow calls the Render rollback endpoint and fails
the job. No WS client is left on a half-drained connection: the drain stage
sends resume tokens before the build starts, and a failed health check never
reaches cutover.

## Rehearsal (no infra required)

```bash
node scripts/deploy-rehearsal.js
```

This drives `createStagedDeploy()` with injected stages and asserts:

- a healthy deploy completes with zero failed WS handoffs;
- a failed health check rolls back automatically, with no cutover;
- the manual abort gate rolls back before cutover.

Results are written to `artifacts/zero-downtime-rehearsal.md` and mirrored in
`docs/disaster-recovery.md`. CI uploads the artifact from the `rehearse` job.

## Recovery notes

- A stale `/readyz` 503 after migration means the indexer is behind: check the
  leader-lock holder and lag before retrying; do not bypass the gate.
- If a drain exceeds its deadline, `initiateGracefulDrain()` closes remaining
  sockets with `1001`; clients use `resumeSeq` to replay from their last seen
  ledger. Check `GET /readyz` before allowing another cutover.
- Advisory locks are session-scoped: a crashed migrator releases them, so a
  retry is safe without manual `pg_advisory_unlock`.
