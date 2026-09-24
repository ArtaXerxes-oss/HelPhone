/**
 * WASM Linear Memory Pool & Buffer Recycling
 *
 * Manages a pre-allocated pool of WebAssembly ArrayBuffer pages to avoid
 * repeated WASM memory allocation during sequential Noir/Barretenberg proving runs.
 *
 * - Pre-allocates pools for common buffer sizes (64KB..16MB)
 * - Recycles typed array buffers across sequential runs
 * - Enforces 512MB upper bound to prevent browser tab crashes
 *
 * Used by src/lib/zk.ts and src/workers/zk-worker.js to wrap proof witnesses
 * and public inputs without leaking WASM linear memory.
 */

export const MAX_MEMORY_BYTES = 512 * 1024 * 1024; // 512MB
export const WASM_PAGE_SIZE = 64 * 1024; // 64KB per WASM page
export const MAX_PAGES = MAX_MEMORY_BYTES / WASM_PAGE_SIZE; // 8192 pages

// Common bucket sizes (powers-of-two friendly for WASM linear memory)
const BUCKET_SIZES = [
  4 * 1024,        // 4KB  - small scalars / nullifiers
  16 * 1024,       // 16KB
  64 * 1024,       // 64KB - 1 page
  256 * 1024,      // 256KB
  1 * 1024 * 1024, // 1MB  - typical witness
  4 * 1024 * 1024, // 4MB  - large witness/proof
  16 * 1024 * 1024,// 16MB - worst-case Barretenberg CRS chunk
] as const;

export interface WasmMemoryStats {
  totalAllocated: number; // bytes currently checked-out
  poolSize: number;       // total bytes held in pooled buffers
  pooledBuffers: number;  // count of idle pooled buffers
  activeBuffers: number;  // count of outstanding allocations
  peakAllocated: number;  // high-water mark
  recycledCount: number;  // # of allocations satisfied from pool
  allocationCount: number;// total allocations
  recyclingRate: number;  // recycled / total
  utilisationPct: number; // totalAllocated / MAX_MEMORY_BYTES *100
}

function bucketFor(size: number): number {
  for (const b of BUCKET_SIZES) if (size <= b) return b;
  // For sizes larger than 16MB, round up to next WASM page multiple
  return Math.ceil(size / WASM_PAGE_SIZE) * WASM_PAGE_SIZE;
}

export class WasmMemoryPool {
  private pools: Map<number, ArrayBuffer[]> = new Map();
  private active: Set<ArrayBuffer> = new Set();
  private activeBytes: Map<ArrayBuffer, number> = new Map(); // requested size vs bucket size
  private totalAllocated = 0;
  private pooledBytes = 0;
  private peakAllocated = 0;
  private recycledCount = 0;
  private allocationCount = 0;

  constructor(private readonly maxBytes: number = MAX_MEMORY_BYTES) {
    for (const b of BUCKET_SIZES) this.pools.set(b, []);
    // Allow dynamic buckets for >16MB
  }

  /** Allocate a buffer of at least `size` bytes, recycling if possible. */
  allocate(size: number): ArrayBuffer {
    if (!Number.isFinite(size) || size <= 0) throw new Error(`Invalid allocation size: ${size}`);
    if (size > this.maxBytes) throw new Error(`Requested ${size} bytes exceeds max memory cap ${this.maxBytes} bytes (512MB)`);

    const bucket = bucketFor(size);
    if (this.totalAllocated + bucket > this.maxBytes) {
      throw new Error(
        `WASM memory cap exceeded: ${this.totalAllocated} + ${bucket} > ${this.maxBytes} (512MB). ` +
        `Release buffers before allocating or reduce concurrent proofs.`
      );
    }

    let buf: ArrayBuffer | undefined;
    const pool = this.pools.get(bucket);
    if (pool && pool.length > 0) {
      buf = pool.pop()!;
      this.pooledBytes -= bucket;
      this.recycledCount++;
    } else {
      buf = new ArrayBuffer(bucket);
      // Dynamic bucket tracking
      if (!this.pools.has(bucket)) this.pools.set(bucket, []);
    }

    this.allocationCount++;
    this.active.add(buf);
    this.activeBytes.set(buf, size);
    this.totalAllocated += bucket;
    this.peakAllocated = Math.max(this.peakAllocated, this.totalAllocated);

    return buf;
  }

  /** Allocate and return a Uint8Array view (zero-filled). */
  allocateUint8(size: number): Uint8Array {
    const buf = this.allocate(size);
    const arr = new Uint8Array(buf, 0, size);
    arr.fill(0);
    return arr;
  }

  /** Allocate typed array variants (recycling underlying buffers). */
  allocateU32(length: number): Uint32Array {
    const bytes = length * 4;
    const buf = this.allocate(bytes);
    return new Uint32Array(buf, 0, length);
  }

  /** Release a buffer back to the pool for recycling. */
  release(buf: ArrayBuffer | ArrayBufferView | null | undefined): void {
    if (!buf) return;
    const ab: ArrayBuffer = ArrayBuffer.isView(buf) ? (buf as ArrayBufferView).buffer : (buf as ArrayBuffer);
    if (!this.active.has(ab)) {
      // Already released or foreign buffer — ignore to avoid double-free
      return;
    }
    const bucket = ab.byteLength;
    this.active.delete(ab);
    this.activeBytes.delete(ab);
    this.totalAllocated -= bucket;

    // Optionally zero to avoid leaking witness material
    try { new Uint8Array(ab).fill(0); } catch {}

    if (!this.pools.has(bucket)) this.pools.set(bucket, []);
    this.pools.get(bucket)!.push(ab);
    this.pooledBytes += bucket;
  }

  /** Release all active buffers (useful on prover reset/destroy). */
  releaseAll(): number {
    let count = 0;
    for (const buf of [...this.active]) {
      this.release(buf);
      count++;
    }
    return count;
  }

  /** Pre-warm the pool with commonly used buckets (avoids first-proof jank). */
  preallocate(buckets: Partial<Record<number, number>> = { [64 * 1024]: 2, [1 * 1024 * 1024]: 2, [4 * 1024 * 1024]: 1 }): void {
    for (const [sizeStr, count] of Object.entries(buckets)) {
      const size = Number(sizeStr);
      const c = count ?? 0;
      const bucket = bucketFor(size);
      if (this.totalAllocated + bucket * c > this.maxBytes) break;
      const pool = this.pools.get(bucket) ?? [];
      for (let i = 0; i < c; i++) {
        if (this.totalAllocated + bucket > this.maxBytes) break;
        pool.push(new ArrayBuffer(bucket));
        this.pooledBytes += bucket;
      }
      this.pools.set(bucket, pool);
    }
  }

  getStats(): WasmMemoryStats {
    return {
      totalAllocated: this.totalAllocated,
      poolSize: this.pooledBytes,
      pooledBuffers: [...this.pools.values()].reduce((a, b) => a + b.length, 0),
      activeBuffers: this.active.size,
      peakAllocated: this.peakAllocated,
      recycledCount: this.recycledCount,
      allocationCount: this.allocationCount,
      recyclingRate: this.allocationCount ? this.recycledCount / this.allocationCount : 0,
      utilisationPct: (this.totalAllocated / this.maxBytes) * 100,
    };
  }

  /** Enforces the 512MB cap — throws if allocation would exceed. */
  assertCap(additionalBytes: number): void {
    if (this.totalAllocated + additionalBytes > this.maxBytes) {
      throw new Error(`WASM memory cap (512MB) would be exceeded by ${additionalBytes} bytes`);
    }
  }

  /** Destroy all pooled memory (e.g. on page unload). */
  destroy(): void {
    this.releaseAll();
    for (const pool of this.pools.values()) pool.length = 0;
    this.pooledBytes = 0;
    this.totalAllocated = 0;
    this.active.clear();
    this.activeBytes.clear();
  }

  /** Low-level: expose WASM page count for diagnostics */
  getPageCount(): number {
    return Math.ceil(this.totalAllocated / WASM_PAGE_SIZE);
  }
}

// Singleton used by zk.js
let singleton: WasmMemoryPool | null = null;

export function getWasmMemoryPool(maxBytes = MAX_MEMORY_BYTES): WasmMemoryPool {
  if (!singleton) {
    singleton = new WasmMemoryPool(maxBytes);
    // Pre-warm common buckets so first proof doesn't trigger GC
    singleton.preallocate();
  }
  return singleton;
}

export function resetWasmMemoryPool(): void {
  if (singleton) singleton.destroy();
  singleton = null;
}

export function createWasmMemoryPool(maxBytes = MAX_MEMORY_BYTES): WasmMemoryPool {
  return new WasmMemoryPool(maxBytes);
}

// Convenience re-exports for workers that import this as ESM
export default WasmMemoryPool;
