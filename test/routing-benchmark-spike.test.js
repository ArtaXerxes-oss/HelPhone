import { describe, expect, it } from 'vitest'
import { decodeGraph, dijkstra, encodeGraph, graphMemoryBytes } from '../src/lib/routing.ts'

function lineGraph(nodes = 50_000, edgeKm = 0.1) {
  const offsets = new Uint32Array(nodes + 1)
  const targets = new Uint32Array((nodes - 1) * 2)
  const weights = new Float32Array(targets.length)
  let edge = 0
  for (let node = 0; node < nodes; node++) {
    offsets[node] = edge
    if (node) { targets[edge] = node - 1; weights[edge++] = edgeKm }
    if (node + 1 < nodes) { targets[edge] = node + 1; weights[edge++] = edgeKm }
  }
  offsets[nodes] = edge
  return { nodeCount: nodes, offsets, targets, weights }
}

describe('routing benchmark spike #582', () => {
  it('loads a 50,000-node graph in a bounded typed-array footprint', () => {
    const graph = lineGraph()
    expect(graphMemoryBytes(graph)).toBeLessThan(1_100_000)
    expect(decodeGraph(encodeGraph(graph)).nodeCount).toBe(50_000)
  })

  it.each([1, 5, 10, 25, 50])('benchmarks a %dkm Dijkstra route', (km) => {
    const graph = lineGraph()
    const started = performance.now()
    const route = dijkstra(graph, 0, km * 10)
    expect(route?.distanceKm).toBeCloseTo(km, 3)
    expect(performance.now() - started).toBeLessThan(250)
  })

  it('is at least 75% smaller than object-heavy JSON adjacency', () => {
    const graph = lineGraph(2_000)
    const binaryBytes = encodeGraph(graph).byteLength
    const jsonBytes = Buffer.byteLength(JSON.stringify(Array.from({ length: graph.nodeCount }, (_, node) => ({
      id: node,
      edges: Array.from(graph.targets.slice(graph.offsets[node], graph.offsets[node + 1]), (to, index) => ({ to, weight: graph.weights[graph.offsets[node] + index] })),
    }))))
    expect(binaryBytes / jsonBytes).toBeLessThan(0.25)
  })
})
