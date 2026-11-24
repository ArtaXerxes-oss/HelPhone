/**
 * Bulkhead admission middleware and opt-in chaos control endpoints (#769).
 *
 * The middleware is a no-op until a scenario is armed, so enabling the code
 * path is rollback-safe for a release. Under chaos it sheds low-priority
 * traffic in the documented order while EMERGENCY_DISPATCH always passes.
 */
import { Router } from "express";
import {
  AdmissionPriority,
  ScenarioType,
  assertChaosAllowed,
  chaosStartupConfig,
} from "../lib/chaosEngine.js";

const REQUEST_TYPE_HEADER = "x-helphone-request-type";

export function inferRequestType(req) {
  const path = String(req?.originalUrl || req?.url || "");
  if (path.includes("/api/dispatch") || path.includes("/api/help")) return "EMERGENCY_DISPATCH";
  if (path.includes("/heartbeat")) return "RESCUER_HEARTBEAT";
  if (path.includes("/tiles") || path.includes("/map")) return "MAP_TILES";
  if (path.includes("/telemetry") || path.includes("/metrics")) return "COARSE_TELEMETRY";
  return null;
}

export function createChaosAdmissionMiddleware(engine, { header = REQUEST_TYPE_HEADER } = {}) {
  return (req, res, next) => {
    const declared = req.get?.(header);
    const requestType = typeof declared === "string" && declared in AdmissionPriority
      ? declared
      : inferRequestType(req);
    if (!requestType) return next();

    const decision = engine.evaluateAdmission(requestType);
    if (decision.admitted) return next();

    res.set("Retry-After", "5");
    return res.status(503).json({
      error: "shed_under_chaos",
      requestType,
      priority: decision.priority,
      reason: decision.reason,
    });
  };
}

/**
 * Admin control plane. Requires CHAOS_ADMIN_TOKEN and refuses to arm in
 * production unless the same break-glass value used at startup is supplied.
 */
export function createChaosAdminRouter(engine, { adminToken = process.env.CHAOS_ADMIN_TOKEN, env = process.env } = {}) {
  const router = Router();

  const authorized = (req, res) => {
    if (!adminToken || req.get("authorization") !== `Bearer ${adminToken}`) {
      res.status(401).json({ error: "unauthorized" });
      return false;
    }
    return true;
  };

  router.get("/status", (_req, res) => {
    res.json({
      activeScenario: engine.activeScenario,
      faults: [...engine.injectedFaults],
      cpuQuotaPercent: engine.cpuQuotaPercent,
      startup: chaosStartupConfig(env),
    });
  });

  router.post("/abort", (req, res) => {
    if (!authorized(req, res)) return;
    res.json(engine.abort());
  });

  router.post("/start", (req, res) => {
    if (!authorized(req, res)) return;
    const requested = req.body?.scenario || ScenarioType.RED_WEDDING;
    let config = assertChaosAllowed(chaosStartupConfig({ ...env, CHAOS_ENABLED: "true", CHAOS_SCENARIO: requested }));
    if (!config.allowed) return res.status(403).json({ error: config.reason });
    if (!Object.values(ScenarioType).includes(requested)) {
      return res.status(400).json({ error: "unknown_scenario" });
    }
    res.status(202).json(engine.startScenario(requested));
  });

  return router;
}
