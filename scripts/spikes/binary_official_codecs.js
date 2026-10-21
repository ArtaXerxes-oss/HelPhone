/**
 * Spike (ADR-014): loads the *official* serialization toolchains so the
 * conformance check and the benchmark can compare the hand-written readers
 * in src/utils/binaryParser.js against them.
 *
 * Nothing here is an app dependency. The tools are found through:
 *   FLATC / CAPNP / PROTOC   paths to the compilers (default: on PATH)
 *   --libs <dir>             a node_modules directory that contains
 *                            `flatbuffers` and `protobufjs` (optional)
 *
 * The flatc-generated TypeScript readers are loaded by `import()`, which
 * needs Node 22.7+ started with --experimental-transform-types (TS enums
 * are not erasable).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SCHEMA_DIR = join(ROOT, "src/schemas");

export const TOOLS = {
  flatc: process.env.FLATC || "flatc",
  capnp: process.env.CAPNP || "capnp",
  protoc: process.env.PROTOC || "protoc",
};

/** Runs a tool; returns stdout as a Buffer. Throws with stderr on failure. */
export function run(tool, args, { input, cwd = SCHEMA_DIR } = {}) {
  try {
    return execFileSync(TOOLS[tool], args, { input, cwd, maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    throw new Error(`${tool} ${args.join(" ")} failed: ${stderr || err.message}`);
  }
}

export function toolVersion(tool) {
  try {
    return run(tool, ["--version"]).toString().trim();
  } catch {
    return null;
  }
}

export function makeTempDir(prefix = "hp-binary-") {
  return mkdtempSync(join(os.tmpdir(), prefix));
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Generates TS readers with `flatc --ts`, rewrites the extension-less
 * relative imports so Node's ESM loader can resolve them, links
 * node_modules/flatbuffers, and imports the result.
 */
export async function loadFlatcGenerated(libsDir) {
  const dir = makeTempDir("hp-flatc-");
  run("flatc", ["--ts", "-o", dir, join(SCHEMA_DIR, "telemetry.fbs")]);
  for (const file of walk(dir)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(file, "utf8").replace(/from '(\.[^']*)'/g, "from '$1.ts'");
    writeFileSync(file, src);
  }
  symlinkSync(resolve(libsDir), join(dir, "node_modules"), "dir");
  const gen = await import(pathToFileURL(join(dir, "telemetry_generated.ts")).href);
  const flatbuffers = await import(pathToFileURL(join(resolve(libsDir), "flatbuffers/mjs/flatbuffers.js")).href);
  const version = JSON.parse(readFileSync(join(libsDir, "flatbuffers/package.json"), "utf8")).version;
  return { ...gen, flatbuffers, version, dir };
}

export function loadProtobufjs(libsDir) {
  const require = createRequire(join(resolve(libsDir), "noop.js"));
  const protobuf = require("protobufjs");
  const root = protobuf.loadSync(join(SCHEMA_DIR, "telemetry.proto"));
  const version = JSON.parse(readFileSync(join(libsDir, "protobufjs/package.json"), "utf8")).version;
  return { protobuf, TelemetryFrame: root.lookupType("helphone.telemetry.TelemetryFrame"), version };
}

/**
 * Official-runtime equivalents of binaryParser.js's decodeFrame() and
 * readPositions(), for the benchmark. Returns {} for toolchains that are
 * not available.
 */
export async function loadOfficialCodecs(libsDir) {
  const codecs = {};
  if (!libsDir || !existsSync(libsDir)) return codecs;
  if (existsSync(join(libsDir, "flatbuffers")) && toolVersion("flatc")) {
    try {
      const fb = await loadFlatcGenerated(libsDir);
      const { ByteBuffer } = fb.flatbuffers;
      const { TelemetryFrame, MapObject } = fb;
      codecs["flatbuffers-official"] = {
        label: `flatbuffers ${fb.version} + flatc --ts`,
        readPositions(bytes, out) {
          const f = TelemetryFrame.getRootAsTelemetryFrame(new ByteBuffer(bytes));
          const n = f.objectsLength();
          const m = new MapObject();
          for (let i = 0; i < n; i++) {
            f.objects(i, m);
            out.id[i] = m.id();
            out.kind[i] = m.kind();
            out.status[i] = m.status();
            out.latE6[i] = m.latE6();
            out.lngE6[i] = m.lngE6();
            out.headingCdeg[i] = m.headingCdeg();
          }
          out.count = n;
          return n;
        },
        decodeFrame(bytes) {
          const f = TelemetryFrame.getRootAsTelemetryFrame(new ByteBuffer(bytes));
          const n = f.objectsLength();
          const objects = new Array(n);
          for (let i = 0; i < n; i++) {
            const m = f.objects(i);
            objects[i] = {
              id: m.id(), kind: m.kind(), status: m.status(), priority: m.priority(), latE6: m.latE6(), lngE6: m.lngE6(),
              headingCdeg: m.headingCdeg(), speedCms: m.speedCms(), etaSeconds: m.etaSeconds(), requestId: m.requestId(),
              tsMs: m.tsMs(), emergencyType: m.emergencyType() ?? "", responder: m.responder() ?? "",
              trail: Int32Array.from(m.trailArray() ?? []),
            };
          }
          return { seq: f.seq(), sentAtMs: f.sentAtMs(), objects };
        },
      };
    } catch (err) {
      if (!/transform-types|Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|strip/i.test(String(err))) throw err;
      console.warn(`[official] flatc TS readers skipped (run node with --experimental-transform-types): ${err.message}`);
    }
  }
  if (existsSync(join(libsDir, "protobufjs"))) {
    const pb = loadProtobufjs(libsDir);
    const { TelemetryFrame } = pb;
    codecs["protobufjs"] = {
      label: `protobufjs ${pb.version} (reflection + runtime codegen)`,
      readPositions(bytes, out) {
        const objects = TelemetryFrame.decode(bytes).objects;
        const n = objects.length;
        for (let i = 0; i < n; i++) {
          const o = objects[i];
          out.id[i] = o.id;
          out.kind[i] = o.kind;
          out.status[i] = o.status;
          out.latE6[i] = o.latE6;
          out.lngE6[i] = o.lngE6;
          out.headingCdeg[i] = o.headingCdeg;
        }
        out.count = n;
        return n;
      },
      decodeFrame(bytes) {
        const f = TelemetryFrame.decode(bytes);
        return {
          seq: f.seq, sentAtMs: f.sentAtMs,
          objects: f.objects.map((o) => ({
            id: o.id, kind: o.kind, status: o.status, priority: o.priority, latE6: o.latE6, lngE6: o.lngE6,
            headingCdeg: o.headingCdeg, speedCms: o.speedCms, etaSeconds: o.etaSeconds, requestId: o.requestId,
            tsMs: o.tsMs, emergencyType: o.emergencyType, responder: o.responder, trail: Int32Array.from(o.trail),
          })),
        };
      },
    };
  }
  return codecs;
}
