/**
 * Offline routing worker (spike #606, ADR-006).
 *
 * Keeps pathfinding off the UI thread. The road graph arrives as a packed
 * (Shared)ArrayBuffer from `packGraph`, so loading it is a zero-copy view
 * rather than a structured clone of millions of numbers.
 *
 * Protocol (all messages carry an optional `id` echoed back in the reply):
 *   { type: "ping" }
 *   { type: "load", graph: ArrayBuffer|SharedArrayBuffer, ch?: ArrayBuffer }
 *   { type: "loadGeoJSON", geojson: object|string }      → builds + packs
 *   { type: "buildCH" }                                   → { ch: ArrayBuffer }
 *   { type: "route", from, to, algorithm: "astar"|"dijkstra"|"ch" }
 * Replies: { id, type: "<type>:ok", ... } or { id, type: "error", message }.
 *
 * Usage from the app:
 *   const worker = new Worker(
 *     new URL("./workers/routingWorker.js", import.meta.url),
 *     { type: "module" },
 *   );
 */

import {
  buildContractionHierarchy,
  buildGraphFromGeoJSON,
  chShortestPath,
  createChQueryContext,
  createSearchContext,
  packContractionHierarchy,
  packGraph,
  shortestPath,
  unpackContractionHierarchy,
  unpackGraph,
} from "../utils/graphTraversal.js";

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

export function createRoutingState() {
  return { graph: null, ch: null, search: null, chSearch: null };
}

/**
 * Pure message handler so it can be unit-tested (and reused by a Node
 * worker_threads harness) without a real Worker global.
 * Returns `{ reply, transfer }`.
 */
export function handleRoutingMessage(state, msg) {
  const id = msg && msg.id;
  try {
    switch (msg && msg.type) {
      case "ping":
        return reply(id, "ping:ok", {});
      case "load": {
        state.graph = unpackGraph(msg.graph);
        state.search = createSearchContext(state.graph.nodeCount);
        state.ch = msg.ch ? unpackContractionHierarchy(msg.ch) : null;
        state.chSearch = state.ch
          ? createChQueryContext(state.ch.nodeCount)
          : null;
        return reply(id, "load:ok", {
          nodeCount: state.graph.nodeCount,
          edgeCount: state.graph.edgeCount,
          hasCH: Boolean(state.ch),
        });
      }
      case "loadGeoJSON": {
        const t0 = now();
        const geojson =
          typeof msg.geojson === "string" ? JSON.parse(msg.geojson) : msg.geojson;
        const parsedMs = now() - t0;
        const buffer = packGraph(buildGraphFromGeoJSON(geojson), {
          shared: Boolean(msg.shared),
        });
        state.graph = unpackGraph(buffer);
        state.search = createSearchContext(state.graph.nodeCount);
        state.ch = null;
        state.chSearch = null;
        return reply(id, "loadGeoJSON:ok", {
          nodeCount: state.graph.nodeCount,
          edgeCount: state.graph.edgeCount,
          parsedMs,
          builtMs: now() - t0 - parsedMs,
          byteLength: buffer.byteLength,
        });
      }
      case "buildCH": {
        requireGraph(state);
        const t0 = now();
        const buffer = packContractionHierarchy(
          buildContractionHierarchy(state.graph, msg.options),
          { shared: Boolean(msg.shared) },
        );
        state.ch = unpackContractionHierarchy(buffer);
        state.chSearch = createChQueryContext(state.ch.nodeCount);
        const isShared =
          typeof SharedArrayBuffer !== "undefined" &&
          buffer instanceof SharedArrayBuffer;
        // Hand back a copy of the CH so the app can persist it (e.g. OPFS);
        // the worker keeps its own view.
        const copy = isShared ? buffer : buffer.slice(0);
        return {
          reply: {
            id,
            type: "buildCH:ok",
            shortcutCount: state.ch.shortcutCount,
            elapsedMs: now() - t0,
            ch: copy,
          },
          transfer: isShared ? [] : [copy],
        };
      }
      case "route": {
        requireGraph(state);
        const algorithm = msg.algorithm || "astar";
        const t0 = now();
        let result;
        if (algorithm === "ch") {
          if (!state.ch) throw new Error("Contraction hierarchy not built");
          result = chShortestPath(state.ch, msg.from, msg.to, {
            context: state.chSearch,
          });
        } else {
          result = shortestPath(state.graph, msg.from, msg.to, {
            context: state.search,
            heuristic: algorithm === "dijkstra" ? "none" : "euclidean",
          });
        }
        const elapsedMs = now() - t0;
        const coords = result.path ? pathToCoordinates(state.graph, result.path) : null;
        return {
          reply: {
            id,
            type: "route:ok",
            algorithm,
            distance: result.distance,
            expanded: result.expanded,
            relaxed: result.relaxed,
            elapsedMs,
            path: result.path,
            coordinates: coords,
          },
          transfer: [
            ...(result.path ? [result.path.buffer] : []),
            ...(coords ? [coords.buffer] : []),
          ],
        };
      }
      default:
        throw new Error(`Unknown routing message type: ${msg && msg.type}`);
    }
  } catch (err) {
    return reply(id, "error", { message: err && err.message ? err.message : String(err) });
  }
}

/** Flat [lng, lat, lng, lat, ...] suitable for a GeoJSON LineString. */
export function pathToCoordinates(graph, path) {
  const out = new Float64Array(path.length * 2);
  for (let i = 0; i < path.length; i++) {
    out[2 * i] = graph.lng[path[i]];
    out[2 * i + 1] = graph.lat[path[i]];
  }
  return out;
}

function requireGraph(state) {
  if (!state.graph) throw new Error("Routing graph not loaded");
}

function reply(id, type, body) {
  return { reply: { id, type, ...body }, transfer: [] };
}

// Attach to the worker global only when actually running as a worker.
if (
  typeof self !== "undefined" &&
  typeof self.postMessage === "function" &&
  typeof window === "undefined"
) {
  const state = createRoutingState();
  self.onmessage = (event) => {
    const { reply: out, transfer } = handleRoutingMessage(state, event.data);
    self.postMessage(out, transfer);
  };
}
