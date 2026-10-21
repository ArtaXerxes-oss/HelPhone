import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    Keypair: {
      ...actual.Keypair,
      random: () => ({
        publicKey: () =>
          "GBZCSTYFKEL7NQ27CMKGRYDCYI6PIGNCSWRB5K5STQZH3KJR6ZVHTS7N",
      }),
    },
  };
});

// ---------------------------------------------------------------------------
// Issue #108 — unit tests for src/lib/zk.js.
//
// Covers:
//   - normalizeBase64 edge cases (via its exported wrappers
//     decodeBase64Utf8 / decodeBase64Bytes)
//   - coordinate scaling / zone building for the Noir circuits
//   - the proof generation flow with a mocked UltraHonk backend
//     (browser fallback) and a mocked prover server (server flow)
// ---------------------------------------------------------------------------

const bbState = vi.hoisted(() => ({
  backends: [],
  noirs: [],
}));

vi.mock("@aztec/bb.js", () => ({
  UltraHonkBackend: class {
    constructor(bytecode, options, config) {
      this.bytecode = bytecode;
      this.options = options;
      this.config = config;
      this.instantiate = vi.fn(async () => {});
      this.generateProof = vi.fn(async () => ({
        proof: new Uint8Array([0xde, 0xad]),
        publicInputs: ["1"],
      }));
      this.destroy = vi.fn(async () => {});
      bbState.backends.push(this);
    }
  },
}));

vi.mock("@noir-lang/noir_js", () => ({
  Noir: class {
    constructor(artifact) {
      this.artifact = artifact;
      this.execute = vi.fn(async () => ({
        witness: new Uint8Array([7]),
        returnValue: "424242",
      }));
      bbState.noirs.push(this);
    }
  },
}));

import {
  decodeBase64Bytes,
  decodeBase64Utf8,
  buildLocationProofZone,
  shortProofId,
  generateLocationProof,
} from "../src/lib/zk.js";

const RECIPIENT = "GB6Q7N7EHW5H6HZKAIIO4R2VTB7JEBX5XN4FOXXT6YTDA36Z7ALA656J";

function okJson(body) {
  return { ok: true, json: async () => body };
}

function lastFieldAsBigInt(bytes, index = 6) {
  let value = 0n;
  for (let j = 0; j < 32; j++) {
    value = (value << 8n) | BigInt(bytes[index * 32 + j]);
  }
  return value;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("zk.js — Base64 normalization", () => {
  it("decodes standard Base64", () => {
    expect(decodeBase64Utf8("aGVsbG8=")).toBe("hello");
  });

  it("strips data URI prefixes before decoding", () => {
    expect(decodeBase64Utf8("data:text/plain;base64,aGVsbG8=")).toBe("hello");
  });

  it("removes embedded whitespace and newlines", () => {
    expect(decodeBase64Utf8("aGVs\nbG8\t= ")).toBe("hello");
  });

  it("pads unpadded input", () => {
    expect(decodeBase64Utf8("aGVsbG8")).toBe("hello");
    expect(decodeBase64Utf8("aGVsbG")).toBe("hell");
  });

  it("converts URL-safe - and _ characters back to + and /", () => {
    expect(Array.from(decodeBase64Bytes("----"))).toEqual([251, 239, 190]);
    expect(Array.from(decodeBase64Bytes("_--_"))).toEqual([255, 239, 191]);
  });

  it("accepts an empty string as empty bytes", () => {
    expect(decodeBase64Bytes("")).toHaveLength(0);
  });

  it("rejects invalid Base64 characters", () => {
    expect(() => decodeBase64Utf8("not base64!")).toThrow(
      "contains invalid Base64 characters",
    );
    // Padding longer than two '=' characters is malformed too.
    expect(() => decodeBase64Utf8("aGVsbG8===")).toThrow(
      "contains invalid Base64 characters",
    );
  });

  it("rejects impossible lengths (length % 4 === 1)", () => {
    expect(() => decodeBase64Utf8("abcde")).toThrow(
      "has an invalid Base64 length",
    );
  });

  it("rejects non-string input and includes the label in errors", () => {
    expect(() => decodeBase64Utf8(123)).toThrow("must be a string");
    expect(() => decodeBase64Bytes(null)).toThrow("must be a string");
    expect(() => decodeBase64Utf8("###", "Proof blob")).toThrow(
      "Proof blob contains invalid Base64 characters.",
    );
  });
});

describe("zk.js — location proof zone encoding", () => {
  it("throws for missing or non-finite coordinates", () => {
    expect(() => buildLocationProofZone({})).toThrow(
      "A valid location is required to build a ZK proof zone",
    );
    expect(() => buildLocationProofZone({ lat: Number.NaN, lng: 0 })).toThrow(
      "A valid location is required to build a ZK proof zone",
    );
    expect(() =>
      buildLocationProofZone({ lat: 0, lng: Number.POSITIVE_INFINITY }),
    ).toThrow("A valid location is required to build a ZK proof zone");
  });

  it("scales coordinates into the fixed-point box around the center", () => {
    const lat = 52.52;
    const lng = 13.405;
    const radiusMeters = 3000;
    const zone = buildLocationProofZone({ lat, lng, radiusMeters });

    // Independent re-derivation of the documented encoding:
    //   stored_lng = floor(lng * 1e7) + 1_800_000_000
    //   stored_lat = floor(lat * 1e7) +   900_000_000
    const latDelta = radiusMeters / 111320;
    const lngScale = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const lngDelta = radiusMeters / (111320 * lngScale);
    const encodeLngNumber = (v) => Math.floor(v * 1e7) + 1_800_000_000;
    const encodeLatNumber = (v) => Math.floor(v * 1e7) + 900_000_000;

    expect(zone.radiusMeters).toBe(radiusMeters);
    expect(zone.center).toEqual({ lat, lng });
    expect(zone.boxXMin).toBe(String(encodeLngNumber(lng - lngDelta)));
    expect(zone.boxXMax).toBe(String(encodeLngNumber(lng + lngDelta)));
    expect(zone.boxYMin).toBe(String(encodeLatNumber(lat - latDelta)));
    expect(zone.boxYMax).toBe(String(encodeLatNumber(lat + latDelta)));
    expect(Number(zone.boxXMin)).toBeLessThan(Number(zone.boxXMax));
    expect(Number(zone.boxYMin)).toBeLessThan(Number(zone.boxYMax));
  });

  it("clamps the radius to the supported range and defaults sanely", () => {
    expect(
      buildLocationProofZone({ lat: 0, lng: 0, radiusMeters: 1 }).radiusMeters,
    ).toBe(250);
    expect(
      buildLocationProofZone({ lat: 0, lng: 0, radiusMeters: 99_999 })
        .radiusMeters,
    ).toBe(25_000);
    expect(buildLocationProofZone({ lat: 0, lng: 0 }).radiusMeters).toBe(3000);
    expect(
      buildLocationProofZone({ lat: 0, lng: 0, radiusMeters: Number.NaN })
        .radiusMeters,
    ).toBe(3000);
  });

  it("clamps encoded boxes to the circuit field bounds at extreme coordinates", () => {
    expect(buildLocationProofZone({ lat: 90, lng: 180 })).toMatchObject({
      boxXMax: "3600000000",
      boxYMax: "1800000000",
    });
    expect(buildLocationProofZone({ lat: -90, lng: -180 })).toMatchObject({
      boxXMin: "0",
      boxYMin: "0",
    });
  });
});

describe("zk.js — shortProofId", () => {
  it("returns short values unchanged and truncates long ones", () => {
    expect(shortProofId("short")).toBe("short");
    expect(shortProofId("")).toBe("");
    expect(shortProofId(null)).toBe("");
    const long = "abcdefghij1234567890abcdef";
    expect(shortProofId(long)).toBe("abcdefghij...abcdef");
  });
});

describe("zk.js — server proof generation flow", () => {
  it("requests a proof from the prover server and packs public inputs", async () => {
    const proveBodies = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts = {}) => {
        const u = String(url);
        if (u.includes("/health")) return okJson({ ready: true });
        proveBodies.push(JSON.parse(opts.body));
        return okJson({
          success: true,
          proof: "0x00ff10",
          nullifier: "999",
        });
      }),
    );

    const zone = buildLocationProofZone({ lat: 48.85, lng: 2.35 });
    const result = await generateLocationProof({
      lat: 48.85,
      lng: 2.35,
      campaignId: "7",
      recipientAddress: RECIPIENT,
      zone,
      onLog: () => {},
    });

    expect(Array.from(result.proof)).toEqual([0x00, 0xff, 0x10]);
    expect(result.nullifier).toBe("999");
    expect(result.publicInputsBytes).toHaveLength(224);
    expect(result.publicInputsPrefix).toHaveLength(160);

    // Public inputs layout: box_x_min | ... | campaign_id | recipient | nullifier
    expect(lastFieldAsBigInt(result.publicInputsBytes, 6)).toBe(999n);
    expect(proveBodies).toHaveLength(1);

    const inputs = proveBodies[0].inputs;
    expect(inputs.user_x).toBe(String(Math.floor(2.35 * 1e7) + 1_800_000_000));
    expect(inputs.user_y).toBe(String(Math.floor(48.85 * 1e7) + 900_000_000));
    expect(inputs.box_x_min).toBe(zone.boxXMin);
    expect(inputs.box_x_max).toBe(zone.boxXMax);
    expect(inputs.box_y_min).toBe(zone.boxYMin);
    expect(inputs.box_y_max).toBe(zone.boxYMax);
    expect(inputs.campaign_id).toBe("7");
    expect(inputs.recipient_address).toMatch(/^\d+$/);
  });

  it("propagates the server error message when proving fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        String(url).includes("/health")
          ? okJson({ ready: true })
          : { ok: false, json: async () => ({ error: "circuit rejected" }) },
      ),
    );

    const zone = buildLocationProofZone({ lat: 1, lng: 2 });
    await expect(
      generateLocationProof({
        lat: 1,
        lng: 2,
        recipientAddress: RECIPIENT,
        zone,
        onLog: () => {},
      }),
    ).rejects.toThrow(/circuit rejected/);
  });

  it("surfaces failures when the server responds with success=false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        String(url).includes("/health")
          ? okJson({ ready: true })
          : okJson({ success: false, error: "witness failed" }),
      ),
    );

    const zone = buildLocationProofZone({ lat: 1, lng: 2 });
    await expect(
      generateLocationProof({
        lat: 1,
        lng: 2,
        recipientAddress: RECIPIENT,
        zone,
        onLog: () => {},
      }),
    ).rejects.toThrow(/witness failed/);
  });

  it("reports an unreachable prover instead of hanging", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const zone = buildLocationProofZone({ lat: 1, lng: 2 });
    await expect(
      generateLocationProof({
        lat: 1,
        lng: 2,
        recipientAddress: RECIPIENT,
        zone,
        onLog: () => {},
      }),
    ).rejects.toThrow("ZK prover server is unreachable");
  });
});

describe("zk.js — browser proof generation with mocked UltraHonk backend", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("falls back to browser proving when the server is unavailable", async () => {
    vi.stubEnv("VITE_ZK_BROWSER_FALLBACK", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const zone = buildLocationProofZone({ lat: 52.52, lng: 13.405 });
    const logs = [];
    const result = await generateLocationProof({
      lat: 52.52,
      lng: 13.405,
      campaignId: "7",
      recipientAddress: RECIPIENT,
      zone,
      onLog: (msg) => logs.push(msg),
    });

    // UltraHonk backend was constructed from the circuit artifact and used
    // for instantiation + proof generation.
    const backend = bbState.backends.at(-1);
    expect(typeof backend.bytecode).toBe("string");
    expect(backend.bytecode.length).toBeGreaterThan(0);
    expect(backend.config).toEqual({ recursive: false });
    expect(backend.instantiate).toHaveBeenCalledTimes(1);
    expect(backend.generateProof).toHaveBeenCalledTimes(1);
    const witness = backend.generateProof.mock.calls[0][0];
    expect(Array.from(witness)).toEqual([7]);

    // Noir circuit executed with the scaled/encoded inputs.
    const noir = bbState.noirs.at(-1);
    const inputs = noir.execute.mock.calls[0][0];
    expect(inputs.user_x).toBe(
      String(Math.floor(13.405 * 1e7) + 1_800_000_000),
    );
    expect(inputs.user_y).toBe(String(Math.floor(52.52 * 1e7) + 900_000_000));
    expect(inputs.box_x_min).toBe(zone.boxXMin);
    expect(inputs.box_x_max).toBe(zone.boxXMax);
    expect(inputs.box_y_min).toBe(zone.boxYMin);
    expect(inputs.box_y_max).toBe(zone.boxYMax);
    expect(inputs.campaign_id).toBe("7");

    // Circuit return value becomes the nullifier; proof bytes pass through;
    // public inputs are packed into seven big-endian 32-byte fields.
    expect(result.nullifier).toBe("424242");
    expect(Array.from(result.proof)).toEqual([0xde, 0xad]);
    expect(result.publicInputsBytes).toHaveLength(224);
    expect(result.publicInputsPrefix).toHaveLength(160);
    expect(lastFieldAsBigInt(result.publicInputsBytes, 6)).toBe(424242n);
    expect(logs.some((l) => l.includes("UltraHonk"))).toBe(true);
  });

  it("reuses the persisted ZK secret between proofs", async () => {
    vi.stubEnv("VITE_ZK_BROWSER_FALLBACK", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const zone = buildLocationProofZone({ lat: 10, lng: 20 });
    await generateLocationProof({
      lat: 10,
      lng: 20,
      recipientAddress: RECIPIENT,
      zone,
      onLog: () => {},
    });
    await generateLocationProof({
      lat: 10,
      lng: 20,
      recipientAddress: RECIPIENT,
      zone,
      onLog: () => {},
    });

    const secret = localStorage.getItem("hp_zk_secret");
    expect(secret).toBeTruthy();

    const noir = bbState.noirs.at(-1);
    const calls = noir.execute.mock.calls.slice(-2);
    expect(calls[0][0].secret_id).toBe(secret);
    expect(calls[1][0].secret_id).toBe(secret);
  });

  it("refuses to prove without a valid Stellar address", async () => {
    vi.stubEnv("VITE_ZK_BROWSER_FALLBACK", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const zone = buildLocationProofZone({ lat: 1, lng: 2 });
    await expect(
      generateLocationProof({
        lat: 1,
        lng: 2,
        recipientAddress: "GINVALID",
        zone,
        onLog: () => {},
      }),
    ).rejects.toThrow(
      "Connect a valid Stellar wallet before generating the proof.",
    );
  });
});
