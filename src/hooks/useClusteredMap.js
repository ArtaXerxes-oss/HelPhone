// Production wiring for ADR-008 follow-up 4.
//
// Projects lat/lng incidents onto the viewport pixel grid at the current zoom,
// runs createClusterer() with the WebGPU -> Worker -> main-thread chain, merges
// the grid into renderable clusters and records backend/fallback telemetry.
// Raw points are never handed to the renderer; single-marker hit-tests use the
// CPU point data through `hitTest()`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClusterer } from "../lib/spatialCluster/index.js";
import { createGridParams } from "../lib/spatialCluster/gridParams.js";
import { mergeCells } from "../lib/spatialCluster/mergeCells.js";
import {
  clusterToLngLat,
  hitTestSingleMarker,
  projectLatLngPoints,
  updateViewportOrigin,
} from "../lib/spatialCluster/viewportGrid.js";
import { clusterTelemetry } from "../lib/clusterTelemetry.js";

/**
 * @param {{
 *   points?: Array<{id?: any, lat?: number, lng?: number, latitude?: number, longitude?: number}>,
 *   viewState: { longitude: number, latitude: number, zoom: number },
 *   width: number,
 *   height: number,
 *   cellSize?: number,
 *   minPts?: number,
 *   relativeDensity?: number,
 *   maxPoints?: number,
 *   preferred?: string,
 *   tileSize?: number,
 *   enabled?: boolean,
 *   factories?: object,
 *   telemetry?: object,
 * }} options
 */
export function useClusteredMap({
  points = [],
  viewState,
  width,
  height,
  cellSize = 24,
  minPts = 8,
  relativeDensity = 2,
  maxPoints,
  preferred = "webgpu",
  tileSize = 512,
  enabled = true,
  factories,
  telemetry = clusterTelemetry,
} = {}) {
  const capacity = Math.max(1, maxPoints ?? points.length);
  const params = useMemo(
    () => createGridParams({ width, height, cellSize, originX: 0, originY: 0, maxPoints: capacity }),
    [width, height, cellSize, capacity],
  );

  const [clusters, setClusters] = useState([]);
  const [backend, setBackend] = useState(null);
  const [fallbackReasons, setFallbackReasons] = useState([]);
  const [timings, setTimings] = useState(null);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const [updateCount, setUpdateCount] = useState(0);

  const clustererRef = useRef(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(null);
  const factoriesRef = useRef(factories);
  factoriesRef.current = factories;

  // Backend lifecycle: one device/worker per grid geometry. Pan and zoom only
  // mutate the params origin, so this effect does not re-run on camera moves.
  useEffect(() => {
    if (!enabled) {
      setReady(false);
      return undefined;
    }
    let cancelled = false;
    setReady(false);
    setError(null);
    const options = { preferred };
    if (factoriesRef.current) options.factories = factoriesRef.current;

    createClusterer(params, options)
      .then((clusterer) => {
        if (cancelled) {
          clusterer.destroy();
          return;
        }
        clustererRef.current = clusterer;
        setBackend(clusterer.backend);
        const reasons = clusterer.fallbackReasons ?? [];
        setFallbackReasons(reasons);
        telemetry.record({
          type: "cluster.backend.selected",
          backend: clusterer.backend,
          fallbackReasons: reasons,
          points: points.length,
        });
        setReady(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        telemetry.record({ type: "cluster.backend.failed", reason: err.message });
      });

    return () => {
      cancelled = true;
      pendingRef.current = null;
      clustererRef.current?.destroy();
      clustererRef.current = null;
      setReady(false);
    };
  }, [params, preferred, enabled, telemetry]);

  // One update per projected snapshot; a newer snapshot supersedes a pending
  // one so a slow backend can never render stale clusters over a newer view.
  useEffect(() => {
    if (!ready || !enabled) return undefined;
    let cancelled = false;
    updateViewportOrigin(params, viewState, width, height, tileSize);
    const projected = projectLatLngPoints(points, viewState, width, height, {
      tileSize,
      maxPoints: params.maxPoints,
    });

    async function run(pixels) {
      const clusterer = clustererRef.current;
      if (!clusterer || cancelled) return;
      if (inFlightRef.current) {
        pendingRef.current = pixels;
        return;
      }
      inFlightRef.current = true;
      try {
        const { grid, timings: t } = await clusterer.cluster(pixels);
        if (cancelled) return;
        const merged = mergeCells(grid, params, { minPts, relativeDensity }).map((cluster) => ({
          ...cluster,
          ...clusterToLngLat(cluster, viewState, width, height, tileSize),
        }));
        setClusters(merged);
        setTimings(t);
        setUpdateCount((n) => n + 1);
        telemetry.record({
          type: "cluster.update",
          backend: clusterer.backend,
          points: pixels.length >> 1,
          clusters: merged.length,
          timings: t,
        });
      } catch (err) {
        if (cancelled) return;
        setError(err.message);
        telemetry.record({
          type: "cluster.backend.failed",
          backend: clusterer.backend,
          reason: err.message,
        });
      } finally {
        inFlightRef.current = false;
        const next = pendingRef.current;
        pendingRef.current = null;
        if (next && !cancelled) run(next);
      }
    }

    run(projected.pixels);
    return () => {
      cancelled = true;
      pendingRef.current = null;
    };
  }, [points, viewState, width, height, cellSize, tileSize, minPts, relativeDensity, params, ready, enabled, telemetry]);

  // Always CPU: GPU results lag a frame and must not decide a click.
  const hitTest = useCallback(
    (x, y, tolerance = 12) => {
      const hit = hitTestSingleMarker({
        points,
        viewState,
        width,
        height,
        x,
        y,
        tolerance,
        tileSize,
      });
      telemetry.record({ type: "cluster.hit-test", backend: "cpu", points: hit ? 1 : 0 });
      return hit;
    },
    [points, viewState, width, height, tileSize, telemetry],
  );

  return {
    clusters,
    backend,
    fallbackReasons,
    timings,
    error,
    ready,
    updateCount,
    hitTest,
    params,
  };
}

export default useClusteredMap;
