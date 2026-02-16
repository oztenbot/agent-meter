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

describe("MemoryTransport.query", () => {
  it("returns all records when no filter", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord({ id: "a" }));
    transport.send(fakeRecord({ id: "b" }));

    const results = transport.query();
    expect(results).toHaveLength(2);
  });

  it("returns a copy, not a reference", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord());

    const results = transport.query();
    results.pop();
    expect(transport.records).toHaveLength(1);
  });

  it("filters by agentId", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord({ agent: { agentId: "a1" } }));
    transport.send(fakeRecord({ agent: { agentId: "a2" } }));
    transport.send(fakeRecord({ agent: { agentId: "a1" } }));

    expect(transport.query({ agentId: "a1" })).toHaveLength(2);
    expect(transport.query({ agentId: "a2" })).toHaveLength(1);
    expect(transport.query({ agentId: "a3" })).toHaveLength(0);
  });

  it("filters by operation", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord({ operation: "GET /widgets" }));
    transport.send(fakeRecord({ operation: "POST /widgets" }));

    expect(transport.query({ operation: "GET /widgets" })).toHaveLength(1);
  });

  it("filters by serviceId", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord({ serviceId: "svc-a" }));
    transport.send(fakeRecord({ serviceId: "svc-b" }));

    expect(transport.query({ serviceId: "svc-a" })).toHaveLength(1);
  });

  it("filters by pricingModel", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord({ pricingModel: "per-call" }));
    transport.send(fakeRecord({ pricingModel: "per-unit" }));

    expect(transport.query({ pricingModel: "per-unit" })).toHaveLength(1);
  });

  it("filters by time range (string)", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord({ timestamp: "2026-02-14T00:00:00.000Z" }));
    transport.send(fakeRecord({ timestamp: "2026-02-15T12:00:00.000Z" }));
    transport.send(fakeRecord({ timestamp: "2026-02-16T00:00:00.000Z" }));

    const results = transport.query({
      from: "2026-02-15T00:00:00.000Z",
      to: "2026-02-16T00:00:00.000Z",
    });
    expect(results).toHaveLength(1);
    expect(results[0].timestamp).toBe("2026-02-15T12:00:00.000Z");
  });

  it("filters by time range (Date)", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord({ timestamp: "2026-02-14T00:00:00.000Z" }));
    transport.send(fakeRecord({ timestamp: "2026-02-15T12:00:00.000Z" }));

    const results = transport.query({
      from: new Date("2026-02-15T00:00:00.000Z"),
    });
    expect(results).toHaveLength(1);
  });

  it("applies limit", () => {
    const transport = new MemoryTransport();
    for (let i = 0; i < 10; i++) {
      transport.send(fakeRecord({ id: `rec-${i}` }));
    }

    expect(transport.query({ limit: 3 })).toHaveLength(3);
  });

  it("applies offset", () => {
    const transport = new MemoryTransport();
    for (let i = 0; i < 5; i++) {
      transport.send(fakeRecord({ id: `rec-${i}` }));
    }

    const results = transport.query({ offset: 2, limit: 2 });
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("rec-2");
    expect(results[1].id).toBe("rec-3");
  });

  it("combines multiple filters", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord({ agent: { agentId: "a1" }, operation: "GET /x" }));
    transport.send(fakeRecord({ agent: { agentId: "a1" }, operation: "POST /x" }));
    transport.send(fakeRecord({ agent: { agentId: "a2" }, operation: "GET /x" }));

    const results = transport.query({ agentId: "a1", operation: "GET /x" });
    expect(results).toHaveLength(1);
  });
});

describe("MemoryTransport.count", () => {
  it("returns total count when no filter", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord());
    transport.send(fakeRecord());

    expect(transport.count()).toBe(2);
  });

  it("returns filtered count", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord({ agent: { agentId: "a1" } }));
    transport.send(fakeRecord({ agent: { agentId: "a2" } }));
    transport.send(fakeRecord({ agent: { agentId: "a1" } }));

    expect(transport.count({ agentId: "a1" })).toBe(2);
  });
});

describe("MemoryTransport.summary", () => {
  it("returns full summary when no filter", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord({ agent: { agentId: "a1" }, operation: "GET /x", units: 5 }));
    transport.send(fakeRecord({ agent: { agentId: "a1" }, operation: "POST /x", units: 3 }));
    transport.send(fakeRecord({ agent: { agentId: "a2" }, operation: "GET /x", units: 2 }));

    const s = transport.summary();

    expect(s.totalRecords).toBe(3);
    expect(s.totalUnits).toBe(10);
    expect(s.uniqueAgents).toBe(2);

    expect(s.byOperation["GET /x"].count).toBe(2);
    expect(s.byOperation["GET /x"].units).toBe(7);
    expect(s.byOperation["POST /x"].count).toBe(1);
    expect(s.byOperation["POST /x"].units).toBe(3);

    expect(s.byAgent["a1"].count).toBe(2);
    expect(s.byAgent["a1"].units).toBe(8);
    expect(s.byAgent["a2"].count).toBe(1);
    expect(s.byAgent["a2"].units).toBe(2);
  });

  it("returns filtered summary", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord({ agent: { agentId: "a1" }, units: 5 }));
    transport.send(fakeRecord({ agent: { agentId: "a2" }, units: 3 }));

    const s = transport.summary({ agentId: "a1" });

    expect(s.totalRecords).toBe(1);
    expect(s.totalUnits).toBe(5);
    expect(s.uniqueAgents).toBe(1);
  });

  it("returns empty summary when no records match", () => {
    const transport = new MemoryTransport();
    transport.send(fakeRecord({ agent: { agentId: "a1" } }));

    const s = transport.summary({ agentId: "nonexistent" });

    expect(s.totalRecords).toBe(0);
    expect(s.totalUnits).toBe(0);
    expect(s.uniqueAgents).toBe(0);
    expect(Object.keys(s.byOperation)).toHaveLength(0);
    expect(Object.keys(s.byAgent)).toHaveLength(0);
  });
});
