import { installWorkerHooks } from "./workerSupervision.js";
const FANOUT = 16;
let tree = [];
let pointCount = 0;
let featuresByIndex = [];
let coordinateData = null;

function boundsOf(children) {
  return children.reduce((box, child) => ({
    minX: Math.min(box.minX, child.minX), minY: Math.min(box.minY, child.minY),
    maxX: Math.max(box.maxX, child.maxX), maxY: Math.max(box.maxY, child.maxY),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function bulkLoad(points) {
  if (!points.length) return [];
  let level = points.map((point, index) => ({ ...point, index, leaf: true }));
  while (level.length > FANOUT) {
    level.sort((a, b) => (a.minX + a.maxX) - (b.minX + b.maxX));
    const groups = [];
    const sliceSize = Math.ceil(level.length / FANOUT);
    for (let i = 0; i < level.length; i += sliceSize) {
      const slice = level.slice(i, i + sliceSize).sort((a, b) => (a.minY + a.maxY) - (b.minY + b.maxY));
      for (let j = 0; j < slice.length; j += FANOUT) {
        const children = slice.slice(j, j + FANOUT);
        groups.push({ ...boundsOf(children), children, leaf: false });
      }
    }
    level = groups;
  }
  return [{ ...boundsOf(level), children: level, leaf: false }];
}

function search(bounds) {
  const found = [];
  const stack = [...tree];
  while (stack.length) {
    const node = stack.pop();
    if (node.maxX < bounds[0] || node.minX > bounds[2] || node.maxY < bounds[1] || node.minY > bounds[3]) continue;
    if (node.leaf) found.push(node.index);
    else stack.push(...node.children);
  }
  return found;
}

// Error/heartbeat parity for null-origin workers (#793).
installWorkerHooks(self, "cluster-worker");
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'load') {
      const coords = new Float64Array(data.coordinates);
      coordinateData = coords;
      pointCount = data.features.length;
      const points = [];
      featuresByIndex = data.features;
      for (let i = 0; i < pointCount; i++) {
        const lng = coords[i * 2];
        const lat = coords[i * 2 + 1];
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
        points.push({ minX: lng, maxX: lng, minY: lat, maxY: lat, index: i, leaf: true });
      }
      tree = bulkLoad(points);
      self.postMessage({ id: data.id, type: 'loaded', count: points.length });
      return;
    }
    if (data.type === 'query') {
      const indices = search(data.bounds);
      const cellSize = 360 / (512 * 2 ** Math.max(0, Math.min(data.zoom || 0, 22))) * (data.radius || 60);
      const cells = new Map();
      const results = [];
      for (const index of indices) {
        const metadata = featuresByIndex[index];
        const feature = metadata && {
          ...metadata,
          geometry: { type: 'Point', coordinates: [coordinateData[index * 2], coordinateData[index * 2 + 1]] },
        };
        if (!feature) continue;
        const [lng, lat] = feature.geometry.coordinates;
        const key = `${Math.floor(lng / cellSize)}:${Math.floor(lat / cellSize)}`;
        const cell = cells.get(key) || [];
        cell.push(feature);
        cells.set(key, cell);
      }
      let clusterId = 0;
      for (const cell of cells.values()) {
        if (cell.length === 1 || (data.zoom || 0) >= 17) {
          results.push(...cell);
          continue;
        }
        const coordinates = cell.reduce((sum, feature) => [sum[0] + feature.geometry.coordinates[0], sum[1] + feature.geometry.coordinates[1]], [0, 0]);
        results.push({
          type: 'Feature',
          id: `cluster-${++clusterId}`,
          properties: { cluster: true, cluster_id: clusterId, point_count: cell.length, point_count_abbreviated: String(cell.length) },
          geometry: { type: 'Point', coordinates: [coordinates[0] / cell.length, coordinates[1] / cell.length] },
        });
      }
      self.postMessage({ id: data.id, type: 'result', features: results });
    }
  } catch (error) {
    self.postMessage({ id: data.id, type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
};
