import { describe, it, expect } from "vitest";
import { MemoryTransport } from "../../src/transport/memory.js";
import type { UsageRecord } from "../../src/types.js";

function fakeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: "rec-1",
    timestamp: "2026-02-15T00:00:00.000Z",
    serviceId: "test-svc",
    agent: { agentId: "agent-1" },
    operation: "GET /test",
    units: 1,
    unitType: "request",
    pricingModel: "per-call",
    method: "GET",
    path: "/test",
    statusCode: 200,
    durationMs: 42,
    ...overrides,
  };
}

describe("MemoryTransport", () => {
  it("stores sent records", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord());
    transport.send(fakeRecord({ id: "rec-2" }));

    expect(transport.records).toHaveLength(2);
    expect(transport.records[0].id).toBe("rec-1");
    expect(transport.records[1].id).toBe("rec-2");
  });

  it("clears records on flush", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord());
    expect(transport.records).toHaveLength(1);

    transport.flush();
    expect(transport.records).toHaveLength(0);
  });
});
