/**
 * Encrypted private-key backup using Shamir's Secret Sharing (2-of-3
 * guardian shards) over GF(256), with each shard additionally encrypted
 * at rest under a user passphrase via AES-GCM (WebCrypto).
 */

const GF256_EXP = new Uint8Array(512);
const GF256_LOG = new Uint8Array(256);

(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF256_EXP[i] = x;
    GF256_LOG[x] = i;
    x = x << 1;
    if (x & 0x100) x ^= 0x11b;
  }
  for (let i = 255; i < 512; i++) {
    GF256_EXP[i] = GF256_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF256_EXP[GF256_LOG[a] + GF256_LOG[b]];
}

function gfDiv(a: number, b: number): number {
  if (a === 0) return 0;
  return GF256_EXP[(GF256_LOG[a] - GF256_LOG[b] + 255) % 255];
}

export interface Shard {
  index: number;
  data: Uint8Array;
}

/** Split `secret` into `totalShards` shards, any `threshold` of which reconstruct it. */
export function splitSecret(secret: Uint8Array, threshold = 2, totalShards = 3): Shard[] {
  const shards: Shard[] = [];
  for (let i = 1; i <= totalShards; i++) {
    shards.push({ index: i, data: new Uint8Array(secret.length) });
  }

  for (let byteIdx = 0; byteIdx < secret.length; byteIdx++) {
    const coeffs = new Uint8Array(threshold);
    coeffs[0] = secret[byteIdx];
    for (let c = 1; c < threshold; c++) {
      coeffs[c] = Math.floor(Math.random() * 256);
    }

    for (const shard of shards) {
      let y = 0;
      for (let c = threshold - 1; c >= 0; c--) {
        y = gfMul(y, shard.index) ^ coeffs[c];
      }
      shard.data[byteIdx] = y;
    }
  }

  return shards;
}

/** Reconstruct the secret from `threshold` or more shards via Lagrange interpolation. */
export function reconstructSecret(shards: Shard[]): Uint8Array {
  if (shards.length < 2) {
    throw new Error('At least 2 shards are required for reconstruction');
  }

  const length = shards[0].data.length;
  const secret = new Uint8Array(length);

  for (let byteIdx = 0; byteIdx < length; byteIdx++) {
    let result = 0;
    for (let i = 0; i < shards.length; i++) {
      let num = 1;
      let den = 1;
      for (let j = 0; j < shards.length; j++) {
        if (i === j) continue;
        num = gfMul(num, shards[j].index);
        den = gfMul(den, shards[i].index ^ shards[j].index);
      }
      result ^= gfMul(shards[i].data[byteIdx], gfDiv(num, den));
    }
    secret[byteIdx] = result;
  }

  return secret;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface EncryptedShard {
  index: number;
  ciphertext: string; // base64
  iv: string; // base64
  salt: string; // base64
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(str: string): Uint8Array {
  return new Uint8Array(atob(str).split('').map((c) => c.charCodeAt(0)));
}

export async function encryptShard(shard: Shard, passphrase: string): Promise<EncryptedShard> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, shard.data);

  return {
    index: shard.index,
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    iv: toBase64(iv),
    salt: toBase64(salt),
  };
}

export async function decryptShard(encrypted: EncryptedShard, passphrase: string): Promise<Shard> {
  const salt = fromBase64(encrypted.salt);
  const iv = fromBase64(encrypted.iv);
  const key = await deriveKey(passphrase, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    fromBase64(encrypted.ciphertext),
  );

  return { index: encrypted.index, data: new Uint8Array(plaintext) };
}

/** High-level: back up a raw private key into 3 passphrase-encrypted guardian shards. */
export async function backupPrivateKey(
  privateKey: Uint8Array,
  passphrase: string,
): Promise<EncryptedShard[]> {
  const shards = splitSecret(privateKey, 2, 3);
  return Promise.all(shards.map((s) => encryptShard(s, passphrase)));
}

/** High-level: recover a private key from >= 2 of the encrypted guardian shards. */
export async function recoverPrivateKey(
  encryptedShards: EncryptedShard[],
  passphrase: string,
): Promise<Uint8Array> {
  if (encryptedShards.length < 2) {
    throw new Error('At least 2 guardian shards are required for recovery');
  }
  const shards = await Promise.all(encryptedShards.map((e) => decryptShard(e, passphrase)));
  return reconstructSecret(shards);
}
