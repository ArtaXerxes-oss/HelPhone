/**
 * WASM Memory Pool — JS runtime (mirrors wasmMemory.ts)
 */
export const MAX_MEMORY_BYTES = 512 * 1024 * 1024;
export const WASM_PAGE_SIZE = 64 * 1024;
export const MAX_PAGES = MAX_MEMORY_BYTES / WASM_PAGE_SIZE;
const BUCKET_SIZES = [4 * 1024, 16 * 1024, 64 * 1024, 256 * 1024, 1 * 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];
function bucketFor(size) { for (const b of BUCKET_SIZES) if (size <= b) return b; return Math.ceil(size / WASM_PAGE_SIZE) * WASM_PAGE_SIZE; }
export class WasmMemoryPool {
  constructor(maxBytes = MAX_MEMORY_BYTES) {
    this.maxBytes = maxBytes;
    this.pools = new Map();
    for (const b of BUCKET_SIZES) this.pools.set(b, []);
    this.active = new Set();
    this.activeBytes = new Map();
    this.totalAllocated = 0; this.pooledBytes = 0; this.peakAllocated = 0; this.recycledCount = 0; this.allocationCount = 0;
  }
  allocate(size) {
    if (!Number.isFinite(size) || size <= 0) throw new Error(`Invalid allocation size: ${size}`);
    if (size > this.maxBytes) throw new Error(`Requested ${size} bytes exceeds max memory cap ${this.maxBytes} bytes (512MB)`);
    const bucket = bucketFor(size);
    if (this.totalAllocated + bucket > this.maxBytes) throw new Error(`WASM memory cap exceeded: ${this.totalAllocated} + ${bucket} > ${this.maxBytes} (512MB). Release buffers before allocating or reduce concurrent proofs.`);
    let buf; const pool = this.pools.get(bucket);
    if (pool && pool.length > 0) { buf = pool.pop(); this.pooledBytes -= bucket; this.recycledCount++; } else { buf = new ArrayBuffer(bucket); if (!this.pools.has(bucket)) this.pools.set(bucket, []); }
    this.allocationCount++; this.active.add(buf); this.activeBytes.set(buf, size); this.totalAllocated += bucket; this.peakAllocated = Math.max(this.peakAllocated, this.totalAllocated); return buf;
  }
  allocateUint8(size) { const buf = this.allocate(size); const arr = new Uint8Array(buf, 0, size); arr.fill(0); return arr; }
  allocateU32(length) { const bytes = length * 4; const buf = this.allocate(bytes); return new Uint32Array(buf, 0, length); }
  release(buf) {
    if (!buf) return;
    const ab = ArrayBuffer.isView(buf) ? buf.buffer : buf;
    if (!this.active.has(ab)) return;
    const bucket = ab.byteLength; this.active.delete(ab); this.activeBytes.delete(ab); this.totalAllocated -= bucket;
    try { new Uint8Array(ab).fill(0); } catch {}
    if (!this.pools.has(bucket)) this.pools.set(bucket, []);
    this.pools.get(bucket).push(ab); this.pooledBytes += bucket;
  }
  releaseAll() { let count = 0; for (const buf of [...this.active]) { this.release(buf); count++; } return count; }
  preallocate(buckets = { [64 * 1024]: 2, [1 * 1024 * 1024]: 2, [4 * 1024 * 1024]: 1 }) {
    for (const [sizeStr, count] of Object.entries(buckets)) {
      const size = Number(sizeStr); const c = count ?? 0; const bucket = bucketFor(size);
      if (this.totalAllocated + bucket * c > this.maxBytes) break;
      const pool = this.pools.get(bucket) ?? [];
      for (let i = 0; i < c; i++) { if (this.totalAllocated + bucket > this.maxBytes) break; pool.push(new ArrayBuffer(bucket)); this.pooledBytes += bucket; }
      this.pools.set(bucket, pool);
    }
  }
  getStats() {
    return {
      totalAllocated: this.totalAllocated, poolSize: this.pooledBytes,
      pooledBuffers: [...this.pools.values()].reduce((a, b) => a + b.length, 0),
      activeBuffers: this.active.size, peakAllocated: this.peakAllocated,
      recycledCount: this.recycledCount, allocationCount: this.allocationCount,
      recyclingRate: this.allocationCount ? this.recycledCount / this.allocationCount : 0,
      utilisationPct: (this.totalAllocated / this.maxBytes) * 100,
    };
  }
  assertCap(additionalBytes) { if (this.totalAllocated + additionalBytes > this.maxBytes) throw new Error(`WASM memory cap (512MB) would be exceeded by ${additionalBytes} bytes`); }
  destroy() { this.releaseAll(); for (const pool of this.pools.values()) pool.length = 0; this.pooledBytes = 0; this.totalAllocated = 0; this.active.clear(); this.activeBytes.clear(); }
  getPageCount() { return Math.ceil(this.totalAllocated / WASM_PAGE_SIZE); }
}
let singleton = null;
export function getWasmMemoryPool(maxBytes = MAX_MEMORY_BYTES) { if (!singleton) { singleton = new WasmMemoryPool(maxBytes); singleton.preallocate(); } return singleton; }
export function resetWasmMemoryPool() { if (singleton) singleton.destroy(); singleton = null; }
export function createWasmMemoryPool(maxBytes = MAX_MEMORY_BYTES) { return new WasmMemoryPool(maxBytes); }
export default WasmMemoryPool;
