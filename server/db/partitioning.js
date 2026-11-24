const DEFAULT_HASH_BUCKETS = 16;

export function quoteIdent(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return `"${value.replace(/"/g, '""')}"`;
}

export function monthKey(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid partition date: ${date}`);
  return `${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function nextMonth(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid partition date: ${date}`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

export function tenantBucket(tenantId, buckets = DEFAULT_HASH_BUCKETS) {
  if (!tenantId) throw new Error("tenantId is required");
  if (!Number.isInteger(buckets) || buckets < 1 || buckets > 1024) {
    throw new Error("buckets must be an integer between 1 and 1024");
  }
  let hash = 2166136261;
  for (const ch of String(tenantId)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % buckets;
}

export function buildMonthlyTenantPartitions({
  baseTable,
  tenantId,
  start,
  months = 3,
  buckets = DEFAULT_HASH_BUCKETS,
} = {}) {
  if (!baseTable) throw new Error("baseTable is required");
  if (!Number.isInteger(months) || months < 1 || months > 36) {
    throw new Error("months must be an integer between 1 and 36");
  }
  const bucket = tenantBucket(tenantId, buckets);
  const out = [];
  let cursor = new Date(start || Date.now());
  cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1));
  for (let i = 0; i < months; i++) {
    const from = cursor;
    const to = nextMonth(cursor);
    out.push({
      name: `${baseTable}_t${bucket}_${monthKey(from)}`,
      baseTable,
      tenantId,
      bucket,
      from: from.toISOString(),
      to: to.toISOString(),
    });
    cursor = to;
  }
  return out;
}

export function renderPartitionDDL(partitions, { tenantColumn = "tenant_bucket", timeColumn = "created_at" } = {}) {
  return partitions.map((p) => {
    const table = quoteIdent(p.name);
    const parent = quoteIdent(p.baseTable);
    return [
      `CREATE TABLE IF NOT EXISTS ${table} PARTITION OF ${parent}`,
      `FOR VALUES FROM (${p.bucket}, '${p.from}') TO (${p.bucket + 1}, '${p.to}');`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${p.name}_${timeColumn}_idx`)} ON ${table} (${quoteIdent(timeColumn)} DESC);`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${p.name}_${tenantColumn}_idx`)} ON ${table} (${quoteIdent(tenantColumn)});`,
    ].join("\n");
  }).join("\n\n");
}

export function createPartitionManifest(config) {
  const partitions = buildMonthlyTenantPartitions(config);
  return {
    strategy: "tenant_hash_monthly_range",
    hashBuckets: config.buckets || DEFAULT_HASH_BUCKETS,
    partitions,
    ddl: renderPartitionDDL(partitions, config),
  };
}
