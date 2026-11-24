const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const counts = new Map();
const durations = new Map();

export function requestMetrics(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : "unmatched";
    const labels = { method: req.method, route, status: String(res.statusCode) };
    const key = Object.values(labels).join("\0");
    counts.set(key, { labels, value: (counts.get(key)?.value || 0) + 1 });
    observeDuration("helphone_http_request_duration_seconds", labels,
      Number(process.hrtime.bigint() - startedAt) / 1e9);
  });
  next();
}

export function observeDuration(name, labels, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  const labelKey = Object.entries(labels).sort().map(([key, value]) => `${key}=${value}`).join("\0");
  const key = `${name}\0${labelKey}`;
  const entry = durations.get(key) || { name, labels, count: 0, sum: 0, buckets: Array(buckets.length).fill(0) };
  entry.count += 1;
  entry.sum += seconds;
  const bucket = buckets.findIndex((bound) => seconds <= bound);
  if (bucket >= 0) entry.buckets[bucket] += 1;
  durations.set(key, entry);
}

export function renderMetrics() {
  const lines = [];
  const addFamily = (name, help, type, samples) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const sample of samples) {
      const labels = Object.entries(sample.labels || {});
      const suffix = labels.length
        ? `{${labels.map(([key, value]) => `${key}="${String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"')}"`).join(",")}}`
        : "";
      lines.push(`${name}${sample.suffix ? `_${sample.suffix}` : ""}${suffix} ${sample.value}`);
    }
  };

  addFamily("helphone_http_requests_total", "HTTP requests handled by this worker.", "counter", [...counts.values()]);
  const families = new Map();
  for (const entry of durations.values()) {
    const family = families.get(entry.name) || [];
    let cumulative = 0;
    buckets.forEach((bound, index) => {
      cumulative += entry.buckets[index];
      family.push({ labels: { ...entry.labels, le: bound }, value: cumulative, suffix: "bucket" });
    });
    family.push({ labels: { ...entry.labels, le: "+Inf" }, value: entry.count, suffix: "bucket" });
    family.push({ labels: entry.labels, value: entry.sum, suffix: "sum" }, { labels: entry.labels, value: entry.count, suffix: "count" });
    families.set(entry.name, family);
  }
  for (const [name, samples] of families) addFamily(name, "Observed operation durations in seconds.", "histogram", samples);
  return `${lines.join("\n")}\n`;
}

export function resetMetrics() {
  counts.clear();
  durations.clear();
}
