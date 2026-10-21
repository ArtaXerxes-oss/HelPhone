import { describe, it, expect, beforeEach } from 'vitest';
import { createWasmMemoryPool, MAX_MEMORY_BYTES, WASM_PAGE_SIZE, getWasmMemoryPool, resetWasmMemoryPool } from '../src/lib/wasmMemory.js';

describe('WASM Linear Memory Pooling & Buffer Recycling', () => {
  let pool;

  beforeEach(() => {
    resetWasmMemoryPool();
    pool = createWasmMemoryPool();
  });

  it('exposes 512MB cap and WASM page constants', () => {
    expect(MAX_MEMORY_BYTES).toBe(512 * 1024 * 1024);
    expect(WASM_PAGE_SIZE).toBe(64 * 1024);
    expect(MAX_MEMORY_BYTES / WASM_PAGE_SIZE).toBe(8192);
  });

  it('allocates and recycles buffers across sequential proving runs', () => {
    const buf1 = pool.allocate(1024);
    expect(buf1.byteLength).toBeGreaterThanOrEqual(1024);
    const statsAfterAlloc = pool.getStats();
    expect(statsAfterAlloc.activeBuffers).toBe(1);
    expect(statsAfterAlloc.allocationCount).toBe(1);
    expect(statsAfterAlloc.recycledCount).toBe(0);

    pool.release(buf1);
    expect(pool.getStats().activeBuffers).toBe(0);
    expect(pool.getStats().pooledBuffers).toBe(1);

    const buf2 = pool.allocate(1024);
    // Should be recycled (same pooled buffer)
    expect(pool.getStats().recycledCount).toBe(1);
    expect(pool.getStats().recyclingRate).toBeCloseTo(0.5);
    // The pool should hand back the same ArrayBuffer object when bucket matches
    expect(buf2).toBe(buf1);

    pool.release(buf2);
  });

  it('enforces strict 512MB upper bound', () => {
    // Allocate many 16MB chunks should hit cap
    const bufs = [];
    // Warm iteration: allocate 32 *16MB = 512MB exactly
    for (let i = 0; i < 32; i++) bufs.push(pool.allocate(16 * 1024 * 1024));
    expect(pool.getStats().totalAllocated).toBe(512 * 1024 * 1024);
    expect(pool.getStats().utilisationPct).toBe(100);
    expect(() => pool.allocate(1024)).toThrow(/512MB|cap exceeded/i);

    // Releasing one should allow another
    pool.release(bufs.pop());
    expect(() => pool.allocate(1024)).not.toThrow();
    for (const b of bufs) pool.release(b);
    expect(pool.getStats().totalAllocated).toBeLessThan(MAX_MEMORY_BYTES);
  });

  it('zero-fills released buffers to avoid leaking witness material', () => {
    const arr = pool.allocateUint8(256);
    arr.fill(0xFF);
    const ab = arr.buffer;
    pool.release(arr);
    // After release, buffer is zeroed
    expect(new Uint8Array(ab)[0]).toBe(0);
    // Re-allocated view is zeroed as well
    const arr2 = pool.allocateUint8(256);
    expect(arr2[0]).toBe(0);
    expect(arr2[255]).toBe(0);
    pool.release(arr2);
  });

  it('preallocates common buckets and reuses them', () => {
    const p = createWasmMemoryPool();
    p.preallocate({ [64 * 1024]: 2, [1 * 1024 * 1024]: 1 });
    const s = p.getStats();
    expect(s.poolSize).toBe(64 * 1024 * 2 + 1 * 1024 * 1024);
    // Allocating 60KB should recycle 64KB bucket
    const buf = p.allocate(60 * 1024);
    expect(buf.byteLength).toBe(64 * 1024);
    expect(p.getStats().recycledCount).toBe(1);
    p.release(buf);
    p.destroy();
  });

  it('handles U32 typed array allocation via pool', () => {
    const u32 = pool.allocateU32(1024); // 4096 bytes -> 4KB bucket
    expect(u32.length).toBe(1024);
    expect(u32.byteLength).toBe(4096);
    expect(u32.buffer.byteLength).toBeGreaterThanOrEqual(4096);
    pool.release(u32);
    expect(pool.getStats().activeBuffers).toBe(0);
  });

  it('singleton getWasmMemoryPool pre-warms and is reusable', () => {
    const s1 = getWasmMemoryPool();
    const s2 = getWasmMemoryPool();
    expect(s1).toBe(s2);
    expect(s1.getStats().poolSize).toBeGreaterThan(0);
    resetWasmMemoryPool();
    const s3 = getWasmMemoryPool();
    expect(s3).not.toBe(s1);
    resetWasmMemoryPool();
  });

  it('destroy releases all and resets stats', () => {
    const a = pool.allocate(1024);
    const b = pool.allocate(64 * 1024);
    expect(pool.getStats().totalAllocated).toBeGreaterThan(0);
    pool.destroy();
    expect(pool.getStats().totalAllocated).toBe(0);
    expect(pool.getStats().activeBuffers).toBe(0);
    expect(pool.getStats().pooledBuffers).toBe(0);
    // Ensure buffers are markered as not active
    pool.release(a);
    expect(pool.getStats().activeBuffers).toBe(0);
  });

  it('invalid sizes throw', () => {
    expect(() => pool.allocate(0)).toThrow();
    expect(() => pool.allocate(-1)).toThrow();
    expect(() => pool.allocate(NaN)).toThrow();
    expect(() => pool.allocate(MAX_MEMORY_BYTES + 1)).toThrow();
  });

  it('sequential proving runs recycle memory (simulates real flow)', async () => {
    // Simulate 5 sequential proofs that each allocate then release
    for (let run = 0; run < 5; run++) {
      const witness = pool.allocate(256 * 1024);
      const proof = pool.allocate(2 * 1024 * 1024);
      expect(pool.getStats().activeBuffers).toBe(2);
      pool.release(witness);
      pool.release(proof);
    }
    expect(pool.getStats().allocationCount).toBe(10);
    expect(pool.getStats().recycledCount).toBeGreaterThanOrEqual(8);
    expect(pool.getStats().recyclingRate).toBeGreaterThan(0.5);
  });
});
