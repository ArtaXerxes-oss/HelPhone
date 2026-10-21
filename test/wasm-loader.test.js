// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MULTI_MEMORY_PROBE,
  buildBridgeModule,
  createIsolatedSandboxes,
  detectFeatures,
} from "../src/utils/wasmLoader.js";

const source = readFileSync(
  join(__dirname, "..", "src", "wasm", "memory_sandbox.wasm"),
);

/** WebAssembly facade that rejects any module declaring more than one memory. */
const withoutMultiMemory = {
  ...WebAssembly,
  Module: WebAssembly.Module,
  validate: (bytes) =>
    bytes !== MULTI_MEMORY_PROBE && WebAssembly.validate(bytes),
  compile: WebAssembly.compile,
  instantiate: WebAssembly.instantiate,
};

function pattern(len, seed = 1) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

describe("detectFeatures", () => {
  it("reports multi-memory and bulk-memory on this V8", () => {
    expect(detectFeatures()).toMatchObject({
      wasm: true,
      bulkMemory: true,
      multiMemory: true,
    });
  });

  it("reports no support when WebAssembly is missing", () => {
    expect(detectFeatures(null)).toEqual({
      wasm: false,
      bulkMemory: false,
      multiMemory: false,
      sharedMemory: false,
    });
  });

  it("treats a throwing validate() as unsupported", () => {
    const WA = {
      validate: () => {
        throw new Error("boom");
      },
    };
    expect(detectFeatures(WA)).toMatchObject({
      wasm: true,
      multiMemory: false,
      bulkMemory: false,
    });
  });

  it("assembles a valid bridge module with both copy directions", () => {
    const mod = new WebAssembly.Module(buildBridgeModule());
    expect(WebAssembly.Module.exports(mod).map((e) => e.name)).toEqual([
      "a_to_b",
      "b_to_a",
    ]);
    expect(
      WebAssembly.Module.imports(mod).map(
        (i) => `${i.module}.${i.name}:${i.kind}`,
      ),
    ).toEqual(["env.a:memory", "env.b:memory"]);
  });
});

describe("createIsolatedSandboxes", () => {
  it("picks multi-memory automatically when supported", async () => {
    const s = await createIsolatedSandboxes({ source });
    expect(s.strategy).toBe("multi-memory");
  });

  it("falls back to js-copy on engines without multi-memory", async () => {
    const s = await createIsolatedSandboxes({
      source,
      WebAssembly: withoutMultiMemory,
    });
    expect(s.strategy).toBe("js-copy");
    expect(s.features.multiMemory).toBe(false);
  });

  it("refuses to force multi-memory on an engine that lacks it", async () => {
    await expect(
      createIsolatedSandboxes({
        source,
        strategy: "multi-memory",
        WebAssembly: withoutMultiMemory,
      }),
    ).rejects.toThrow(/not supported/);
  });

  it("gives each domain its own linear memory", async () => {
    const { audio, zk } = await createIsolatedSandboxes({ source });
    expect(audio.memory).not.toBe(zk.memory);
    const secret = pattern(64, 9);
    const p = zk.write(secret);
    // Same offset in the audio sandbox holds nothing of the ZK secret.
    audio.alloc(p + 64);
    expect([...audio.read(p, 64)]).not.toEqual([...secret]);
  });

  for (const strategy of ["multi-memory", "js-copy"]) {
    it(`${strategy}: transfers both directions byte-exact, including across memory growth`, async () => {
      const s = await createIsolatedSandboxes({ source, strategy });
      // Larger than the initial memory so the destination must grow mid-transfer.
      const data = pattern(3 * 1024 * 1024 + 7);
      const a = s.audio.write(data);
      const z = s.transfer(s.audio, s.zk, a, data.length);
      expect(s.zk.checksum(z, data.length)).toBe(
        s.audio.checksum(a, data.length),
      );
      expect(s.zk.read(z, 16)).toEqual(data.subarray(0, 16));

      const back = s.transfer(s.zk, s.audio, z, data.length);
      expect(s.audio.read(back + data.length - 16, 16)).toEqual(
        data.subarray(data.length - 16),
      );
    });
  }

  it("rejects a transfer from a sandbox into itself", async () => {
    const s = await createIsolatedSandboxes({ source });
    expect(() => s.transfer(s.zk, s.zk, 0, 1)).toThrow(
      /two different sandboxes/,
    );
  });

  it("wipe and reset zero sensitive bytes", async () => {
    const { zk } = await createIsolatedSandboxes({ source });
    const p = zk.write(pattern(128, 3));
    zk.wipe(p, 64);
    expect(zk.read(p, 64).every((b) => b === 0)).toBe(true);
    expect(zk.read(p + 64, 64).some((b) => b !== 0)).toBe(true);
    zk.reset();
    expect(zk.read(p, 128).every((b) => b === 0)).toBe(true);
    expect(zk.alloc(8)).toBe(p); // allocations restart from the heap base
  });

  it("runs the audio DSP stand-in inside the audio sandbox", async () => {
    const { audio } = await createIsolatedSandboxes({ source });
    const pcm = Int16Array.from([100, -200, 30000, -30000]);
    const p = audio.write(new Uint8Array(pcm.buffer));
    const peak = audio.exports.audio_gain(p, pcm.length, 512); // 2x gain, saturating
    expect(peak).toBe(32768);
    expect(Array.from(new Int16Array(audio.read(p, 8).buffer))).toEqual([
      200, -400, 32767, -32768,
    ]);
  });

  it("surfaces allocation failure instead of returning a null pointer", async () => {
    const { audio } = await createIsolatedSandboxes({ source });
    expect(() => audio.alloc(0xffff_fff0)).toThrow(RangeError);
  });
});
