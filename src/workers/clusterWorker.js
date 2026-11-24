// CPU worker fallback for spatial clustering (issue #608, ADR-008).
// Runs the grid stage off the main thread when neither WebGPU nor a
// float-blendable WebGL2 context is available.

import { installWorkerHooks } from "./workerSupervision.js";
import { binPoints } from "../lib/spatialCluster/cpuGridCluster.js";
import {
  clusterWorkerInboundSchema,
  clusterWorkerOutboundSchema,
  installWorkerLockdown,
  validateMessage,
} from "../lib/workerSandbox.ts";

// Worker sandbox, layer 2: the bootstrap blob already ran this before this
// module was imported. Running it again keeps the lockdown in place when the
// worker is launched through the same-origin fallback path.
installWorkerLockdown();

// Error/heartbeat parity for null-origin workers (#793).
installWorkerHooks(self, "clusterWorker");
self.onmessage = (event) => {
  // Worker sandbox, layer 3: only binning jobs in the documented shape are
  // accepted, and only binning results in the documented shape are returned.
  const request = validateMessage(clusterWorkerInboundSchema, event.data);
  if (!request.ok) {
    console.warn(`[cluster-worker] dropped inbound message: ${request.error}`);
    return;
  }
  const { id, points, params } = request.data;
  try {
    const t0 = performance.now();
    const { cellCount, cellSum, cellRadius } = binPoints(points, params);
    const computeMs = performance.now() - t0;
    post({ id, grid: { cellCount, cellSum, cellRadius }, computeMs }, [
      cellCount.buffer,
      cellSum.buffer,
      cellRadius.buffer,
    ]);
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) });
  }
};

function post(message, transfer) {
  const parsed = validateMessage(clusterWorkerOutboundSchema, message);
  if (!parsed.ok) {
    console.warn(`[cluster-worker] dropped outbound message: ${parsed.error}`);
    return;
  }
  if (transfer) self.postMessage(parsed.data, transfer);
  else self.postMessage(parsed.data);
}
