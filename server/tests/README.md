# Load testing the ZK prover server

`load.js` is a [k6](https://k6.io) script targeting `/zk/prove` — the endpoint that
spawns the heaviest CLI/CPU work per request (Noir witness execution + Barretenberg
proof generation) and is therefore the one most likely to bottleneck under concurrent
load, unlike the lightweight `/api/*` routes.

The relevant file named in the original issue was `/prove`; the actual route
(`server/index.js`) is `/zk/prove` — this script targets the real one.

## Running it

```bash
# 1. Start the prover server (from repo root)
npm run server

# 2. In a separate terminal, run the load test against it
k6 run server/tests/load.js

# Or point at a deployed instance:
BASE_URL=https://your-prover-host k6 run server/tests/load.js
```

k6 is not installed in this environment, so this script has not been executed against
a live server as part of this change — install it via `brew install k6` /
https://k6.io/docs/get-started/installation/ to run it.

## What it covers

- **`steady_ramp`** — a gradual ramp from 1 to 15 virtual users over ~3.5 minutes, to
  find the sustainable throughput ceiling under ordinary load.
- **`emergency_burst`** — a sharp arrival-rate spike (many requests arriving together,
  then silence), simulating the shape of traffic a real emergency/panic-button event
  would produce, distinct from steady traffic. Runs after `steady_ramp` finishes.
- A `healthCheck` function against `/zk/health` (not wired into a scenario by default)
  is available as a control group — run it alongside the above to confirm any observed
  degradation is specific to `/zk/prove`'s heavy compute path rather than the whole
  server/network being saturated.

## Documenting maximum throughput and failure rates

The `thresholds` in `load.js` (`http_req_failed rate<0.05`, `prove_failure_rate
rate<0.05`) are starting-point guardrails, **not** numbers derived from an actual run —
no live prover server was available to run this against in this environment. To turn
these into real documented numbers:

1. Run `k6 run --summary-export=results.json server/tests/load.js` against a prover
   server sized like production (same CPU allocation — proof generation is CPU-bound).
2. From `results.json`, record:
   - `metrics.prove_latency_ms` (p95/p99) — proof generation latency under load
   - `metrics.prove_failure_rate` — error rate at each concurrency stage
   - The VU count / arrival rate at which `prove_failure_rate` first exceeds the 5%
     threshold — that's the practical throughput ceiling for this endpoint
3. Update this section (or a linked doc) with those numbers, and tune `thresholds` in
   `load.js` to match a real, agreed-upon SLO rather than the placeholder above.
