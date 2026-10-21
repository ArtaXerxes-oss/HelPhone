import { Router } from "express";

export function createHealthRouter({ readiness = () => true } = {}) {
  const healthRouter = Router();
  healthRouter.get("/live", (_req, res) => res.json({ status: "ok" }));
  healthRouter.get("/ready", (_req, res) => {
    const ready = readiness();
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready" });
  });
  return healthRouter;
}
