import { describe, expect, it } from "vitest";
import { buildMonthlyTenantPartitions, createPartitionManifest, tenantBucket } from "../server/db/partitioning.js";

describe("tenant partitioning strategy", () => {
  it("assigns tenants to stable hash buckets", () => {
    expect(tenantBucket("tenant-a", 32)).toBe(tenantBucket("tenant-a", 32));
    expect(tenantBucket("tenant-a", 32)).toBeGreaterThanOrEqual(0);
    expect(tenantBucket("tenant-a", 32)).toBeLessThan(32);
  });

  it("builds monthly tenant partitions and ddl", () => {
    const partitions = buildMonthlyTenantPartitions({
      baseTable: "audit_events",
      tenantId: "hospital-1",
      start: "2026-02-12T00:00:00Z",
      months: 2,
      buckets: 8,
    });
    expect(partitions).toHaveLength(2);
    expect(partitions[0].name).toMatch(/^audit_events_t\d_2026_02$/);
    expect(partitions[0].from).toBe("2026-02-01T00:00:00.000Z");
    expect(partitions[1].to).toBe("2026-04-01T00:00:00.000Z");

    const manifest = createPartitionManifest({
      baseTable: "audit_events",
      tenantId: "hospital-1",
      start: "2026-02-12T00:00:00Z",
      months: 1,
    });
    expect(manifest.strategy).toBe("tenant_hash_monthly_range");
    expect(manifest.ddl).toContain("CREATE TABLE IF NOT EXISTS");
    expect(manifest.ddl).toContain("PARTITION OF");
  });
});
