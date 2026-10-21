import type { RoadNetworkDocument, RouteResult, SpatialGraph } from '../types/index.ts'

const MAGIC = 0x48505247
const HEADER_WORDS = 4

export function graphFromDocument(document: RoadNetworkDocument): SpatialGraph {
  if (document.format !== 'helphone-csr-v1') throw new Error('Unsupported road graph format')
  const offsets = Uint32Array.from(document.offsets)
  const targets = Uint32Array.from(document.targets)
  const weights = Float32Array.from(document.weights)
  if (offsets.length !== document.nodeCount + 1 || targets.length !== weights.length || offsets.at(-1) !== targets.length) throw new Error('Invalid CSR road graph')
  return { nodeCount: document.nodeCount, offsets, targets, weights }
}

export function encodeGraph(graph: SpatialGraph): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_WORDS * 4 + graph.offsets.byteLength + graph.targets.byteLength + graph.weights.byteLength)
  new Uint32Array(buffer, 0, HEADER_WORDS).set([MAGIC, 1, graph.nodeCount, graph.targets.length])
  let offset = HEADER_WORDS * 4
  new Uint32Array(buffer, offset, graph.offsets.length).set(graph.offsets); offset += graph.offsets.byteLength
  new Uint32Array(buffer, offset, graph.targets.length).set(graph.targets); offset += graph.targets.byteLength
  new Float32Array(buffer, offset, graph.weights.length).set(graph.weights)
  return buffer
}

export function decodeGraph(buffer: ArrayBuffer): SpatialGraph {
  if (buffer.byteLength < HEADER_WORDS * 4) throw new Error('Truncated road graph')
  const header = new Uint32Array(buffer, 0, HEADER_WORDS)
  if (header[0] !== MAGIC || header[1] !== 1) throw new Error('Invalid road graph header')
  const [, , nodeCount, edgeCount] = header
  const expected = HEADER_WORDS * 4 + (nodeCount + 1 + edgeCount * 2) * 4
  if (buffer.byteLength !== expected) throw new Error('Invalid road graph length')
  let offset = HEADER_WORDS * 4
  const offsets = new Uint32Array(buffer.slice(offset, offset + (nodeCount + 1) * 4)); offset += (nodeCount + 1) * 4
  const targets = new Uint32Array(buffer.slice(offset, offset + edgeCount * 4)); offset += edgeCount * 4
  const weights = new Float32Array(buffer.slice(offset, offset + edgeCount * 4))
  return { nodeCount, offsets, targets, weights }
}

export async function loadRoadNetwork(url = '/data/road-network.json'): Promise<SpatialGraph> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Road graph request failed: ${response.status}`)
  return graphFromDocument(await response.json() as RoadNetworkDocument)
}

class MinHeap {
  private values: Array<[number, number]> = []
  push(value: [number, number]) { this.values.push(value); this.up(this.values.length - 1) }
  pop(): [number, number] | undefined { if (!this.values.length) return undefined; const top = this.values[0]; const tail = this.values.pop()!; if (this.values.length) { this.values[0] = tail; this.down(0) } return top }
  get size() { return this.values.length }
  private up(index: number) { while (index) { const parent = (index - 1) >> 1; if (this.values[parent][0] <= this.values[index][0]) break; [this.values[parent], this.values[index]] = [this.values[index], this.values[parent]]; index = parent } }
  private down(index: number) { for (;;) { let smallest = index; const left = index * 2 + 1; const right = left + 1; if (left < this.values.length && this.values[left][0] < this.values[smallest][0]) smallest = left; if (right < this.values.length && this.values[right][0] < this.values[smallest][0]) smallest = right; if (smallest === index) return; [this.values[smallest], this.values[index]] = [this.values[index], this.values[smallest]]; index = smallest } }
}

export function dijkstra(graph: SpatialGraph, source: number, destination: number): RouteResult | null {
  if (source < 0 || destination < 0 || source >= graph.nodeCount || destination >= graph.nodeCount) throw new RangeError('Node outside graph')
  const distance = new Float64Array(graph.nodeCount); distance.fill(Infinity); distance[source] = 0
  const previous = new Int32Array(graph.nodeCount); previous.fill(-1)
  const queue = new MinHeap(); queue.push([0, source])
  let visited = 0
  while (queue.size) {
    const [cost, node] = queue.pop()!
    if (cost !== distance[node]) continue
    visited++
    if (node === destination) break
    for (let edge = graph.offsets[node]; edge < graph.offsets[node + 1]; edge++) {
      const next = graph.targets[edge]; const candidate = cost + graph.weights[edge]
      if (candidate < distance[next]) { distance[next] = candidate; previous[next] = node; queue.push([candidate, next]) }
    }
  }
  if (!Number.isFinite(distance[destination])) return null
  const path: number[] = []
  for (let node = destination; node !== -1; node = previous[node]) path.push(node)
  return { distanceKm: distance[destination], path: path.reverse(), visitedNodes: visited }
}

export const graphMemoryBytes = (graph: SpatialGraph) => graph.offsets.byteLength + graph.targets.byteLength + graph.weights.byteLength
