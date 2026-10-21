import { useState, useEffect, useRef, useCallback } from 'react';
import { SpatialIndexClient } from '../lib/spatial.ts';

export function useClusterer(points, zoom, bounds, options = {}) {
  const [clusters, setClusters] = useState([]);
  const indexRef = useRef(null);
  const revision = useRef(0);

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

  return { clusters, supercluster: null, getClusterExpansionZoom };
}
