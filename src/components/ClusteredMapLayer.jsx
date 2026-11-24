// Production cluster overlay (ADR-008 follow-up 4).
//
// Renders grid-DBSCAN clusters produced by useClusteredMap with the
// WebGPU -> Worker -> main-thread chain. Only clusters are drawn — raw points
// are never handed to the renderer. Single-marker clicks resolve against CPU
// point data via the hook's hitTest(), not against a (one-frame-late) GPU grid.

import { useCallback } from "react";
import { useClusteredMap } from "../hooks/useClusteredMap.js";

const COLORS = {
  dense: "#FF7A6B",
  denseStroke: "#234B4E",
  sparse: "#3F8487",
};

export function clusterRadius(cluster) {
  if (!cluster.dense) return 3;
  return Math.max(7, Math.min(cluster.radius, 7 + Math.log2(cluster.count) * 3));
}

export default function ClusteredMapLayer({
  points = [],
  viewState,
  width = 1140,
  height = 540,
  onMarkerClick,
  style,
  ...clusterOptions
}) {
  const { clusters, backend, fallbackReasons, error, ready, hitTest } = useClusteredMap({
    points,
    viewState,
    width,
    height,
    ...clusterOptions,
  });

  const handleClick = useCallback(
    (event) => {
      if (!onMarkerClick) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = ((event.clientX - rect.left) * width) / (rect.width || width);
      const y = ((event.clientY - rect.top) * height) / (rect.height || height);
      const hit = hitTest(x, y);
      if (hit) onMarkerClick(hit);
    },
    [hitTest, onMarkerClick, width, height],
  );

  return (
    <svg
      data-testid="clustered-map-layer"
      data-backend={backend ?? "initialising"}
      data-fallback-reasons={JSON.stringify(fallbackReasons)}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      onClick={handleClick}
      aria-label={`${clusters.length} clustered emergency markers`}
      style={{ display: "block", width: "100%", height: "100%", ...style }}
    >
      {clusters.map((cluster, index) => {
        const r = clusterRadius(cluster);
        return (
          <g
            key={`${cluster.x.toFixed(2)}-${cluster.y.toFixed(2)}-${index}`}
            data-testid="cluster-marker"
            data-count={cluster.count}
            data-dense={String(cluster.dense)}
          >
            <circle
              cx={cluster.x}
              cy={cluster.y}
              r={r}
              fill={cluster.dense ? COLORS.dense : COLORS.sparse}
              fillOpacity={cluster.dense ? 0.85 : 0.75}
              stroke={cluster.dense ? COLORS.denseStroke : "none"}
              strokeWidth={cluster.dense ? 1.5 : 0}
            />
            {cluster.count > 1 && (
              <text
                x={cluster.x}
                y={cluster.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="11"
                fontFamily="VT323, monospace"
                fill={cluster.dense ? "#ECE0CC" : "#234B4E"}
              >
                {cluster.count}
              </text>
            )}
          </g>
        );
      })}
      {!ready && !error && (
        <title>Clustering backend starting…</title>
      )}
      {error && <title>{`Clustering unavailable: ${error}`}</title>}
    </svg>
  );
}
