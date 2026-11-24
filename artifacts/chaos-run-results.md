# Chaos rehearsal results

Generated: 2026-11-24T14:33:26.657Z

| Scenario | Faults | P0 admitted | Rescuer heartbeat | Map tiles shed | Critical lane | Integrity | Leak guard | Rollback |
|---|---|---|---|---|---|---|---|---|
| RED_WEDDING | REDIS_OUTAGE, POSTGRES_PARTITION_DETACH, STELLAR_RPC_429_STORM, CPU_QUOTA_THROTTLE | true | true | true | true | true | true | true |
| REDIS_ONLY,POSTGRES_ONLY,STELLAR_ONLY | REDIS_OUTAGE, POSTGRES_PARTITION_DETACH, STELLAR_RPC_429_STORM | true | true | true | true | true | true | true |
| STELLAR_ONLY,CPU_ONLY | STELLAR_RPC_429_STORM, CPU_QUOTA_THROTTLE | true | true | true | true | true | true | true |

Target health before: not configured
Target health after: not configured
