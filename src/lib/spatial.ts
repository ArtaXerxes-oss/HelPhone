export type SpatialFeature = {
  type: 'Feature'
  id?: string | number
  properties: Record<string, unknown>
  geometry: { type: 'Point'; coordinates: [number, number] }
}

export type SpatialBounds = [west: number, south: number, east: number, north: number]

type WorkerResponse = { id: number; type: 'loaded' | 'result' | 'error'; count?: number; features?: SpatialFeature[]; error?: string }

export class SpatialIndexClient {
  private worker: Worker
  private sequence = 0
  private pending = new Map<number, { resolve: (value: WorkerResponse) => void; reject: (error: Error) => void }>()

  constructor(worker = new Worker(new URL('../workers/cluster-worker.js', import.meta.url), { type: 'module' })) {
    this.worker = worker
    this.worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      const pending = this.pending.get(data.id)
      if (!pending) return
      this.pending.delete(data.id)
      if (data.type === 'error') pending.reject(new Error(data.error || 'Spatial index worker failed'))
      else pending.resolve(data)
    }
    this.worker.onerror = (event) => {
      for (const pending of this.pending.values()) pending.reject(new Error(event.message || 'Spatial index worker failed'))
      this.pending.clear()
    }
  }

  private request<T extends WorkerResponse>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: WorkerResponse) => void, reject })
      this.worker.postMessage({ ...message, id }, transfer)
    })
  }

  async load(features: SpatialFeature[]): Promise<void> {
    const valid = features.filter((feature) => {
      const [lng, lat] = feature.geometry.coordinates
      return Number.isFinite(lng) && Number.isFinite(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90
    })
    const coordinates = new Float64Array(valid.length * 2)
    valid.forEach((feature, index) => coordinates.set(feature.geometry.coordinates, index * 2))
    const metadata = valid.map(({ type, id, properties }) => ({ type, id, properties }))
    await this.request({ type: 'load', coordinates: coordinates.buffer, features: metadata }, [coordinates.buffer])
  }

  async query(bounds: SpatialBounds, zoom: number, radius = 60): Promise<SpatialFeature[]> {
    const result = await this.request<{ id: number; type: 'result'; features: SpatialFeature[] }>({ type: 'query', bounds, zoom, radius })
    return result.features || []
  }

  destroy(): void {
    this.worker.terminate()
    for (const pending of this.pending.values()) pending.reject(new Error('Spatial index destroyed'))
    this.pending.clear()
  }
}
