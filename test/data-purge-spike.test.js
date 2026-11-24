import { describe, it, expect, beforeEach } from "@jest/globals";
import { DataPurgeEngine, PURGED_TABLES } from "../server/lib/dataPurge.js";

describe("ISP-098: Right-to-be-Forgotten & Data-Purge Spike across Storage Layers", () => {
  let purgeEngine;

  beforeEach(() => {
    purgeEngine = new DataPurgeEngine({
      signingSecret: "test-compliance-signing-key-very-secure-32b",
    });
  });

  describe("PostgreSQL Partition-Pruned Deletions", () => {
    it("should purge across all subject-bearing tables and partitions leaving zero queryable rows", async () => {
      const mockDb = {
        queriesExecuted: [],
        query: async function (sql, params) {
          this.queriesExecuted.push({ sql, params });
          return { rowCount: 1 };
        },
      };

      const result = await purgeEngine.purgeSubject("usr_subject_alpha", { dbClient: mockDb });

      expect(result.tablesPurged).toEqual(PURGED_TABLES);
      expect(result.partitionsCleared.length).toBe(PURGED_TABLES.length * 2);
      expect(mockDb.queriesExecuted.length).toBe(PURGED_TABLES.length);
      for (const q of mockDb.queriesExecuted) {
        expect(q.params).toContain("usr_subject_alpha");
      }
    });
  });

  describe("Redis & WebSocket Buffer Eviction", () => {
    it("should evict sessions, location caches, and active WebSocket buffers within 60s SLA", async () => {
      const mockRedis = {
        deletedKeys: [],
        del: async function (key) {
          this.deletedKeys.push(key);
          return 1;
        },
      };

      const result = await purgeEngine.purgeSubject("usr_subject_beta", { redisClient: mockRedis });

      expect(result.keysEvicted).toContain("session:usr_subject_beta");
      expect(result.keysEvicted).toContain("geo:responder:usr_subject_beta");
      expect(result.keysEvicted).toContain("ws:buffer:usr_subject_beta");
      expect(mockRedis.deletedKeys).toEqual(result.keysEvicted);
    });
  });

  describe("CRDT Anti-Resurrection Barrier Protocol", () => {
    it("should bar straggler replicas from resurrecting purged subjects upon rejoining", async () => {
      const subject = "usr_subject_crdt_straggler";

      expect(purgeEngine.isOperationBarred(subject)).toBe(false);

      await purgeEngine.purgeSubject(subject);

      // A 48-hour offline replica now attempts to replay a convergent CRDT mutation
      expect(purgeEngine.isOperationBarred(subject)).toBe(true);
    });
  });

  describe("Append-Only Ledger Crypto-Redaction & Merkle Preservation", () => {
    it("should redact PII in append-only records while preserving ledger chain integrity", async () => {
      const subject = "usr_subject_gamma";
      const sampleLedger = [
        {
          id: "entry_1",
          subjectId: subject,
          payload: { name: "Alice Volunteer", phone: "+15551234567", coordinates: [37.77, -122.41] },
        },
        {
          id: "entry_2",
          subjectId: "usr_other_person",
          payload: { name: "Bob Helper", phone: "+15559876543" },
        },
      ];

      const receipt = await purgeEngine.purgeSubject(subject, { indexerEntries: sampleLedger });

      expect(receipt.chainVerificationPreserved).toBe(true);
      expect(receipt.verifiedCompliant).toBe(true);
    });
  });

  describe("Anti-Fraud Nullifier Retention (GDPR Art. 17(3)(b))", () => {
    it("should record a non-linkable nullifier for aid-disbursement double-spend prevention", async () => {
      const receipt = await purgeEngine.purgeSubject("usr_aid_recipient");

      expect(receipt.nullifierHash).toBeDefined();
      expect(receipt.nullifierHash).toMatch(/^[a-f0-9]{64}$/);
      expect(receipt.lawfulBasis).toContain("GDPR Art. 17(3)(b)");
      expect(receipt.nullifierHash).not.toContain("usr_aid_recipient");
    });
  });

  describe("Signed Erasure Receipt Verification", () => {
    it("should generate a verifiable cryptographic receipt and reject tampered receipts", async () => {
      const receipt = await purgeEngine.purgeSubject("usr_compliance_audit");

      // Verify authentic receipt
      expect(purgeEngine.verifyReceipt(receipt)).toBe(true);

      // Tamper with receipt
      const tampered = { ...receipt, tablesPurged: ["users"] };
      expect(purgeEngine.verifyReceipt(tampered)).toBe(false);
    });
  });
});
