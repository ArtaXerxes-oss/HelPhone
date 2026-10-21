// k6 load test for the ZK prover server's /zk/prove endpoint.
//
// The prover spawns heavy CPU work per request (Noir witness execution +
// Barretenberg proof generation via UltraHonkBackend — see server/index.js's
// `ensureProver`/`app.post('/zk/prove', ...)`), so it's the endpoint most at
// risk under concurrent load, unlike the lightweight JSON routes (/api/ranking,
// /api/preferences, /api/feedback).
//
// Note: the issue that requested this script referenced a `/prove` endpoint;
// the actual route (confirmed in server/index.js) is `/zk/prove`, used here.
//
// Run with: k6 run server/tests/load.js
// Override target: BASE_URL=http://localhost:3001 k6 run server/tests/load.js
// Simulate emergency-situation bursts (short, spiky, concurrent requests
// arriving together) with the `emergency_burst` scenario below; a steadier
// baseline is covered by `steady_ramp`.

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";

// Custom metrics so `k6 run --summary-export` captures prover-specific
// throughput/latency separately from k6's generic http_req_duration.
const proveLatency = new Trend("prove_latency_ms", true);
const proveFailureRate = new Rate("prove_failure_rate");

// Matches the `inputs` shape sent by src/lib/zk.js's _requestServerProof —
// synthetic but structurally valid so the circuit executes the same code
// path as a real client request, rather than short-circuiting on bad input.
function proveInputs() {
  return {
    inputs: {
      user_x: 1000000,
      user_y: 1000000,
      secret_id: `${__VU}-${__ITER}-${Date.now()}`,
      box_x_min: 0,
      box_x_max: 2000000,
      box_y_min: 0,
      box_y_max: 2000000,
      campaign_id: "1",
      recipient_address: "1",
    },
  };
}

export const options = {
  scenarios: {
    // Baseline: steady, moderate concurrency to find the sustainable throughput ceiling.
    steady_ramp: {
      executor: "ramping-vus",
      exec: "proveRequest",
      startVUs: 1,
      stages: [
        { duration: "30s", target: 5 },
        { duration: "1m", target: 5 },
        { duration: "30s", target: 15 },
        { duration: "1m", target: 15 },
        { duration: "30s", target: 0 },
      ],
    },
    // Emergency-situation simulation: a burst of concurrent requests arriving
    // together (many users triggering the panic flow at once), then silence —
    // the shape a real incident would produce, distinct from steady traffic.
    emergency_burst: {
      executor: "ramping-arrival-rate",
      exec: "proveRequest",
      startTime: "4m", // runs after steady_ramp finishes
      startRate: 1,
      timeUnit: "1s",
      preAllocatedVUs: 30,
      maxVUs: 60,
      stages: [
        { duration: "10s", target: 1 },
        { duration: "5s", target: 20 }, // sharp spike
        { duration: "20s", target: 20 },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    // These are starting points, not tuned production SLOs — see
    // "Documenting throughput/failure rates" below for how to replace them
    // with real numbers once this has been run against a real prover.
    http_req_failed: ["rate<0.05"],
    prove_failure_rate: ["rate<0.05"],
  },
};

export function proveRequest() {
  const res = http.post(`${BASE_URL}/zk/prove`, JSON.stringify(proveInputs()), {
    headers: { "Content-Type": "application/json" },
    timeout: "60s", // proof generation is CPU-heavy; a short timeout would misreport slow-but-successful requests as failures
  });

  proveLatency.add(res.timings.duration);

  const ok = check(res, {
    "status is 200": (r) => r.status === 200,
    "response has success:true": (r) => {
      try {
        return JSON.parse(r.body).success === true;
      } catch {
        return false;
      }
    },
  });
  proveFailureRate.add(!ok);

  sleep(1);
}

// Lightweight scenario for /zk/health, useful as a control group to confirm
// that any degradation under load is specific to /zk/prove's heavy compute
// path and not a symptom of the whole server (or network) being saturated.
export function healthCheck() {
  const res = http.get(`${BASE_URL}/zk/health`);
  check(res, { "health check status is 200": (r) => r.status === 200 });
  sleep(1);
}
