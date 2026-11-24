# Spike #786: IPv6-only / NAT64 address audit (static, partial)

Refs [#786](https://github.com/Hel-Phone/HelPhone/issues/786). This is the static-analysis part of the spike only. **Nothing here was measured on a NAT64 network**; no lab, device or CI job was run. See "Not done" below.

## Why literals matter

DNS64 synthesises an IPv6 address only for a hostname that is resolved through the system resolver. An endpoint written as an IPv4 dotted-quad is never resolved, so NAT64 cannot translate it and the connection fails on an IPv6-only bearer. Hostnames and IPv6 literals are fine. Loopback defaults (`localhost`, `127.0.0.1`) are not a NAT64 problem but must not reach a device-facing build.

## Method

A repository search (`grep -rnIE` for dotted-quads, `family: 4`, `resolve4`, `localhost`) over `src/`, `server/`, `scripts/security/`, `vite.config.ts`, `render.yaml`, `playwright.config.js`, plus a read of `.env.example` and `.env.production`. Test files and user-agent/version strings were excluded.

## Inventory

| Location | Value | Class | Disposition |
|---|---|---|---|
| `vite.config.ts:248` | dev proxy target `http://127.0.0.1:3001` | loopback, dev server only | Justified: never shipped to a device. |
| `src/lib/contract.ts:794` | fallback `VITE_EVENTS_URL \|\| "http://localhost:3001/events/stream"` | loopback default in client bundle | Follow-up: needs a deployed-hostname default or a hard failure outside dev. Not changed here. |
| `src/services/api.ts:57` | fallback `VITE_SERVER_URL \|\| 'http://localhost:3001'` | loopback default in client bundle | Same follow-up. |
| `server/index.ts:41` | CORS allowlist includes `http://localhost:3000` | loopback, server config | Justified for dev; confirm it is dev-only. |
| `.env.example` | `PASSKEY_RP_ID`, `PASSKEY_ORIGIN`, `DATABASE_URL` use `localhost` | loopback examples | Justified as local-dev examples. |
| `.env.production` | `VITE_ZK_PROVER_URL=https://helphone.onrender.com` | hostname | Compliant. |
| `server/middleware/whitelist.ts` | parses IPv4, IPv6, zone ids, `::ffff:a.b.c.d` | n/a | Already handles IPv6 CIDRs; the only dotted-quads are in a comment. |

Findings:

- No IPv4 literal endpoint exists in the searched defaults, examples or configs.
- No forced-IPv4 dialing (`family: 4`, `resolve4`) was found in `src/` or `server/`.
- `scripts/security/env_firewall.js` has no host/address patterns at all (it matches secret keys and values), so the issue's premise that its patterns assume dotted-quads does not apply. It does not stop a new IPv4-literal endpoint from being added.

## What this change adds

- `scripts/security/endpoint_literals.js`: dependency-free classifier (`hostname`, `ipv4-literal`, `ipv6-literal`, `loopback`) and a CLI that fails on non-loopback IPv4 literals in dotenv files: `node scripts/security/endpoint_literals.js .env.example`. Run by hand against `.env.example` and `.env.production`, it exits 0 and reports only the loopback examples above.
- `test/ipv6-nat64-spike.test.js`: unit tests for the classifier. They were not run.

## Not done (issue #786 is not resolved)

- No NAT64/DNS64 lab, no IPv6-only device or CI job, no Playwright journey on an IPv6-only bearer, and therefore no before/after exhibit for a literal-forced `VITE_STELLAR_RPC`.
- Not audited: Redis/Postgres dial paths (`server/lib/redis.js`, `redisPubSub.js`, `server/db/*`) beyond the search above, `csp.ts`/`cors.ts` rule semantics, `rateLimiter.ts` key normalisation, WebRTC STUN/TURN addressing, cached tile URL forms in `src/service-worker.js`.
- Not implemented: an `ipv6-nat64` failure bucket in `rpcHealth.ts`/`wsClient.ts`/`networkEstimator.ts`, the localhost-default follow-ups above, and CI/husky wiring of the new check.
- No Happy-Eyeballs, connection-family or timing numbers were collected.
