const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function byteSize(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export class ZkProofCache {
  constructor({
    namespace = "helphone:zk-proof-cache",
    storage = typeof localStorage !== "undefined" ? localStorage : null,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxBytes = DEFAULT_MAX_BYTES,
    ttlMs = 15 * 60 * 1000,
    now = () => Date.now(),
  } = {}) {
    this.namespace = namespace;
    this.storage = storage;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.now = now;
    this.memory = new Map();
  }

  key(input) {
    return `${this.namespace}:${input}`;
  }

  get(input) {
    const key = this.key(input);
    const record = this.#read(key);
    if (!record) return null;
    if (record.expiresAt <= this.now()) {
      this.#delete(key);
      return null;
    }
    record.lastAccessedAt = this.now();
    this.#write(key, record);
    return record.value;
  }

  set(input, value, metadata = {}) {
    const record = {
      value,
      metadata,
      createdAt: this.now(),
      lastAccessedAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
    };
    this.#write(this.key(input), record);
    this.evict();
    return record;
  }

  delete(input) {
    this.#delete(this.key(input));
  }

  clear() {
    for (const key of this.#keys()) this.#delete(key);
  }

  entries() {
    return this.#keys()
      .map((key) => [key, this.#read(key)])
      .filter(([, value]) => value)
      .map(([key, value]) => ({ key, ...value, bytes: byteSize(value) }));
  }

  stats() {
    const entries = this.entries();
    return {
      entries: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      oldestAccessedAt: entries.reduce((min, entry) => Math.min(min, entry.lastAccessedAt), Infinity),
    };
  }

  evict() {
    const now = this.now();
    for (const entry of this.entries()) {
      if (entry.expiresAt <= now) this.#delete(entry.key);
    }
    let entries = this.entries().sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    while (entries.length > this.maxEntries || entries.reduce((sum, entry) => sum + entry.bytes, 0) > this.maxBytes) {
      const victim = entries.shift();
      if (!victim) break;
      this.#delete(victim.key);
      entries = this.entries().sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    }
  }

  #keys() {
    if (!this.storage) return [...this.memory.keys()].filter((key) => key.startsWith(`${this.namespace}:`));
    const keys = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key?.startsWith(`${this.namespace}:`)) keys.push(key);
    }
    return keys;
  }

  #read(key) {
    try {
      const raw = this.storage ? this.storage.getItem(key) : this.memory.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      this.#delete(key);
      return null;
    }
  }

  #write(key, value) {
    const raw = JSON.stringify(value);
    if (this.storage) this.storage.setItem(key, raw);
    else this.memory.set(key, raw);
  }

  #delete(key) {
    if (this.storage) this.storage.removeItem(key);
    else this.memory.delete(key);
  }
}

export function createZkProofCache(options) {
  return new ZkProofCache(options);
}
