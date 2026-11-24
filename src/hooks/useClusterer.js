import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { SpatialIndexClient } from '../lib/spatial.ts';
import {
  DEFAULT_VIEWPORT_TRANSFORM,
  buildViewportOverlays,
} from '../lib/offscreenCanvas.ts';

export function useClusterer(points, zoom, bounds, options = {}) {
  const [clusters, setClusters] = useState([]);
  const indexRef = useRef(null);
  const revision = useRef(0);

  const viewportTransform = useMemo(() => {
    const bbox = bounds?.length === 4 ? bounds : DEFAULT_VIEWPORT_TRANSFORM.bounds;
    const z = Number.isFinite(zoom) ? zoom : DEFAULT_VIEWPORT_TRANSFORM.zoom;
    return {
      scale: typeof options.scale === 'number' && Number.isFinite(options.scale) ? options.scale : 1,
      offsetX: typeof options.offsetX === 'number' && Number.isFinite(options.offsetX) ? options.offsetX : 0,
      offsetY: typeof options.offsetY === 'number' && Number.isFinite(options.offsetY) ? options.offsetY : 0,
      zoom: z,
      bounds: bbox,
    };
  }, [zoom, bounds, options.scale, options.offsetX, options.offsetY]);

  useEffect(() => {
    if (typeof Worker === 'undefined') {
      setClusters([]);
      return undefined;
    }
    const index = new SpatialIndexClient();
    indexRef.current = index;
    return () => {
      index.destroy();
      indexRef.current = null;
    };
  }, []);

  useEffect(() => {
    const index = indexRef.current;
    const requestRevision = ++revision.current;
    if (!index || !Array.isArray(points) || points.length === 0) {
      setClusters([]);
      return;
    }
    const features = points.filter((point) => point && Number.isFinite(point.lat) && Number.isFinite(point.lng)).map((point) => ({
      type: 'Feature',
      id: point.id,
      properties: { ...point, pointId: point.id },
      geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
    }));
    const bbox = bounds?.length === 4 ? bounds : [-180, -85, 180, 85];
    void index.load(features)
      .then(() => index.query(bbox, Math.floor(zoom || 0), options.radius || 60))
      .then((result) => { if (requestRevision === revision.current) setClusters(result); })
      .catch(() => { if (requestRevision === revision.current) setClusters([]); });
  }, [points, zoom, bounds, options.radius]);

  const getClusterExpansionZoom = useCallback((clusterId) => {
    const cluster = clusters.find((item) => item.properties?.cluster_id === clusterId);
    return cluster ? Math.min(22, Math.floor(zoom || 0) + 2) : 18;
  }, [clusters, zoom]);

  const overlays = useMemo(() => {
    const size = options.size || { width: 1140, height: 540 };
    return buildViewportOverlays({
      points: Array.isArray(points) ? points : [],
      clusters,
      size,
      transform: viewportTransform,
    });
  }, [points, clusters, options.size, viewportTransform]);

  return { clusters, overlays, viewportTransform, supercluster: null, getClusterExpansionZoom };
}
