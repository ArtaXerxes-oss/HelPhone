# Zero-downtime deploy rehearsal

Generated: 2026-11-24T14:29:20.803Z

| Scenario | Result | WS handoffs | Rollback |
|---|---|---|---|
| healthy staged deploy | COMPLETE | 3/3 | no |
| failed health check | ROLLED_BACK | n/a | automatic |
| manual abort gate | ROLLED_BACK | n/a | automatic |

Stages verified: MIGRATE → INDEXER_CATCHUP → HEALTH → DRAIN → DEPLOY → CUTOVER, with ROLLBACK on health failure or manual abort.
