#!/usr/bin/env node
/**
 * Spike (ADR-014): wire-format conformance of src/utils/binaryParser.js
 * against the official toolchains, in both directions.
 *
 *   ours -> official   our encoder's bytes are decoded by flatc / capnp /
 *                      protoc (and the official JS runtimes, if --libs)
 *   official -> ours   bytes produced by the official encoders are read by
 *                      our decoders, readPositions and the WASM reader
 *
 * For protobuf we also require byte-for-byte equality with `protoc --encode`,
 * since both sides produce the canonical encoding.
 *
 * Usage:
 *   FLATC=... CAPNP=... PROTOC=... node --experimental-transform-types \
 *     scripts/spikes/binary_conformance.js [--libs <node_modules>] \
 *     [--out docs/spikes/results/binary-conformance.json]
 * A missing tool is reported as "skipped", not as a failure.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  FlatTelemetryFrame,
  createPositionBuffer,
  decodeFrame,
  encodeFrame,
  generateMapObjects,
  readPositions,
} from "../../src/utils/binaryParser.js";
import { createWasmPositionReader } from "../../src/utils/binaryParserWasm.js";
import { loadFlatcGenerated, loadProtobufjs, makeTempDir, run, SCHEMA_DIR, toolVersion } from "./binary_official_codecs.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const KIND = ["Request", "Responder"];
const STATUS = ["Pending", "Enroute", "Resolved", "Cancelled"];
const PRIORITY = ["Low", "Medium", "High", "Critical"];
const FIELDS = [
  "id", "kind", "status", "priority", "latE6", "lngE6", "headingCdeg", "speedCms", "etaSeconds", "requestId", "tsMs",
  "emergencyType", "responder", "trail",
];

// latE6 -> lat_e6, headingCdeg -> heading_cdeg, sentAtMs -> sent_at_ms
const toSnake = (k) => k.replace(/[A-Z0-9]+/g, (m) => `_${m.toLowerCase()}`);

// ---------------------------------------------------------------------------
// Test frames

function cases() {
  const edge = {
    id: 0xffffffff, kind: 1, status: 3, priority: 3,
    latE6: -89_999_999, lngE6: -179_999_999, // southern/western hemispheres
    headingCdeg: 35999, speedCms: 65535, etaSeconds: 0xffffffff, requestId: 0x7fffffff,
    tsMs: 2 ** 53 - 1,
    emergencyType: "Ọ̀ṣun flood 🌊 \"quoted\" \\ back",
    responder: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    trail: Int32Array.from([-2147483648, 2147483647, 0, -1, 1, 0]),
  };
  const zero = {
    id: 0, kind: 0, status: 0, priority: 0, latE6: 0, lngE6: 0, headingCdeg: 0, speedCms: 0, etaSeconds: 0,
    requestId: 0, tsMs: 0, emergencyType: "", responder: "", trail: new Int32Array(0),
  };
  return [
    { name: "empty frame", frame: { seq: 0, sentAtMs: 0, objects: [] } },
    { name: "edge values", frame: { seq: 0xffffffff, sentAtMs: 1_790_000_000_000.25, objects: [edge, zero, { ...edge, latE6: 89_999_999, lngE6: 180_000_000 }] } },
    { name: "12 generated", frame: { seq: 7, sentAtMs: 1_790_000_000_123, objects: generateMapObjects(12, { seed: 3 }) } },
    // Large enough that capnp's official encoder spills into several segments.
    { name: "500 generated", frame: { seq: 8, sentAtMs: 1_790_000_000_456, objects: generateMapObjects(500, { seed: 4, center: [-33.8688, 151.2093] }) } },
  ];
}

function normalize(frame) {
  return {
    seq: frame.seq >>> 0,
    sentAtMs: frame.sentAtMs,
    objects: frame.objects.map((o) => {
      const r = {};
      for (const k of FIELDS) r[k] = k === "trail" ? Array.from(o.trail || []) : o[k] ?? (typeof o[k] === "string" ? "" : 0);
      r.emergencyType ||= "";
      r.responder ||= "";
      return r;
    }),
  };
}

function diff(expected, actual) {
  const a = JSON.stringify(normalize(expected));
  const b = JSON.stringify(normalize(actual));
  if (a === b) return null;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `first difference at char ${i}: expected …${a.slice(Math.max(0, i - 60), i + 60)}… got …${b.slice(Math.max(0, i - 60), i + 60)}…`;
}

let wasmReader = null;

function positionsMatch(format, bytes, frame, via = "js") {
  let out = createPositionBuffer(1);
  if (via === "wasm") {
    wasmReader.readPositions(format, bytes);
    out = wasmReader.positions;
  } else readPositions(format, bytes, out);
  if (out.count !== frame.objects.length) return `readPositions count ${out.count} != ${frame.objects.length}`;
  for (let i = 0; i < out.count; i++) {
    const o = frame.objects[i];
    for (const k of ["id", "kind", "status", "latE6", "lngE6", "headingCdeg"]) {
      if (out[k][i] !== o[k]) return `readPositions ${k}[${i}] = ${out[k][i]}, expected ${o[k]}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// FlatBuffers

function fbToJson(frame) {
  return {
    seq: frame.seq,
    sent_at_ms: frame.sentAtMs,
    objects: frame.objects.map((o) => {
      const j = {};
      for (const k of FIELDS) {
        const v = o[k];
        if (k === "kind") j.kind = KIND[v];
        else if (k === "status") j.status = STATUS[v];
        else if (k === "priority") j.priority = PRIORITY[v];
        else if (k === "trail") { if (v.length) j.trail = Array.from(v); }
        else if (typeof v === "string") { if (v) j[toSnake(k)] = v; }
        else j[toSnake(k)] = v;
      }
      return j;
    }),
  };
}

function fbFromJson(j) {
  return {
    seq: j.seq ?? 0,
    sentAtMs: j.sent_at_ms ?? 0,
    objects: (j.objects ?? []).map((o) => {
      const r = {};
      for (const k of FIELDS) {
        const v = o[k === "trail" ? "trail" : toSnake(k)];
        if (k === "kind") r.kind = KIND.indexOf(o.kind ?? "Request");
        else if (k === "status") r.status = STATUS.indexOf(o.status ?? "Pending");
        else if (k === "priority") r.priority = PRIORITY.indexOf(o.priority ?? "Low");
        else if (k === "trail") r.trail = v ?? [];
        else r[k] = v ?? (k === "emergencyType" || k === "responder" ? "" : 0);
      }
      return r;
    }),
  };
}

function checkFlatBuffers(tmp, c) {
  const res = {};
  const ours = encodeFrame("flatbuffers", c.frame);
  const bin = join(tmp, "ours.hptl");
  writeFileSync(bin, ours);
  // ours -> flatc. Note flatc 2.0.8 does not run the verifier here (a
  // corrupted buffer still exits 0), so this checks field values only.
  run("flatc", ["--json", "--strict-json", "--defaults-json", "--raw-binary", "-o", tmp, join(SCHEMA_DIR, "telemetry.fbs"), "--", bin]);
  const decoded = fbFromJson(JSON.parse(readFileSync(join(tmp, "ours.json"), "utf8")));
  res["ours -> flatc --json"] = diff(c.frame, decoded) ?? "ok";
  // flatc --binary -> ours
  const jsonIn = join(tmp, "official.json");
  writeFileSync(jsonIn, JSON.stringify(fbToJson(c.frame)));
  run("flatc", ["--binary", "-o", tmp, join(SCHEMA_DIR, "telemetry.fbs"), jsonIn]);
  const official = readFileSync(join(tmp, "official.hptl"));
  res["flatc --binary -> ours"] =
    (FlatTelemetryFrame.hasIdentifier(official) ? null : "missing HPTL identifier") ??
    diff(c.frame, decodeFrame("flatbuffers", official)) ??
    positionsMatch("flatbuffers", official, c.frame) ??
    "ok";
  res["flatc --binary -> ours (wasm)"] = positionsMatch("flatbuffers", official, c.frame, "wasm") ?? "ok";
  res.bytes = { ours: ours.length, flatc: official.length };
  return res;
}

// ---------------------------------------------------------------------------
// Cap'n Proto (JSON via `capnp convert`)

const capnpEnum = (names, v) => names[v].charAt(0).toLowerCase() + names[v].slice(1);

function capnpToJson(frame) {
  return {
    seq: frame.seq,
    sentAtMs: frame.sentAtMs,
    objects: frame.objects.map((o) => {
      const j = {};
      for (const k of FIELDS) {
        const v = o[k];
        if (k === "kind") j.kind = capnpEnum(KIND, v);
        else if (k === "status") j.status = capnpEnum(STATUS, v);
        else if (k === "priority") j.priority = capnpEnum(PRIORITY, v);
        else if (k === "trail") { if (v.length) j.trail = Array.from(v); }
        else if (typeof v === "string") { if (v) j[k] = v; }
        else j[k] = v;
      }
      return j;
    }),
  };
}

function capnpFromJson(j) {
  const idx = (names, v) => (v === undefined ? 0 : names.findIndex((n) => n.toLowerCase() === String(v).toLowerCase()));
  return {
    seq: j.seq ?? 0,
    sentAtMs: j.sentAtMs ?? 0,
    objects: (j.objects ?? []).map((o) => ({
      ...Object.fromEntries(FIELDS.map((k) => [k, o[k] ?? (k === "emergencyType" || k === "responder" ? "" : 0)])),
      kind: idx(KIND, o.kind),
      status: idx(STATUS, o.status),
      priority: idx(PRIORITY, o.priority),
      trail: o.trail ?? [],
    })),
  };
}

function checkCapnp(tmp, c) {
  const res = {};
  const ours = encodeFrame("capnp", c.frame);
  const schema = join(SCHEMA_DIR, "telemetry.capnp");
  const json = run("capnp", ["convert", "binary:json", schema, "TelemetryFrame"], { input: ours }).toString();
  res["ours -> capnp convert binary:json"] = diff(c.frame, capnpFromJson(JSON.parse(json))) ?? "ok";
  const official = run("capnp", ["convert", "json:binary", schema, "TelemetryFrame"], { input: JSON.stringify(capnpToJson(c.frame)) });
  const segments = official.readUInt32LE(0) + 1;
  res["capnp convert json:binary -> ours"] =
    diff(c.frame, decodeFrame("capnp", official)) ?? positionsMatch("capnp", official, c.frame) ?? "ok";
  res["capnp convert json:binary -> ours (wasm)"] = positionsMatch("capnp", official, c.frame, "wasm") ?? "ok";
  res.bytes = { ours: ours.length, capnp: official.length, capnpSegments: segments };
  return res;
}

// ---------------------------------------------------------------------------
// Protocol Buffers (text format via `protoc --encode/--decode`)

const pbString = (s) => JSON.stringify(s); // JSON escapes are valid text-format escapes for these inputs

function pbToText(frame) {
  const enums = { kind: ["OBJECT_KIND_REQUEST", "OBJECT_KIND_RESPONDER"], status: STATUS.map((s) => `STATUS_${s.toUpperCase()}`), priority: PRIORITY.map((s) => `PRIORITY_${s.toUpperCase()}`) };
  const lines = [`seq: ${frame.seq}`, `sent_at_ms: ${frame.sentAtMs}`];
  for (const o of frame.objects) {
    const f = [];
    for (const k of FIELDS) {
      const v = o[k];
      if (enums[k]) f.push(`${k}: ${enums[k][v]}`);
      else if (k === "trail") { if (v.length) f.push(`trail: [${Array.from(v).join(", ")}]`); }
      else if (typeof v === "string") f.push(`${toSnake(k)}: ${pbString(v)}`);
      else f.push(`${toSnake(k)}: ${v}`);
    }
    lines.push(`objects { ${f.join(" ")} }`);
  }
  return lines.join("\n");
}

function checkProtobuf(tmp, c) {
  const res = {};
  const ours = encodeFrame("protobuf", c.frame);
  const args = ["-I", SCHEMA_DIR, "--encode=helphone.telemetry.TelemetryFrame", "telemetry.proto"];
  const official = run("protoc", args, { input: pbToText(c.frame) });
  res["ours == protoc --encode (bytes)"] = Buffer.compare(Buffer.from(ours), official) === 0 ? "ok" : `differs (${ours.length} vs ${official.length} bytes)`;
  // protoc --decode must accept our bytes and print the same text back.
  const text = run("protoc", ["-I", SCHEMA_DIR, "--decode=helphone.telemetry.TelemetryFrame", "telemetry.proto"], { input: ours });
  const reencoded = run("protoc", args, { input: text });
  res["ours -> protoc --decode -> --encode"] = Buffer.compare(Buffer.from(ours), reencoded) === 0 ? "ok" : "differs";
  res["protoc --encode -> ours"] = diff(c.frame, decodeFrame("protobuf", official)) ?? positionsMatch("protobuf", official, c.frame) ?? "ok";
  res.bytes = { ours: ours.length, protoc: official.length };
  return res;
}

// ---------------------------------------------------------------------------

async function main() {
  const libs = arg("libs");
  const outPath = arg("out");
  const versions = { node: process.version, flatc: toolVersion("flatc"), capnp: toolVersion("capnp"), protoc: toolVersion("protoc") };
  const results = { versions, cases: {} };
  let failures = 0;

  wasmReader = await createWasmPositionReader(readFileSync(new URL("../../src/wasm/telemetry_reader.wasm", import.meta.url)), { initialCapacity: 4 });
  let fbGen = null;
  let pbjs = null;
  if (libs) {
    try {
      fbGen = versions.flatc ? await loadFlatcGenerated(libs) : null;
      if (fbGen) versions.flatbuffersJs = fbGen.version;
    } catch (err) {
      console.warn(`flatc-generated TS not loaded (${err.message.split("\n")[0]})`);
    }
    try {
      pbjs = loadProtobufjs(libs);
      versions.protobufjs = pbjs.version;
    } catch (err) {
      console.warn(`protobufjs not loaded (${err.message.split("\n")[0]})`);
    }
  }

  for (const c of cases()) {
    const tmp = makeTempDir();
    const r = {};
    for (const [format, tool, check] of [["flatbuffers", "flatc", checkFlatBuffers], ["capnp", "capnp", checkCapnp], ["protobuf", "protoc", checkProtobuf]]) {
      if (!versions[tool]) {
        r[format] = { skipped: `${tool} not found` };
        continue;
      }
      try {
        r[format] = check(tmp, c);
      } catch (err) {
        r[format] = { error: err.message };
      }
    }
    if (fbGen) {
      const { ByteBuffer } = fbGen.flatbuffers;
      const f = fbGen.TelemetryFrame.getRootAsTelemetryFrame(new ByteBuffer(encodeFrame("flatbuffers", c.frame)));
      const objects = [];
      for (let i = 0; i < f.objectsLength(); i++) {
        const m = f.objects(i);
        objects.push({
          id: m.id(), kind: m.kind(), status: m.status(), priority: m.priority(), latE6: m.latE6(), lngE6: m.lngE6(),
          headingCdeg: m.headingCdeg(), speedCms: m.speedCms(), etaSeconds: m.etaSeconds(), requestId: m.requestId(),
          tsMs: m.tsMs(), emergencyType: m.emergencyType() ?? "", responder: m.responder() ?? "", trail: m.trailArray() ?? [],
        });
      }
      r.flatbuffers["ours -> flatbuffers JS runtime"] = diff(c.frame, { seq: f.seq(), sentAtMs: f.sentAtMs(), objects }) ?? "ok";
    }
    if (pbjs) {
      const m = pbjs.TelemetryFrame.decode(encodeFrame("protobuf", c.frame));
      r.protobuf["ours -> protobufjs"] = diff(c.frame, { seq: m.seq, sentAtMs: m.sentAtMs, objects: m.objects }) ?? "ok";
      const theirs = pbjs.TelemetryFrame.encode(pbjs.TelemetryFrame.fromObject({ ...c.frame, objects: c.frame.objects.map((o) => ({ ...o, trail: Array.from(o.trail) })) })).finish();
      r.protobuf["protobufjs -> ours"] = diff(c.frame, decodeFrame("protobuf", theirs)) ?? "ok";
    }
    for (const fr of Object.values(r)) {
      for (const [k, v] of Object.entries(fr)) {
        if (k === "bytes" || k === "skipped") continue;
        if (v !== "ok") failures++;
      }
    }
    results.cases[c.name] = r;
  }

  results.ok = failures === 0;
  console.log(JSON.stringify(results, null, 2));
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
  }
  if (failures) {
    console.error(`\n${failures} conformance check(s) failed`);
    process.exitCode = 1;
  }
}

await main();
