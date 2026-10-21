/**
 * Offline client-side routing primitives (spike #606, ADR-006).
 *
 * Everything here operates on a compact CSR (compressed sparse row) graph made
 * of typed arrays so that:
 *   - the whole road network lives in ONE ArrayBuffer / SharedArrayBuffer that
 *     can be handed to a Web Worker without a structured-clone copy,
 *   - searches allocate nothing per query (typed-array scratch space reused
 *     via generation stamps), which keeps GC pauses out of the frame budget.
 *
 * Coordinates are projected once into a local equirectangular plane (metres)
 * and edge weights are polyline lengths in that same plane. That makes the
 * straight-line ("Euclidean") A* heuristic exactly admissible and consistent.
 * At city scale the projection error vs. true geodesic length is < 0.1 %.
 */

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

const GRAPH_MAGIC = 0x48504752; // "HPGR"
const CH_MAGIC = 0x48504348; // "HPCH"
const FORMAT_VERSION = 1;
const HEADER_WORDS = 8;

// ── Geometry ────────────────────────────────────────────────────────────────

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Returns a projector from lng/lat to local planar metres around refLat. */
export function createLocalProjection(refLat, refLng) {
  const kx = Math.cos(refLat * DEG) * EARTH_RADIUS_M * DEG;
  const ky = EARTH_RADIUS_M * DEG;
  return (lng, lat) => [(lng - refLng) * kx, (lat - refLat) * ky];
}

// ── Graph construction ──────────────────────────────────────────────────────

/**
 * Builds a CSR graph from explicit node coordinates and directed edges.
 * `edges` is a flat array [from, to, weight, from, to, weight, ...].
 */
export function buildCsrGraph({ lat, lng, x, y }, edges) {
  const nodeCount = lat.length;
  const edgeCount = edges.length / 3;
  const offsets = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < edges.length; i += 3) offsets[edges[i] + 1]++;
  for (let v = 0; v < nodeCount; v++) offsets[v + 1] += offsets[v];

  const cursor = offsets.slice(0, nodeCount);
  const targets = new Uint32Array(edgeCount);
  const weights = new Float64Array(edgeCount);
  for (let i = 0; i < edges.length; i += 3) {
    const slot = cursor[edges[i]]++;
    targets[slot] = edges[i + 1];
    weights[slot] = edges[i + 2];
  }
  return {
    nodeCount,
    edgeCount,
    lat: Float64Array.from(lat),
    lng: Float64Array.from(lng),
    x: Float64Array.from(x),
    y: Float64Array.from(y),
    offsets,
    targets,
    weights,
  };
}

/**
 * Parses a GeoJSON FeatureCollection of LineString / MultiLineString roads
 * into a routable CSR graph.
 *
 * Only line endpoints and coordinates shared by two or more lines become
 * graph nodes (intersections). Intermediate shape points contribute length
 * but not nodes, which is how production routers keep node counts small.
 * `properties.oneway` of `true`/`"yes"`/`1` makes a line one-directional.
 */
export function buildGraphFromGeoJSON(geojson, { precision = 1e6 } = {}) {
  const lines = [];
  for (const feature of geojson.features || []) {
    const geom = feature && feature.geometry;
    if (!geom) continue;
    const oneway = isOneway(feature.properties);
    if (geom.type === "LineString") lines.push([geom.coordinates, oneway]);
    else if (geom.type === "MultiLineString")
      for (const part of geom.coordinates) lines.push([part, oneway]);
  }

  const keyOf = (c) =>
    Math.round(c[0] * precision) + ":" + Math.round(c[1] * precision);

  // Pass 1: count how often each coordinate is used, to find intersections.
  const usage = new Map();
  let latSum = 0;
  let lngSum = 0;
  let coordCount = 0;
  for (const [coords] of lines) {
    for (let i = 0; i < coords.length; i++) {
      const k = keyOf(coords[i]);
      const isEnd = i === 0 || i === coords.length - 1;
      usage.set(k, (usage.get(k) || 0) + (isEnd ? 2 : 1));
      lngSum += coords[i][0];
      latSum += coords[i][1];
      coordCount++;
    }
  }
  const project = createLocalProjection(
    coordCount ? latSum / coordCount : 0,
    coordCount ? lngSum / coordCount : 0,
  );

  // Pass 2: assign node ids to intersections and emit edges between them.
  const ids = new Map();
  const lat = [];
  const lng = [];
  const x = [];
  const y = [];
  const edges = [];
  const nodeFor = (c, k) => {
    let id = ids.get(k);
    if (id === undefined) {
      id = lat.length;
      ids.set(k, id);
      const [px, py] = project(c[0], c[1]);
      lat.push(c[1]);
      lng.push(c[0]);
      x.push(px);
      y.push(py);
    }
    return id;
  };

  for (const [coords, oneway] of lines) {
    if (coords.length < 2) continue;
    let from = nodeFor(coords[0], keyOf(coords[0]));
    let length = 0;
    let [px, py] = project(coords[0][0], coords[0][1]);
    for (let i = 1; i < coords.length; i++) {
      const [cx, cy] = project(coords[i][0], coords[i][1]);
      length += Math.hypot(cx - px, cy - py);
      px = cx;
      py = cy;
      const k = keyOf(coords[i]);
      if (i === coords.length - 1 || usage.get(k) > 1) {
        const to = nodeFor(coords[i], k);
        if (to !== from) {
          edges.push(from, to, length);
          if (!oneway) edges.push(to, from, length);
        }
        from = to;
        length = 0;
      }
    }
  }
  return buildCsrGraph({ lat, lng, x, y }, edges);
}

function isOneway(props) {
  if (!props) return false;
  const v = props.oneway;
  return v === true || v === 1 || v === "yes" || v === "true" || v === "1";
}

// ── Zero-copy binary layout (worker hand-off) ───────────────────────────────

const GRAPH_FIELDS = (n, m) => [
  ["lat", Float64Array, n],
  ["lng", Float64Array, n],
  ["x", Float64Array, n],
  ["y", Float64Array, n],
  ["weights", Float64Array, m],
  ["offsets", Uint32Array, n + 1],
  ["targets", Uint32Array, m],
];

const CH_FIELDS = (n, mOut, mIn) => [
  ["outWeights", Float64Array, mOut],
  ["inWeights", Float64Array, mIn],
  ["rank", Uint32Array, n],
  ["outOffsets", Uint32Array, n + 1],
  ["outTargets", Uint32Array, mOut],
  ["outMids", Int32Array, mOut],
  ["inOffsets", Uint32Array, n + 1],
  ["inSources", Uint32Array, mIn],
  ["inMids", Int32Array, mIn],
];

function layout(fields) {
  let offset = HEADER_WORDS * 4;
  const placed = [];
  for (const [name, Type, length] of fields) {
    offset = Math.ceil(offset / Type.BYTES_PER_ELEMENT) * Type.BYTES_PER_ELEMENT;
    placed.push([name, Type, length, offset]);
    offset += length * Type.BYTES_PER_ELEMENT;
  }
  return { placed, byteLength: Math.ceil(offset / 8) * 8 };
}

function packFields(header, fields, source, shared) {
  const { placed, byteLength } = layout(fields);
  const buffer =
    shared && typeof SharedArrayBuffer !== "undefined"
      ? new SharedArrayBuffer(byteLength)
      : new ArrayBuffer(byteLength);
  new Uint32Array(buffer, 0, HEADER_WORDS).set(header);
  for (const [name, Type, length, offset] of placed)
    new Type(buffer, offset, length).set(source[name]);
  return buffer;
}

function viewFields(buffer, fields) {
  const out = {};
  for (const [name, Type, length, offset] of layout(fields).placed)
    out[name] = new Type(buffer, offset, length);
  return out;
}

/** Serialises a CSR graph into one (Shared)ArrayBuffer. */
export function packGraph(graph, { shared = false } = {}) {
  const { nodeCount: n, edgeCount: m } = graph;
  return packFields(
    [GRAPH_MAGIC, FORMAT_VERSION, n, m, 0, 0, 0, 0],
    GRAPH_FIELDS(n, m),
    graph,
    shared,
  );
}

/** Zero-copy view over a buffer produced by packGraph. */
export function unpackGraph(buffer) {
  const [magic, version, n, m] = new Uint32Array(buffer, 0, HEADER_WORDS);
  if (magic !== GRAPH_MAGIC || version !== FORMAT_VERSION)
    throw new Error("Not a HelPhone routing graph buffer");
  return { nodeCount: n, edgeCount: m, ...viewFields(buffer, GRAPH_FIELDS(n, m)) };
}

export function packContractionHierarchy(ch, { shared = false } = {}) {
  const n = ch.nodeCount;
  const mOut = ch.outTargets.length;
  const mIn = ch.inSources.length;
  return packFields(
    [CH_MAGIC, FORMAT_VERSION, n, mOut, mIn, ch.shortcutCount, 0, 0],
    CH_FIELDS(n, mOut, mIn),
    ch,
    shared,
  );
}

export function unpackContractionHierarchy(buffer) {
  const [magic, version, n, mOut, mIn, shortcutCount] = new Uint32Array(
    buffer,
    0,
    HEADER_WORDS,
  );
  if (magic !== CH_MAGIC || version !== FORMAT_VERSION)
    throw new Error("Not a HelPhone contraction hierarchy buffer");
  return {
    nodeCount: n,
    shortcutCount,
    ...viewFields(buffer, CH_FIELDS(n, mOut, mIn)),
  };
}

// ── Priority queue ──────────────────────────────────────────────────────────

/**
 * Binary min-heap keyed by node id with decrease/increase-key support.
 * Backed by preallocated typed arrays: zero allocation after construction.
 */
export class IndexedMinHeap {
  constructor(capacity) {
    this.nodes = new Uint32Array(capacity);
    this.keys = new Float64Array(capacity);
    this.pos = new Int32Array(capacity).fill(-1);
    this.size = 0;
  }

  clear() {
    for (let i = 0; i < this.size; i++) this.pos[this.nodes[i]] = -1;
    this.size = 0;
  }

  has(node) {
    return this.pos[node] !== -1;
  }

  peekKey() {
    return this.size ? this.keys[0] : Infinity;
  }

  /** Inserts `node` or moves it to `key` (up or down). */
  set(node, key) {
    let i = this.pos[node];
    if (i === -1) {
      i = this.size++;
      this.nodes[i] = node;
      this.keys[i] = key;
      this.pos[node] = i;
      this.#up(i);
    } else {
      const old = this.keys[i];
      this.keys[i] = key;
      if (key < old) this.#up(i);
      else this.#down(i);
    }
  }

  pop() {
    const top = this.nodes[0];
    this.pos[top] = -1;
    const last = --this.size;
    if (last > 0) {
      this.nodes[0] = this.nodes[last];
      this.keys[0] = this.keys[last];
      this.pos[this.nodes[0]] = 0;
      this.#down(0);
    }
    return top;
  }

  #up(i) {
    const { nodes, keys, pos } = this;
    const node = nodes[i];
    const key = keys[i];
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      nodes[i] = nodes[p];
      keys[i] = keys[p];
      pos[nodes[i]] = i;
      i = p;
    }
    nodes[i] = node;
    keys[i] = key;
    pos[node] = i;
  }

  #down(i) {
    const { nodes, keys, pos, size } = this;
    const node = nodes[i];
    const key = keys[i];
    for (;;) {
      let c = 2 * i + 1;
      if (c >= size) break;
      if (c + 1 < size && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= key) break;
      nodes[i] = nodes[c];
      keys[i] = keys[c];
      pos[nodes[i]] = i;
      i = c;
    }
    nodes[i] = node;
    keys[i] = key;
    pos[node] = i;
  }
}

// ── Reusable search scratch space ───────────────────────────────────────────

/**
 * Per-graph scratch buffers. `stamp[v] === gen` means dist/prev of v are
 * valid for the current query, so resetting is O(1) instead of O(n).
 */
export function createSearchContext(nodeCount) {
  return {
    dist: new Float64Array(nodeCount),
    prev: new Int32Array(nodeCount),
    stamp: new Uint32Array(nodeCount),
    settled: new Uint32Array(nodeCount),
    heap: new IndexedMinHeap(nodeCount),
    gen: 0,
  };
}

function nextGeneration(ctx) {
  ctx.heap.clear();
  ctx.gen++;
  if (ctx.gen === 0xffffffff) {
    ctx.stamp.fill(0);
    ctx.settled.fill(0);
    ctx.gen = 1;
  }
  return ctx.gen;
}

function assertNode(graph, v, label) {
  if (!Number.isInteger(v) || v < 0 || v >= graph.nodeCount)
    throw new RangeError(`${label} node ${v} is out of range`);
}

function tracePath(prev, source, target) {
  const reversed = [target];
  for (let v = target; v !== source; ) {
    v = prev[v];
    reversed.push(v);
  }
  return Uint32Array.from(reversed.reverse());
}

// ── Dijkstra / A* ───────────────────────────────────────────────────────────

/**
 * Point-to-point shortest path. With `heuristic: "euclidean"` this is A*,
 * with `heuristic: "none"` it is plain Dijkstra.
 *
 * Returns { distance, path, expanded, relaxed }. `distance` is Infinity and
 * `path` is null when the target is unreachable.
 */
export function shortestPath(graph, source, target, options = {}) {
  assertNode(graph, source, "source");
  assertNode(graph, target, "target");
  const ctx = options.context || createSearchContext(graph.nodeCount);
  const useHeuristic = (options.heuristic || "none") === "euclidean";
  const { offsets, targets, weights, x, y } = graph;
  const { dist, prev, stamp, settled, heap } = ctx;
  const gen = nextGeneration(ctx);
  const tx = x[target];
  const ty = y[target];
  const h = (v) => (useHeuristic ? Math.hypot(x[v] - tx, y[v] - ty) : 0);

  dist[source] = 0;
  prev[source] = -1;
  stamp[source] = gen;
  heap.set(source, h(source));

  let expanded = 0;
  let relaxed = 0;
  while (heap.size) {
    const u = heap.pop();
    settled[u] = gen;
    expanded++;
    if (u === target) break;
    const du = dist[u];
    for (let e = offsets[u], end = offsets[u + 1]; e < end; e++) {
      const v = targets[e];
      if (settled[v] === gen) continue;
      const nd = du + weights[e];
      if (stamp[v] !== gen || nd < dist[v]) {
        stamp[v] = gen;
        dist[v] = nd;
        prev[v] = u;
        heap.set(v, nd + h(v));
        relaxed++;
      }
    }
  }

  const reached = stamp[target] === gen && settled[target] === gen;
  return {
    distance: reached ? dist[target] : Infinity,
    path: reached ? tracePath(prev, source, target) : null,
    expanded,
    relaxed,
  };
}

export const dijkstra = (graph, s, t, opts = {}) =>
  shortestPath(graph, s, t, { ...opts, heuristic: "none" });

export const aStar = (graph, s, t, opts = {}) =>
  shortestPath(graph, s, t, { ...opts, heuristic: "euclidean" });

// ── Contraction Hierarchies ─────────────────────────────────────────────────

/**
 * Preprocesses `graph` into a Contraction Hierarchy (directed-safe).
 *
 * Nodes are contracted in order of a lazily-updated priority
 * (edge difference + contracted neighbours + level). Each contraction adds
 * shortcut edges u→x (via v) unless a bounded "witness" search proves a
 * path u→x that avoids v is no longer. The result is two upward CSR graphs:
 * `out*` (forward search) and `in*` (backward search), plus `*Mids` giving
 * the contracted middle node of each shortcut (-1 for original edges).
 */
export function buildContractionHierarchy(graph, options = {}) {
  const n = graph.nodeCount;
  const settleLimit = options.witnessSettleLimit ?? 64;
  const [wEd, wDel, wLvl] = options.priorityWeights ?? [2, 1, 1];
  const eagerUpdates = options.eagerNeighbourUpdates ?? false;
  const onProgress = options.onProgress;
  const outAdj = new Array(n);
  const inAdj = new Array(n);
  for (let v = 0; v < n; v++) {
    outAdj[v] = new Map();
    inAdj[v] = new Map();
  }
  const addEdge = (u, v, w, mid) => {
    const existing = outAdj[u].get(v);
    if (existing && existing.w <= w) return false;
    const edge = { w, mid };
    outAdj[u].set(v, edge);
    inAdj[v].set(u, edge);
    return true;
  };
  for (let u = 0; u < n; u++)
    for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++)
      if (graph.targets[e] !== u) addEdge(u, graph.targets[e], graph.weights[e], -1);

  const deleted = new Uint32Array(n);
  const level = new Uint32Array(n);
  const rank = new Uint32Array(n);
  const witness = createSearchContext(n);
  const pending = [];

  // Bounded Dijkstra from `src` in the remaining graph, skipping `skip`.
  const witnessSearch = (src, skip, maxDist) => {
    const gen = nextGeneration(witness);
    const { dist, stamp, settled, heap } = witness;
    dist[src] = 0;
    stamp[src] = gen;
    heap.set(src, 0);
    let count = 0;
    while (heap.size && heap.peekKey() <= maxDist && count < settleLimit) {
      const u = heap.pop();
      settled[u] = gen;
      count++;
      for (const [v, edge] of outAdj[u]) {
        if (v === skip || settled[v] === gen) continue;
        const nd = dist[u] + edge.w;
        if (stamp[v] !== gen || nd < dist[v]) {
          stamp[v] = gen;
          dist[v] = nd;
          heap.set(v, nd);
        }
      }
    }
    return gen;
  };

  // Collects the shortcuts contracting v would require into `pending`.
  const findShortcuts = (v) => {
    pending.length = 0;
    const outs = outAdj[v];
    if (outs.size === 0) return 0;
    for (const [u, inEdge] of inAdj[v]) {
      let maxNeeded = 0;
      for (const [x, outEdge] of outs)
        if (x !== u) maxNeeded = Math.max(maxNeeded, inEdge.w + outEdge.w);
      if (maxNeeded === 0) continue;
      const gen = witnessSearch(u, v, maxNeeded);
      for (const [x, outEdge] of outs) {
        if (x === u) continue;
        const need = inEdge.w + outEdge.w;
        if (witness.stamp[x] === gen && witness.dist[x] <= need) continue;
        pending.push(u, x, need);
      }
    }
    return pending.length / 3;
  };

  const priority = (v) =>
    wEd * (findShortcuts(v) - outAdj[v].size - inAdj[v].size) +
    wDel * deleted[v] +
    wLvl * level[v];

  const order = new IndexedMinHeap(n);
  for (let v = 0; v < n; v++) order.set(v, priority(v));

  const upOut = [];
  const upIn = [];
  let shortcutCount = 0;
  let contractedCount = 0;

  while (order.size) {
    const v = order.pop();
    const p = priority(v); // also refreshes `pending` for v
    if (order.size && p > order.peekKey()) {
      order.set(v, p);
      continue;
    }
    for (let i = 0; i < pending.length; i += 3)
      if (addEdge(pending[i], pending[i + 1], pending[i + 2], v)) shortcutCount++;

    rank[v] = contractedCount++;
    const neighbours = new Set();
    for (const [x, edge] of outAdj[v]) {
      upOut.push(v, x, edge.w, edge.mid);
      inAdj[x].delete(v);
      neighbours.add(x);
    }
    for (const [u, edge] of inAdj[v]) {
      upIn.push(v, u, edge.w, edge.mid);
      outAdj[u].delete(v);
      neighbours.add(u);
    }
    outAdj[v] = null;
    inAdj[v] = null;
    for (const w of neighbours) {
      deleted[w]++;
      level[w] = Math.max(level[w], level[v] + 1);
      if (eagerUpdates) order.set(w, priority(w));
    }
    if (onProgress && contractedCount % 5000 === 0)
      onProgress({ contracted: contractedCount, total: n, shortcutCount });
  }

  const out = toUpwardCsr(n, upOut);
  const inn = toUpwardCsr(n, upIn);
  return {
    nodeCount: n,
    shortcutCount,
    rank,
    outOffsets: out.offsets,
    outTargets: out.others,
    outWeights: out.weights,
    outMids: out.mids,
    inOffsets: inn.offsets,
    inSources: inn.others,
    inWeights: inn.weights,
    inMids: inn.mids,
  };
}

function toUpwardCsr(n, flat) {
  const m = flat.length / 4;
  const offsets = new Uint32Array(n + 1);
  for (let i = 0; i < flat.length; i += 4) offsets[flat[i] + 1]++;
  for (let v = 0; v < n; v++) offsets[v + 1] += offsets[v];
  const cursor = offsets.slice(0, n);
  const others = new Uint32Array(m);
  const weights = new Float64Array(m);
  const mids = new Int32Array(m);
  for (let i = 0; i < flat.length; i += 4) {
    const slot = cursor[flat[i]]++;
    others[slot] = flat[i + 1];
    weights[slot] = flat[i + 2];
    mids[slot] = flat[i + 3];
  }
  return { offsets, others, weights, mids };
}

/** Scratch space for CH queries (two search contexts). */
export function createChQueryContext(nodeCount) {
  return {
    forward: createSearchContext(nodeCount),
    backward: createSearchContext(nodeCount),
  };
}

/**
 * Bidirectional upward Dijkstra over a Contraction Hierarchy, followed by
 * recursive shortcut unpacking into an original-graph node path.
 */
export function chShortestPath(ch, source, target, options = {}) {
  assertNode(ch, source, "source");
  assertNode(ch, target, "target");
  const ctx = options.context || createChQueryContext(ch.nodeCount);
  const f = ctx.forward;
  const b = ctx.backward;
  const fGen = nextGeneration(f);
  const bGen = nextGeneration(b);

  f.dist[source] = 0;
  f.prev[source] = -1;
  f.stamp[source] = fGen;
  f.heap.set(source, 0);
  b.dist[target] = 0;
  b.prev[target] = -1;
  b.stamp[target] = bGen;
  b.heap.set(target, 0);

  let best = Infinity;
  let meet = -1;
  let expanded = 0;
  let relaxed = 0;

  const step = (side, gen, other, otherGen, offsets, ends, weights) => {
    const u = side.heap.pop();
    side.settled[u] = gen;
    expanded++;
    const du = side.dist[u];
    if (other.stamp[u] === otherGen && du + other.dist[u] < best) {
      best = du + other.dist[u];
      meet = u;
    }
    for (let e = offsets[u], end = offsets[u + 1]; e < end; e++) {
      const v = ends[e];
      const nd = du + weights[e];
      if (side.stamp[v] !== gen || nd < side.dist[v]) {
        side.stamp[v] = gen;
        side.dist[v] = nd;
        side.prev[v] = u;
        side.heap.set(v, nd);
        relaxed++;
      }
    }
  };

  for (;;) {
    const fMin = f.heap.size ? f.heap.peekKey() : Infinity;
    const bMin = b.heap.size ? b.heap.peekKey() : Infinity;
    const fActive = fMin < best;
    const bActive = bMin < best;
    if (!fActive && !bActive) break;
    if (fActive && (!bActive || fMin <= bMin))
      step(f, fGen, b, bGen, ch.outOffsets, ch.outTargets, ch.outWeights);
    else step(b, bGen, f, fGen, ch.inOffsets, ch.inSources, ch.inWeights);
  }

  if (meet === -1) return { distance: Infinity, path: null, expanded, relaxed };

  const upHalf = [];
  for (let v = meet; v !== -1; v = f.prev[v]) upHalf.push(v);
  upHalf.reverse();
  const downHalf = [];
  for (let v = b.prev[meet]; v !== -1; v = b.prev[v]) downHalf.push(v);
  const chPath = upHalf.concat(downHalf);

  const path = [chPath[0]];
  for (let i = 1; i < chPath.length; i++)
    unpackEdge(ch, chPath[i - 1], chPath[i], path);
  return { distance: best, path: Uint32Array.from(path), expanded, relaxed };
}

function findChEdge(ch, from, to) {
  // An edge from→to is stored at its lower-ranked endpoint.
  let bestW = Infinity;
  let mid = -1;
  if (ch.rank[from] < ch.rank[to]) {
    for (let e = ch.outOffsets[from]; e < ch.outOffsets[from + 1]; e++)
      if (ch.outTargets[e] === to && ch.outWeights[e] < bestW) {
        bestW = ch.outWeights[e];
        mid = ch.outMids[e];
      }
  } else {
    for (let e = ch.inOffsets[to]; e < ch.inOffsets[to + 1]; e++)
      if (ch.inSources[e] === from && ch.inWeights[e] < bestW) {
        bestW = ch.inWeights[e];
        mid = ch.inMids[e];
      }
  }
  if (bestW === Infinity) throw new Error(`CH edge ${from}->${to} missing`);
  return mid;
}

function unpackEdge(ch, from, to, out) {
  // Iterative to avoid deep recursion on long shortcut chains.
  const stack = [to, from];
  while (stack.length) {
    const a = stack.pop();
    const b = stack.pop();
    const mid = findChEdge(ch, a, b);
    if (mid === -1) out.push(b);
    else stack.push(b, mid, mid, a);
  }
}

// ── Synthetic road network generator (benchmarks & tests) ───────────────────

/** Deterministic mulberry32 PRNG. */
export function createRng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a jittered-grid road network as GeoJSON: `rows × cols`
 * intersections, each street segment a LineString with `shapePoints`
 * intermediate vertices, ~`dropRate` segments removed and ~`onewayRate`
 * segments made one-way. Roughly 250 bytes per segment when serialised,
 * so 317×317 with 3 shape points ≈ 50 MB — the spike's target payload.
 */
export function generateRoadNetworkGeoJSON({
  rows = 100,
  cols = 100,
  spacingDeg = 0.001,
  origin = [3.3792, 6.5244], // Lagos, lng/lat
  shapePoints = 3,
  dropRate = 0.08,
  onewayRate = 0.1,
  seed = 42,
} = {}) {
  const rand = createRng(seed);
  const jitter = spacingDeg * 0.2;
  const pts = new Array(rows * cols);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      pts[r * cols + c] = [
        origin[0] + c * spacingDeg + (rand() - 0.5) * jitter,
        origin[1] + r * spacingDeg + (rand() - 0.5) * jitter,
      ];

  const features = [];
  const segment = (a, b, name) => {
    if (rand() < dropRate) return;
    const coords = [a];
    for (let i = 1; i <= shapePoints; i++) {
      const t = i / (shapePoints + 1);
      coords.push([
        a[0] + (b[0] - a[0]) * t + (rand() - 0.5) * jitter * 0.3,
        a[1] + (b[1] - a[1]) * t + (rand() - 0.5) * jitter * 0.3,
      ]);
    }
    coords.push(b);
    features.push({
      type: "Feature",
      properties: {
        highway: "residential",
        name,
        oneway: rand() < onewayRate ? "yes" : "no",
      },
      geometry: { type: "LineString", coordinates: coords },
    });
  };
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c + 1 < cols) segment(pts[i], pts[i + 1], `Row ${r}`);
      if (r + 1 < rows) segment(pts[i], pts[i + cols], `Col ${c}`);
    }
  return { type: "FeatureCollection", features };
}
