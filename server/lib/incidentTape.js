/**
 * Incident tape merge (#794) + signing & retention (#951):
 * ring buffer + OTel spans + indexer events + server logs →
 * one skew-corrected, causally pinned, PII-scrubbed, signed tape.
 *
 * Precedence (documented in docs/telemetry-architecture.md):
 *   1. Ledger events are authoritative: tCorrected = ledger closeTime,
 *      confidence = ledger granularity (5 s).
 *   2. Every other source is corrected by its estimated clock offset
 *      (clockSync.estimateOffset) and carries that estimate's confidence.
 *   3. Within one ring, monotonic order (`mono` / input order) beats wall clock.
 *   4. Ties inside the confidence window are broken by
 *      (ledgerSeq, source rank, original sequence): ledger sequence is the
 *      lamport clock.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactObject } from "./redact.js";

export const LEDGER_GRANULARITY_MS = 5_000;
export const RETENTION_DAYS_BY_TIER = {
  "volunteer-safe": 30,
  "command-internal": 7,
};
export const DEFAULT_GRACE_DAYS = 7;

const SOURCE_RANK = { ring: 0, log: 1, otel: 2, ledger: 3 };

function toMs(value) {
  if (value == null) return NaN;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value; // seconds → ms
  return Date.parse(value);
}

function pick(obj, keys) {
  for (const k of keys) if (obj?.[k] != null) return obj[k];
  return undefined;
}

/**
 * @param {object} inputs { ring?: [], otel?: [], ledger?: [], log?: [] }
 * @param {object} offsets per source { offsetMs, confidenceMs } (ring may be keyed by device)
 */
export function buildIncidentTape(inputs = {}, offsets = {}, { includeRaw = false } = {}) {
  const events = [];
  for (const source of ["ring", "log", "otel", "ledger"]) {
    const rows = Array.isArray(inputs[source]) ? inputs[source] : [];
    rows.forEach((row, seq) => {
      const raw = toMs(pick(row, ["closeTime", "ledger_close_time", "ts", "timestamp", "startTime", "created_at", "time", "wall"]));
      if (!Number.isFinite(raw)) return;
      let tCorrected = raw;
      let tConfidenceMs;
      if (source === "ledger") {
        tConfidenceMs = LEDGER_GRANULARITY_MS;
      } else {
        const off = offsets[`${source}:${row.device}`] || offsets[source] || { offsetMs: 0, confidenceMs: null };
        tCorrected = raw + (off.offsetMs || 0);
        // Unknown offset: say so instead of pretending to be exact.
        tConfidenceMs = off.confidenceMs ?? 60_000;
      }
      const ledgerSeq = Number(pick(row, ["ledgerSeq", "ledger_seq", "ledger"]));
      events.push({
        source,
        tRaw: raw,
        tCorrected: Math.round(tCorrected),
        tConfidenceMs,
        ledgerSeq: Number.isSafeInteger(ledgerSeq) ? ledgerSeq : null,
        seq: Number.isFinite(row.mono) ? row.mono : seq,
        device: row.device,
        dispatchId: pick(row, ["dispatchId", "dispatch_id", "requestId"]),
        traceId: pick(row, ["traceId", "trace_id"]),
        type: pick(row, ["type", "event", "name", "topic"]) ?? source,
        data: includeRaw ? row : redactObject(row),
      });
    });
  }

  events.sort((a, b) => {
    const window = Math.max(a.tConfidenceMs, b.tConfidenceMs);
    if (Math.abs(a.tCorrected - b.tCorrected) > window) return a.tCorrected - b.tCorrected;
    if (a.ledgerSeq != null && b.ledgerSeq != null && a.ledgerSeq !== b.ledgerSeq) return a.ledgerSeq - b.ledgerSeq;
    if (a.source === b.source && a.device === b.device) return a.seq - b.seq;
    if (a.tCorrected !== b.tCorrected) return a.tCorrected - b.tCorrected;
    return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  });

  return events.map(({ seq: _seq, tRaw: _tRaw, ...e }, causalSeq) => ({ ...e, causalSeq }));
}

export function computeTapeExpiry(generatedAt, tier = "volunteer-safe") {
  const days = RETENTION_DAYS_BY_TIER[tier] ?? RETENTION_DAYS_BY_TIER["volunteer-safe"];
  const baseMs = typeof generatedAt === "string" ? Date.parse(generatedAt) : Number(generatedAt);
  const start = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(start + days * 86_400_000).toISOString();
}

export function canonicalTapePayload(tapeDoc) {
  return JSON.stringify({
    generatedAt: tapeDoc.generatedAt ?? null,
    scrubbed: Boolean(tapeDoc.scrubbed),
    tier: tapeDoc.tier || (tapeDoc.scrubbed ? "volunteer-safe" : "command-internal"),
    expiresAt: tapeDoc.expiresAt ?? null,
    events: Array.isArray(tapeDoc.events) ? tapeDoc.events : [],
  });
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function signIncidentTape(
  tapeDoc,
  privateKeyPem,
  { keyId = "maintainer-default", tier, now = new Date() } = {},
) {
  if (!privateKeyPem) {
    throw new Error("privateKeyPem is required to sign an incident tape");
  }
  const resolvedTier =
    tier || tapeDoc.tier || (tapeDoc.scrubbed === false ? "command-internal" : "volunteer-safe");
  const generatedAt = tapeDoc.generatedAt || now.toISOString();
  const expiresAt = tapeDoc.expiresAt || computeTapeExpiry(generatedAt, resolvedTier);
  const unsigned = {
    ...tapeDoc,
    generatedAt,
    tier: resolvedTier,
    expiresAt,
  };
  const payload = Buffer.from(canonicalTapePayload(unsigned), "utf8");
  const keyObj = crypto.createPrivateKey(privateKeyPem);
  const algo = keyObj.asymmetricKeyType === "ed25519" ? null : "sha256";
  const sig = crypto.sign(algo, payload, keyObj).toString("base64");

  return {
    ...unsigned,
    signature: {
      algorithm: keyObj.asymmetricKeyType === "ed25519" ? "ed25519" : "sha256",
      keyId,
      signedAt: now.toISOString(),
      payloadSha256: sha256Hex(payload),
      value: sig,
    },
  };
}

function resolvePublicKey(publicKeyOrKeyring, keyId) {
  if (!publicKeyOrKeyring) return null;
  if (typeof publicKeyOrKeyring === "string" || publicKeyOrKeyring instanceof crypto.KeyObject) {
    return publicKeyOrKeyring;
  }
  if (Array.isArray(publicKeyOrKeyring)) {
    const match = publicKeyOrKeyring.find((k) => k.keyId === keyId || k.fingerprint === keyId);
    return match?.publicKeyPem || match?.publicKey || null;
  }
  if (typeof publicKeyOrKeyring === "object") {
    return publicKeyOrKeyring[keyId] || publicKeyOrKeyring.default || null;
  }
  return null;
}

export function verifyIncidentTape(
  tapeDoc,
  publicKeyOrKeyring,
  { now = new Date(), checkExpiry = true } = {},
) {
  const problems = [];
  let expired = false;

  if (!tapeDoc || typeof tapeDoc !== "object") {
    return { ok: false, expired: false, problems: ["invalid incident tape object"] };
  }

  if (checkExpiry && tapeDoc.expiresAt) {
    const expMs = Date.parse(tapeDoc.expiresAt);
    if (!Number.isFinite(expMs) || expMs <= now.getTime()) {
      expired = true;
      problems.push(`incident tape expired at ${tapeDoc.expiresAt}`);
    }
  }

  const sig = tapeDoc.signature;
  if (!sig || !sig.value) {
    problems.push("incident tape signature missing");
    return { ok: false, expired, problems, keyId: null };
  }

  const payload = Buffer.from(canonicalTapePayload(tapeDoc), "utf8");
  const actualSha = sha256Hex(payload);
  if (sig.payloadSha256 && sig.payloadSha256 !== actualSha) {
    problems.push("incident tape payload digest mismatch");
  }

  const pubPem = resolvePublicKey(publicKeyOrKeyring, sig.keyId);
  if (!pubPem) {
    problems.push(`missing public key for keyId '${sig.keyId || "unknown"}'`);
  } else {
    try {
      const keyObj = crypto.createPublicKey(pubPem);
      const algo = keyObj.asymmetricKeyType === "ed25519" ? null : "sha256";
      const valid = crypto.verify(algo, payload, keyObj, Buffer.from(sig.value, "base64"));
      if (!valid) {
        problems.push("incident tape signature verification failed");
      }
    } catch (err) {
      problems.push(`incident tape signature error: ${err.message}`);
    }
  }

  return {
    ok: problems.length === 0,
    expired,
    problems,
    keyId: sig.keyId || null,
  };
}

function appendAuditEvent(auditLogPath, event) {
  if (!auditLogPath) return;
  fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
  fs.appendFileSync(auditLogPath, `${JSON.stringify(event)}\n`);
}

export function sweepIncidentTapes({
  tapeDir,
  quarantineDir = path.join(tapeDir, ".quarantine"),
  auditLogPath = path.join(tapeDir, "retention-audit.jsonl"),
  now = new Date(),
  graceDays = DEFAULT_GRACE_DAYS,
  actor = process.env.USER || "retention-sweep",
} = {}) {
  const result = {
    sweptAt: now.toISOString(),
    quarantined: [],
    purged: [],
    retained: [],
  };
  if (!tapeDir || !fs.existsSync(tapeDir)) return result;

  fs.mkdirSync(quarantineDir, { recursive: true });

  // 1. Move newly expired tapes into quarantine (reversible within graceDays).
  for (const name of fs.readdirSync(tapeDir)) {
    if (!name.endsWith(".json")) continue;
    const fullPath = path.join(tapeDir, name);
    if (!fs.statSync(fullPath).isFile()) continue;

    const raw = fs.readFileSync(fullPath, "utf8");
    const parsed = JSON.parse(raw);
    const tier = parsed.tier || (parsed.scrubbed === false ? "command-internal" : "volunteer-safe");
    const expiresAt = parsed.expiresAt || computeTapeExpiry(parsed.generatedAt, tier);
    const expMs = Date.parse(expiresAt);

    if (Number.isFinite(expMs) && expMs <= now.getTime()) {
      const purgeAfter = new Date(now.getTime() + graceDays * 86_400_000).toISOString();
      const destPath = path.join(quarantineDir, name);
      const metaPath = path.join(quarantineDir, `${name}.meta.json`);
      const digest = sha256Hex(raw);
      fs.renameSync(fullPath, destPath);
      fs.writeFileSync(
        metaPath,
        JSON.stringify(
          {
            originalName: name,
            quarantinedAt: now.toISOString(),
            purgeAfter,
            sha256: digest,
            tier,
            expiresAt,
          },
          null,
          2,
        ),
      );
      appendAuditEvent(auditLogPath, {
        timestamp: now.toISOString(),
        action: "quarantine",
        file: name,
        sha256: digest,
        tier,
        expiresAt,
        reversibleUntil: purgeAfter,
        actor,
      });
      result.quarantined.push(name);
    } else {
      result.retained.push(name);
    }
  }

  // 2. Permanently purge quarantined tapes whose grace window has elapsed.
  for (const name of fs.readdirSync(quarantineDir)) {
    if (!name.endsWith(".meta.json")) continue;
    const metaPath = path.join(quarantineDir, name);
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const purgeMs = Date.parse(meta.purgeAfter);
    if (Number.isFinite(purgeMs) && purgeMs <= now.getTime()) {
      const targetPath = path.join(quarantineDir, meta.originalName);
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      fs.unlinkSync(metaPath);
      appendAuditEvent(auditLogPath, {
        timestamp: now.toISOString(),
        action: "purge",
        file: meta.originalName,
        sha256: meta.sha256,
        tier: meta.tier,
        expiresAt: meta.expiresAt,
        actor,
      });
      result.purged.push(meta.originalName);
    }
  }

  return result;
}

export function restoreQuarantinedTape({
  tapeDir,
  quarantineDir = path.join(tapeDir, ".quarantine"),
  auditLogPath = path.join(tapeDir, "retention-audit.jsonl"),
  filename,
  now = new Date(),
  actor = process.env.USER || "retention-restore",
}) {
  const qPath = path.join(quarantineDir, filename);
  const metaPath = path.join(quarantineDir, `${filename}.meta.json`);
  if (!fs.existsSync(qPath) || !fs.existsSync(metaPath)) {
    throw new Error(`Quarantined tape not found: ${filename}`);
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  if (Date.parse(meta.purgeAfter) <= now.getTime()) {
    throw new Error(`Retention grace window expired for ${filename}`);
  }
  const destPath = path.join(tapeDir, filename);
  fs.renameSync(qPath, destPath);
  fs.unlinkSync(metaPath);
  appendAuditEvent(auditLogPath, {
    timestamp: now.toISOString(),
    action: "restore",
    file: filename,
    sha256: meta.sha256,
    tier: meta.tier,
    expiresAt: meta.expiresAt,
    actor,
  });
  return { restored: destPath, sha256: meta.sha256 };
}
