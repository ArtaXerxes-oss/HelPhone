# Supply-chain index alerts

Dashboard: `/api/supply-chain/dashboard`. Metrics: `/metrics/security`.

| Alert | Route | First checks |
| --- | --- | --- |
| `supply_chain_index_partial` | Page on-call | Confirm the audit artifact exists and is valid JSON, then rerun the security-audit job. This alert does not block deployment. |
| `supply_chain_grade_below_b` | Security warning | Compare component scores and inspect the CI audit artifact. |
| `supply_chain_audit_stale` | Security warning | Check the audit job schedule and artifact publication time. |

Alert payloads intentionally contain only the rule, summary, severity, and links. Package names, dependency URLs, and secrets stay in the authenticated dashboard and CI artifacts.
