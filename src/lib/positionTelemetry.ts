export type PositionSourceName = 'puck' | 'phone' | 'manual';

export interface PositionReliabilitySnapshot {
  switches: number;
  stale: number;
  accuracyBuckets: Record<'phone' | 'puck', Record<'good' | 'fair' | 'poor', number>>;
  geohashes: Record<string, number>;
  source: Record<PositionSourceName, number>;
  reliability: Record<PositionSourceName, number>;
}

const MAX_COUNTER = 10_000;
const MAX_GEOHASHES = 64;
const bounded = (n: number) => Math.min(MAX_COUNTER, n);

function geohash5(lat: number, lng: number): string {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  const alphabet = '0123456789bcdefghjkmnpqrstuvwxyz';
  let even = true, bit = 0, ch = 0, out = '';
  while (out.length < 5) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lng >= mid) { ch |= 1 << (4 - bit); lonMin = mid; } else lonMax = mid;
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch |= 1 << (4 - bit); latMin = mid; } else latMax = mid;
    }
    even = !even;
    if (++bit === 5) { out += alphabet[ch]; bit = 0; ch = 0; }
  }
  return out;
}

let snapshot: PositionReliabilitySnapshot = {
  switches: 0,
  stale: 0,
  accuracyBuckets: { phone: { good: 0, fair: 0, poor: 0 }, puck: { good: 0, fair: 0, poor: 0 } },
  geohashes: {},
  source: { puck: 0, phone: 0, manual: 0 },
  reliability: { puck: 0, phone: 0, manual: 0 },
};

export function recordPositionFix(source: PositionSourceName, lat: number, lng: number, accuracy: number, stale = false): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  snapshot.source[source] = bounded(snapshot.source[source] + 1);
  if (stale) snapshot.stale = bounded(snapshot.stale + 1);
  if (source === 'puck' || source === 'phone') {
    const bucket = accuracy <= 10 ? 'good' : accuracy <= 50 ? 'fair' : 'poor';
    snapshot.accuracyBuckets[source][bucket] = bounded(snapshot.accuracyBuckets[source][bucket] + 1);
  }
  const gh = geohash5(lat, lng);
  snapshot.geohashes[gh] = bounded((snapshot.geohashes[gh] || 0) + 1);
  if (Object.keys(snapshot.geohashes).length > MAX_GEOHASHES) {
    const lowest = Object.entries(snapshot.geohashes).sort((a, b) => a[1] - b[1])[0];
    delete snapshot.geohashes[lowest[0]];
  }
  const puck = snapshot.source.puck;
  const phone = snapshot.source.phone;
  snapshot.reliability.puck = puck + phone ? puck / (puck + phone) : 0;
  snapshot.reliability.phone = puck + phone ? phone / (puck + phone) : 0;
}

export function recordPositionSwitch(from: PositionSourceName | null, to: PositionSourceName): void {
  if (from !== to) snapshot.switches = bounded(snapshot.switches + 1);
}

export function getPositionReliability(): PositionReliabilitySnapshot {
  return JSON.parse(JSON.stringify(snapshot));
}

export function resetPositionTelemetry(): void {
  snapshot = {
    switches: 0, stale: 0,
    accuracyBuckets: { phone: { good: 0, fair: 0, poor: 0 }, puck: { good: 0, fair: 0, poor: 0 } },
    geohashes: {}, source: { puck: 0, phone: 0, manual: 0 }, reliability: { puck: 0, phone: 0, manual: 0 },
  };
}
