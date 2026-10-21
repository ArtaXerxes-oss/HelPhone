// Deterministic synthetic SOS / responder workload for the clustering spike
// (issue #608). Shared by the in-app benchmark (WebGPUMap) and the Node CPU
// benchmark so both measure the same point distribution.

/** mulberry32 — tiny seeded PRNG so benchmark runs are reproducible. */
export function createRng(seed = 608) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  const u = Math.max(rng(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * 70% of points sit in Gaussian incident hotspots, 30% are uniform background
 * (scattered responders), which is the worst realistic case for a grid: many
 * occupied cells plus a few very hot ones.
 */
export function generateIncidents(count, { width, height, hotspots = 24, seed = 608 } = {}) {
  const rng = createRng(seed);
  const centres = Array.from({ length: hotspots }, () => ({
    x: rng() * width,
    y: rng() * height,
    spread: 8 + rng() * 40,
  }));
  const points = new Float32Array(count * 2);
  const velocity = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    let x;
    let y;
    if (rng() < 0.7) {
      const h = centres[Math.floor(rng() * hotspots)];
      x = h.x + gaussian(rng) * h.spread;
      y = h.y + gaussian(rng) * h.spread;
    } else {
      x = rng() * width;
      y = rng() * height;
    }
    points[2 * i] = Math.min(width - 0.001, Math.max(0, x));
    points[2 * i + 1] = Math.min(height - 0.001, Math.max(0, y));
    velocity[2 * i] = (rng() - 0.5) * 1.2;
    velocity[2 * i + 1] = (rng() - 0.5) * 1.2;
  }
  return { points, velocity };
}

/** Advance every point one frame, bouncing off the viewport edges. */
export function stepIncidents(points, velocity, width, height) {
  for (let i = 0; i < points.length; i += 2) {
    let x = points[i] + velocity[i];
    let y = points[i + 1] + velocity[i + 1];
    if (x < 0 || x >= width) {
      velocity[i] = -velocity[i];
      x = Math.min(width - 0.001, Math.max(0, x));
    }
    if (y < 0 || y >= height) {
      velocity[i + 1] = -velocity[i + 1];
      y = Math.min(height - 0.001, Math.max(0, y));
    }
    points[i] = x;
    points[i + 1] = y;
  }
}
