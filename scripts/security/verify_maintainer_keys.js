#!/usr/bin/env node
// #619 — Maintainer key revocation & web-of-trust verification engine.
//
// Validates OpenPGP signatures on git commits, tags and release artifacts
// against LIVE key revocation data pulled from OpenPGP keyservers, so a
// release signed with a key that was later found to be compromised is caught
// even though the signature predates the revocation.
//
// Revocation semantics (RFC 4880 §5.2.3.23):
//   - reason 0x00 (none) / 0x02 (key compromised): EVERY signature by the key
//     is invalid, whenever it was made.
//   - reason 0x01 (superseded) / 0x03 (retired): signatures made before the
//     revocation time stay valid; later ones are invalid.
// Web of trust: a signer is trusted when its primary key is a trusted root in
// config/maintainer-keys.json or carries >= `minCertifications` valid,
// unrevoked third-party certifications from trusted roots.
//
// Everything is verified in-process (RFC 4880 packet parser + node:crypto for
// RSA, EdDSA/Ed25519 and ECDSA): no local gpg needed. Public keys are cached
// under .cache/maintainer-keys/ and refreshed after `cacheTtlHours`.
//
// Usage:
//   node scripts/security/verify_maintainer_keys.js
//        [--range <rev-range>] [--tags [<glob>]] [--pinned]
//        [--artifact <file> --signature <file.asc>]...
//        [--config <path>] [--max <n>] [--strict] [--offline] [--refresh] [--json]
// Defaults to `--pinned --range HEAD --max 50` when no target is given.
// Exit 1 on any FAIL (bad signature, compromised key, fingerprint mismatch);
// unsigned / untrusted / unknown-key findings WARN, and FAIL under --strict.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Armor / packets (RFC 4880 §4, §6) ────────────────────────────────────

/** Decode every ASCII-armored block in `text` (or pass binary through). */
export function dearmor(input) {
  if (Buffer.isBuffer(input) && input[0] & 0x80) return input;
  const text = input.toString();
  const blocks = [];
  const re = /-----BEGIN PGP [A-Z ]+-----\r?\n([\s\S]*?)-----END PGP [A-Z ]+-----/g;
  let m;
  while ((m = re.exec(text))) {
    const lines = m[1].split(/\r?\n/);
    const blank = lines.findIndex((l) => l.trim() === "");
    const body = lines
      .slice(blank + 1)
      .filter((l) => l && !l.startsWith("="))
      .join("");
    blocks.push(Buffer.from(body, "base64"));
  }
  return Buffer.concat(blocks);
}

export function* readPackets(buf) {
  let i = 0;
  while (i < buf.length) {
    const ctb = buf[i++];
    if (!(ctb & 0x80)) throw new Error(`invalid packet header at ${i - 1}`);
    let tag;
    let len;
    if (ctb & 0x40) {
      tag = ctb & 0x3f;
      const o = buf[i++];
      if (o < 192) len = o;
      else if (o < 224) len = ((o - 192) << 8) + buf[i++] + 192;
      else if (o === 255) {
        len = buf.readUInt32BE(i);
        i += 4;
      } else throw new Error("partial-length packets are not used in keys/signatures");
    } else {
      tag = (ctb >> 2) & 0x0f;
      const lt = ctb & 3;
      if (lt === 0) len = buf[i++];
      else if (lt === 1) {
        len = buf.readUInt16BE(i);
        i += 2;
      } else if (lt === 2) {
        len = buf.readUInt32BE(i);
        i += 4;
      } else len = buf.length - i;
    }
    yield { tag, body: buf.subarray(i, i + len) };
    i += len;
  }
}

function readMpi(buf, off) {
  const bits = buf.readUInt16BE(off);
  const bytes = (bits + 7) >> 3;
  return { value: buf.subarray(off + 2, off + 2 + bytes), next: off + 2 + bytes };
}

const b64url = (b) => Buffer.from(b).toString("base64url");
const leftPad = (b, n) => (b.length >= n ? b.subarray(b.length - n) : Buffer.concat([Buffer.alloc(n - b.length), b]));
const hex = (b) => Buffer.from(b).toString("hex").toUpperCase();

const HASHES = { 1: "md5", 2: "sha1", 3: "ripemd160", 8: "sha256", 9: "sha384", 10: "sha512", 11: "sha224" };
const OID = {
  "2B06010401DA470F01": "Ed25519",
  "2A8648CE3D030107": "P-256",
  "2B81040022": "P-384",
  "2B81040023": "P-521",
};
const EC_SIZE = { "P-256": 32, "P-384": 48, "P-521": 66 };

/** Parse a v4 public (sub)key packet body. */
export function parsePublicKey(body) {
  const version = body[0];
  if (version !== 4) return { version, unsupported: `v${version} keys` };
  const created = body.readUInt32BE(1);
  const algo = body[5];
  const fpr = hex(crypto.createHash("sha1").update(keyPrefix(body)).digest());
  const key = { version, created, algo, fingerprint: fpr, keyId: fpr.slice(-16), body };
  try {
    if (algo === 1 || algo === 3) {
      const n = readMpi(body, 6);
      const e = readMpi(body, n.next);
      key.publicKey = crypto.createPublicKey({ key: { kty: "RSA", n: b64url(n.value), e: b64url(e.value) }, format: "jwk" });
    } else if (algo === 22 || algo === 19) {
      const oidLen = body[6];
      const curve = OID[hex(body.subarray(7, 7 + oidLen))];
      const point = readMpi(body, 7 + oidLen).value;
      if (algo === 22 && curve === "Ed25519") {
        key.publicKey = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(point.subarray(1)) }, format: "jwk" });
      } else if (algo === 19 && EC_SIZE[curve]) {
        const n = EC_SIZE[curve];
        key.publicKey = crypto.createPublicKey({
          key: { kty: "EC", crv: curve, x: b64url(point.subarray(1, 1 + n)), y: b64url(point.subarray(1 + n)) },
          format: "jwk",
        });
      }
      key.curve = curve;
    } else if (algo === 27) {
      key.publicKey = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(body.subarray(6, 38)) }, format: "jwk" });
    }
  } catch {
    key.publicKey = undefined;
  }
  return key;
}

function keyPrefix(body) {
  const h = Buffer.alloc(3);
  h[0] = 0x99;
  h.writeUInt16BE(body.length, 1);
  return Buffer.concat([h, body]);
}

function readSubpackets(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let len = buf[i++];
    if (len >= 192 && len < 255) len = ((len - 192) << 8) + buf[i++] + 192;
    else if (len === 255) {
      len = buf.readUInt32BE(i);
      i += 4;
    }
    out.push({ type: buf[i] & 0x7f, data: buf.subarray(i + 1, i + len) });
    i += len;
  }
  return out;
}

/** Parse a v4 signature packet body. */
export function parseSignature(body) {
  const version = body[0];
  if (version !== 4) return { version, unsupported: `v${version} signatures` };
  const type = body[1];
  const pubAlgo = body[2];
  const hashAlgo = body[3];
  const hashedLen = body.readUInt16BE(4);
  const hashedEnd = 6 + hashedLen;
  const hashed = readSubpackets(body.subarray(6, hashedEnd));
  const unhashedLen = body.readUInt16BE(hashedEnd);
  const unhashed = readSubpackets(body.subarray(hashedEnd + 2, hashedEnd + 2 + unhashedLen));
  let off = hashedEnd + 2 + unhashedLen;
  const left16 = body.subarray(off, off + 2);
  off += 2;
  const sig = { version, type, pubAlgo, hashAlgo, hashedPart: body.subarray(0, hashedEnd), left16, body };
  if (pubAlgo === 27) sig.raw = body.subarray(off, off + 64);
  else {
    sig.mpis = [];
    while (off < body.length) {
      const m = readMpi(body, off);
      sig.mpis.push(m.value);
      off = m.next;
    }
  }
  for (const sp of [...hashed, ...unhashed]) {
    if (sp.type === 2 && sig.created === undefined) sig.created = sp.data.readUInt32BE(0);
    if (sp.type === 3 && hashed.includes(sp)) sig.expiresIn = sp.data.readUInt32BE(0);
    if (sp.type === 9 && hashed.includes(sp)) sig.keyExpiresIn = sp.data.readUInt32BE(0);
    if (sp.type === 16 && !sig.issuerKeyId) sig.issuerKeyId = hex(sp.data);
    if (sp.type === 33 && !sig.issuerFpr) sig.issuerFpr = hex(sp.data.subarray(1));
    if (sp.type === 29 && hashed.includes(sp)) {
      sig.reasonCode = sp.data[0];
      sig.reasonText = sp.data.subarray(1).toString("utf8");
    }
  }
  if (!sig.issuerKeyId && sig.issuerFpr) sig.issuerKeyId = sig.issuerFpr.slice(-16);
  return sig;
}

/** Verify `sig` over `prefix` (the signed data) with `key`. true/false, or
 *  null when the algorithm is not supported. */
export function verifySignature(sig, key, prefix) {
  if (!key?.publicKey || sig.unsupported) return null;
  const hashName = HASHES[sig.hashAlgo];
  if (!hashName || hashName === "md5") return null;
  const trailer = Buffer.alloc(6);
  trailer[0] = 0x04;
  trailer[1] = 0xff;
  trailer.writeUInt32BE(sig.hashedPart.length, 2);
  const data = Buffer.concat([prefix, sig.hashedPart, trailer]);
  const digest = crypto.createHash(hashName).update(data).digest();
  if (!digest.subarray(0, 2).equals(sig.left16)) return false;
  try {
    if (key.algo === 1 || key.algo === 3) {
      const modLen = (key.publicKey.asymmetricKeyDetails.modulusLength + 7) >> 3;
      return crypto.verify(hashName, data, key.publicKey, leftPad(sig.mpis[0], modLen));
    }
    if (key.algo === 22 || key.algo === 27) {
      const raw = sig.raw || Buffer.concat([leftPad(sig.mpis[0], 32), leftPad(sig.mpis[1], 32)]);
      return crypto.verify(null, digest, key.publicKey, raw);
    }
    if (key.algo === 19) {
      const n = EC_SIZE[key.curve];
      const rs = Buffer.concat([leftPad(sig.mpis[0], n), leftPad(sig.mpis[1], n)]);
      return crypto.verify(hashName, data, { key: key.publicKey, dsaEncoding: "ieee-p1363" }, rs);
    }
  } catch {
    return false;
  }
  return null;
}

function uidPrefix(tag, body) {
  const h = Buffer.alloc(5);
  h[0] = tag === 17 ? 0xd1 : 0xb4;
  h.writeUInt32BE(body.length, 1);
  return Buffer.concat([h, body]);
}

/** Parse transferable public keys (primary + UIDs + subkeys + signatures).
 *  Duplicate copies of one key (several keyservers) are merged. */
export function parseKeys(input) {
  const keys = new Map();
  let key = null;
  let uid = null;
  let sub = null;
  for (const { tag, body } of readPackets(dearmor(input))) {
    if (tag === 6) {
      const k = parsePublicKey(body);
      key = keys.get(k.fingerprint) || { ...k, uids: [], subkeys: [], revocations: [] };
      keys.set(k.fingerprint, key);
      uid = sub = null;
    } else if (!key) {
      continue;
    } else if (tag === 13 || tag === 17) {
      const text = tag === 13 ? body.toString("utf8") : "[user attribute]";
      uid = key.uids.find((u) => u.body.equals(body)) || { tag, body, text, sigs: [] };
      if (!key.uids.includes(uid)) key.uids.push(uid);
      sub = null;
    } else if (tag === 14) {
      const s = parsePublicKey(body);
      sub = key.subkeys.find((x) => x.fingerprint === s.fingerprint) || { ...s, revocations: [] };
      if (!key.subkeys.includes(sub)) key.subkeys.push(sub);
      uid = null;
    } else if (tag === 2) {
      const sig = parseSignature(body);
      const primary = keyPrefix(key.body);
      if (sig.type === 0x20) {
        sig.verified = verifySignature(sig, key, primary);
        key.revocations.push(sig);
      } else if (sig.type === 0x28 && sub) {
        sig.verified = verifySignature(sig, key, Buffer.concat([primary, keyPrefix(sub.body)]));
        sub.revocations.push(sig);
      } else if (uid && ((sig.type >= 0x10 && sig.type <= 0x13) || sig.type === 0x30)) {
        sig.prefix = Buffer.concat([primary, uidPrefix(uid.tag, uid.body)]);
        uid.sigs.push(sig);
      }
    }
  }
  return [...keys.values()];
}

// ── Policy ───────────────────────────────────────────────────────────────

export const REVOCATION_REASONS = {
  0: "no reason specified",
  1: "key superseded",
  2: "key compromised",
  3: "key retired",
};

const isSelfIssued = (sig, key) =>
  sig.issuerFpr ? sig.issuerFpr === key.fingerprint : sig.issuerKeyId === key.keyId;

/** Effective revocation for a key (or the subkey `signingFpr`): the most
 *  severe self-issued revocation that verifies (or cannot be checked — a
 *  revocation is never ignored just because the algorithm is unsupported). */
export function revocationOf(key, signingFpr) {
  const candidates = [...key.revocations];
  const sub = key.subkeys.find((s) => s.fingerprint === signingFpr);
  if (sub) candidates.push(...sub.revocations);
  const valid = candidates.filter((r) => isSelfIssued(r, key) && r.verified !== false);
  if (!valid.length) return null;
  const severity = (r) => ([1, 3].includes(r.reasonCode) ? 0 : 1);
  valid.sort((a, b) => severity(b) - severity(a) || a.created - b.created);
  const r = valid[0];
  return {
    time: r.created,
    code: r.reasonCode ?? 0,
    reason: REVOCATION_REASONS[r.reasonCode ?? 0] || `reason 0x${(r.reasonCode ?? 0).toString(16)}`,
    text: r.reasonText || "",
    subkey: sub && sub.revocations.includes(r) ? sub.fingerprint : null,
    verified: r.verified,
  };
}

/** Is a signature made at `sigTime` still valid given the key's revocation? */
export function evaluateSignatureTime(revocation, sigTime) {
  if (!revocation) return { valid: true };
  const soft = revocation.code === 1 || revocation.code === 3;
  if (soft && sigTime < revocation.time) {
    return { valid: true, note: `signed before the key was revoked (${revocation.reason})` };
  }
  return {
    valid: false,
    reason: soft
      ? `signed after the key was revoked (${revocation.reason})`
      : `key revoked: ${revocation.reason}${revocation.text ? ` — "${revocation.text}"` : ""}; every signature by it is invalid`,
  };
}

/** Web-of-trust decision for `key` against trusted root keys. */
export function webOfTrust(key, trustedKeys, minCertifications = 1) {
  const roots = new Map(trustedKeys.map((k) => [k.fingerprint, k]));
  if (roots.has(key.fingerprint)) return { trusted: true, root: true, certifiers: [] };
  const certifiers = new Set();
  for (const uid of key.uids) {
    for (const cert of uid.sigs) {
      if (cert.type < 0x10 || cert.type > 0x13) continue;
      const issuer = [...roots.values()].find((r) => (cert.issuerFpr ? r.fingerprint === cert.issuerFpr : r.keyId === cert.issuerKeyId));
      if (!issuer) continue;
      const rootRev = revocationOf(issuer);
      if (rootRev && !evaluateSignatureTime(rootRev, cert.created).valid) continue;
      if (verifySignature(cert, issuer, cert.prefix) !== true) continue;
      const revoked = uid.sigs.some(
        (r) =>
          r.type === 0x30 &&
          (r.issuerFpr || r.issuerKeyId) &&
          (r.issuerFpr ? r.issuerFpr === issuer.fingerprint : r.issuerKeyId === issuer.keyId) &&
          r.created >= cert.created &&
          verifySignature(r, issuer, r.prefix) === true,
      );
      if (!revoked) certifiers.add(issuer.fingerprint);
    }
  }
  return { trusted: certifiers.size >= minCertifications, root: false, certifiers: [...certifiers] };
}

/** Find the key (primary or subkey) that issued `sig`. */
export function findSigner(sig, keys) {
  for (const key of keys) {
    for (const k of [key, ...key.subkeys]) {
      if (sig.issuerFpr ? k.fingerprint === sig.issuerFpr : k.keyId === sig.issuerKeyId) return { key, signing: k };
    }
  }
  return null;
}

/** Verify a detached signature (git commit/tag payloads, release artifacts)
 *  and apply the revocation + web-of-trust policy. */
export function verifyDetached({ data, signature, keys, trustedKeys = [], minCertifications = 1, label }) {
  const pkt = [...readPackets(dearmor(signature))].find((p) => p.tag === 2);
  if (!pkt) return finding(label, "fail", "no OpenPGP signature packet");
  const sig = parseSignature(pkt.body);
  if (sig.unsupported) return finding(label, "warn", `unsupported signature (${sig.unsupported})`);
  const signer = findSigner(sig, keys);
  const id = sig.issuerFpr || sig.issuerKeyId;
  if (!signer) return finding(label, "unknown", `signing key ${id} not found on keyservers`, { issuer: id });
  let payload = Buffer.from(data);
  if (sig.type === 0x01) payload = Buffer.from(payload.toString("utf8").replace(/\r?\n/g, "\r\n"));
  const ok = verifySignature(sig, signer.signing, payload);
  const meta = { signer: signer.key.fingerprint, signedAt: sig.created };
  if (ok === null) return finding(label, "unknown", `cannot verify algorithm ${sig.pubAlgo} for ${id}`, meta);
  if (!ok) return finding(label, "fail", `BAD signature by ${signer.key.fingerprint}`, meta);
  const verdict = evaluateSignatureTime(revocationOf(signer.key, signer.signing.fingerprint), sig.created);
  if (!verdict.valid) return finding(label, "fail", verdict.reason, meta);
  const wot = webOfTrust(signer.key, trustedKeys, minCertifications);
  const who = signer.key.uids.find((u) => u.tag === 13)?.text || signer.key.fingerprint;
  if (!wot.trusted) return finding(label, "untrusted", `good signature by ${who}, but key is not certified by a trusted root`, meta);
  return finding(
    label,
    "ok",
    `good signature by ${who}${wot.root ? " (trusted root)" : ` (certified by ${wot.certifiers.length} trusted key(s))`}${verdict.note ? `; ${verdict.note}` : ""}`,
    meta,
  );
}

function finding(target, status, detail, extra = {}) {
  return { target, status, detail, ...extra };
}

/** Check a pinned maintainer key against live revocation data. */
export function checkPinnedKey(dep, fingerprint, keys) {
  const label = `${dep.name} key ${fingerprint}`;
  const key = keys.find((k) => k.fingerprint === fingerprint.toUpperCase().replace(/\s+/g, ""));
  if (!key) return finding(label, "unknown", "not found on any keyserver (cannot check revocation)");
  const rev = revocationOf(key);
  if (!rev) return finding(label, "ok", "not revoked");
  if (rev.code === 1 || rev.code === 3) {
    return finding(label, "warn", `${rev.reason} on ${new Date(rev.time * 1000).toISOString().slice(0, 10)}; releases signed before then remain valid — pin the successor key`);
  }
  return finding(
    label,
    "fail",
    `REVOKED (${rev.reason}${rev.text ? `: "${rev.text}"` : ""}) on ${new Date(rev.time * 1000).toISOString().slice(0, 10)} — every ${dep.name} release signed by this key must be re-verified`,
  );
}

// ── Git objects ──────────────────────────────────────────────────────────

/** Split a raw commit object into signed payload + signature. */
export function splitCommit(raw) {
  const text = raw.toString("utf8");
  const headerEnd = text.indexOf("\n\n");
  const headers = text.slice(0, headerEnd).split("\n");
  const kept = [];
  const sigLines = [];
  let inSig = false;
  for (const line of headers) {
    if (/^gpgsig(-sha256)? /.test(line)) {
      inSig = true;
      sigLines.push(line.replace(/^gpgsig(-sha256)? /, ""));
    } else if (inSig && line.startsWith(" ")) {
      sigLines.push(line.slice(1));
    } else {
      inSig = false;
      kept.push(line);
    }
  }
  const payload = kept.join("\n") + text.slice(headerEnd);
  return { payload: Buffer.from(payload, "utf8"), signature: sigLines.length ? sigLines.join("\n") + "\n" : null };
}

/** Split a raw annotated tag object into signed payload + signature. */
export function splitTag(raw) {
  const text = raw.toString("utf8");
  const i = text.search(/-----BEGIN (PGP|SSH) SIGNATURE-----/);
  if (i === -1) return { payload: raw, signature: null };
  return { payload: Buffer.from(text.slice(0, i), "utf8"), signature: text.slice(i) };
}

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024, ...opts });
}

// ── Key cache + keyservers ───────────────────────────────────────────────

function keyserverUrls(server, id) {
  const clean = id.toUpperCase();
  if (/keys\.openpgp\.org/.test(server)) {
    return [`${server}/vks/v1/${clean.length === 40 ? "by-fingerprint" : "by-keyid"}/${clean}`];
  }
  return [`${server}/pks/lookup?op=get&options=mr&search=0x${clean}`];
}

export class KeyStore {
  constructor({ cacheDir, ttlHours = 6, keyservers = [], offline = false, refresh = false, fetchImpl = fetch }) {
    Object.assign(this, { cacheDir, ttlMs: ttlHours * 3600_000, keyservers, offline, refresh, fetchImpl });
  }

  cachePath(id) {
    return path.join(this.cacheDir, `${id.toUpperCase()}.asc`);
  }

  /** Armored key material for a fingerprint or key id (cache, then network). */
  async armored(id) {
    const file = this.cachePath(id);
    const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < this.ttlMs;
    if (fs.existsSync(file) && (this.offline || (fresh && !this.refresh))) return fs.readFileSync(file, "utf8");
    if (this.offline) return null;
    const parts = [];
    for (const server of this.keyservers) {
      for (const url of keyserverUrls(server, id)) {
        try {
          const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
          if (res.ok) parts.push(await res.text());
        } catch {
          // keyserver unreachable: fall through to the next one / the cache
        }
      }
    }
    if (!parts.length) return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    const text = parts.join("\n");
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(file, text);
    return text;
  }

  async keys(ids) {
    const all = [];
    for (const id of new Set(ids.filter(Boolean))) {
      const text = await this.armored(id);
      if (!text) continue;
      try {
        all.push(...parseKeys(text));
      } catch (e) {
        console.warn(`maintainer-keys: WARN cannot parse key ${id}: ${e.message}`);
      }
    }
    return mergeKeys(all);
  }
}

function mergeKeys(list) {
  const byFpr = new Map();
  for (const k of list) {
    const prev = byFpr.get(k.fingerprint);
    if (!prev) byFpr.set(k.fingerprint, k);
    else {
      prev.revocations.push(...k.revocations);
      prev.uids.push(...k.uids);
      prev.subkeys.push(...k.subkeys);
    }
  }
  return [...byFpr.values()];
}

// ── CLI ──────────────────────────────────────────────────────────────────

function issuerOf(signature) {
  try {
    const pkt = [...readPackets(dearmor(signature))].find((p) => p.tag === 2);
    const sig = pkt && parseSignature(pkt.body);
    return sig?.issuerFpr || sig?.issuerKeyId || null;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
  };
  const getAll = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  const strict = args.includes("--strict");
  const configPath = path.resolve(REPO_ROOT, getArg("--config", "config/maintainer-keys.json"));
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const max = Number(getArg("--max", "50"));
  const artifacts = getAll("--artifact").map((a, i) => ({ file: a, sig: getAll("--signature")[i] }));
  const explicit = args.includes("--range") || args.includes("--tags") || args.includes("--pinned") || artifacts.length;
  const range = getArg("--range", explicit ? null : "HEAD");
  const pinned = args.includes("--pinned") || !explicit;

  const store = new KeyStore({
    cacheDir: path.resolve(REPO_ROOT, config.cacheDir || ".cache/maintainer-keys"),
    ttlHours: config.cacheTtlHours ?? 6,
    keyservers: config.keyservers || [],
    offline: args.includes("--offline"),
    refresh: args.includes("--refresh"),
  });
  const trustedKeys = await store.keys((config.trustedKeys || []).map((k) => k.fingerprint));
  const minCerts = config.minCertifications ?? 1;
  const findings = [];

  // 1. Pinned dependency maintainer keys vs live revocation lists.
  if (pinned) {
    for (const dep of config.dependencies || []) {
      const keys = await store.keys(dep.fingerprints || []);
      for (const fpr of dep.fingerprints || []) findings.push(checkPinnedKey(dep, fpr, keys));
    }
    for (const root of config.trustedKeys || []) {
      const key = trustedKeys.find((k) => k.fingerprint === root.fingerprint);
      const rev = key && revocationOf(key);
      if (rev && !(rev.code === 1 || rev.code === 3))
        findings.push(finding(`trusted root ${root.owner}`, "fail", `trusted root key revoked (${rev.reason}) — remove it from ${path.relative(REPO_ROOT, configPath)}`));
    }
  }

  // 2. Git objects: commits in range + tags.
  const objects = [];
  if (range) {
    const shas = git(["rev-list", `--max-count=${max}`, range], { encoding: "utf8" }).split("\n").filter(Boolean);
    for (const sha of shas) objects.push({ label: `commit ${sha.slice(0, 10)}`, ...splitCommit(git(["cat-file", "commit", sha])) });
  }
  if (args.includes("--tags")) {
    const glob = getArg("--tags", "*");
    const tags = git(["for-each-ref", "--format=%(refname:short) %(objecttype)", `refs/tags/${glob}`], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" "));
    for (const [tag, type] of tags) {
      if (type !== "tag") objects.push({ label: `tag ${tag}`, signature: null, lightweight: true });
      else objects.push({ label: `tag ${tag}`, ...splitTag(git(["cat-file", "tag", tag])) });
    }
  }
  for (const { file, sig } of artifacts) {
    if (!sig) {
      findings.push(finding(`artifact ${file}`, "fail", "missing --signature for artifact"));
      continue;
    }
    objects.push({ label: `artifact ${file}`, payload: fs.readFileSync(file), signature: fs.readFileSync(sig, "utf8") });
  }

  const signerKeys = await store.keys(objects.filter((o) => o.signature?.includes("PGP SIGNATURE")).map((o) => issuerOf(o.signature)));
  for (const o of objects) {
    if (!o.signature) findings.push(finding(o.label, "unsigned", o.lightweight ? "lightweight tag (cannot carry a signature)" : "not signed"));
    else if (o.signature.includes("SSH SIGNATURE"))
      findings.push(finding(o.label, "warn", "SSH signature — outside OpenPGP revocation lists; verify with `git verify-commit` + allowed_signers"));
    else
      findings.push(
        verifyDetached({ data: o.payload, signature: o.signature, keys: [...signerKeys, ...trustedKeys], trustedKeys, minCertifications: minCerts, label: o.label }),
      );
  }

  // Soft findings become failures at the --strict (release) boundary.
  const soft = new Set(["unsigned", "unknown", "untrusted", "warn"]);
  for (const f of findings) f.level = f.status === "ok" ? "ok" : f.status === "fail" || (strict && soft.has(f.status)) ? "FAIL" : "WARN";

  if (args.includes("--json")) console.log(JSON.stringify(findings, null, 2));
  else {
    for (const f of findings) {
      const line = `${f.level.padEnd(4)} ${f.target}: [${f.status}] ${f.detail}`;
      if (f.level === "FAIL") console.error(line);
      else if (f.level === "WARN" || !args.includes("--quiet")) console.log(line);
    }
  }
  const fails = findings.filter((f) => f.level === "FAIL").length;
  const warns = findings.filter((f) => f.level === "WARN").length;
  console.log(`verify-maintainer-keys: ${findings.length} checked, ${fails} fail, ${warns} warn${fails ? " — FAIL" : " — OK"}`);
  process.exit(fails ? 1 : 0);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`verify-maintainer-keys: ${e.stack || e.message}`);
    process.exit(2);
  });
}
