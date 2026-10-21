import { describe, expect, it } from "vitest";
import { ContractEventStreamer, InMemoryAuditSink, normalizeContractEvent } from "../server/indexer/auditStreamer.js";

describe("audit event streamer", () => {
  it("normalizes contract event payloads", () => {
    const event = normalizeContractEvent({
      pagingToken: "123",
      ledger: 42,
      contractId: "CAEGIS",
      topic: "aid_claimed",
      transactionHash: "tx",
      value: { recipient: "G..." },
    }, { observedAt: "2026-01-01T00:00:00Z" });

    expect(event.id).toBe("123");
    expect(event.type).toBe("aid_claimed");
    expect(event.payload).toEqual({ recipient: "G..." });
  });

  it("deduplicates events and advances the cursor", async () => {
    const sink = new InMemoryAuditSink();
    const streamer = new ContractEventStreamer({
      sink,
      fetchEvents: async ({ cursor }) => ({
        cursor: "batch-end",
        events: [
          { pagingToken: cursor ? "2" : "1", topic: "created", payload: { n: 1 } },
          { pagingToken: cursor ? "2" : "1", topic: "created", payload: { n: 1 } },
        ],
      }),
    });

    expect(await streamer.poll()).toEqual({ appended: 1, cursor: "batch-end" });
    expect(await streamer.poll()).toEqual({ appended: 1, cursor: "batch-end" });
    expect(sink.latest()).toHaveLength(2);
  });
});
