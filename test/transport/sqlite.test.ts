import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteTransport } from "../../src/transport/sqlite.js";
import type { UsageRecord } from "../../src/types.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

function tempDb(): string {
  return join(tmpdir(), `agent-meter-test-${randomBytes(8).toString("hex")}.db`);
}

function fakeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: `rec-${randomBytes(4).toString("hex")}`,
    timestamp: "2026-02-15T12:00:00.000Z",
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

describe("SQLiteTransport", () => {
  let dbPath: string;
  let transport: SQLiteTransport;

  beforeEach(() => {
    dbPath = tempDb();
    transport = new SQLiteTransport({ filename: dbPath });
  });

  afterEach(() => {
    transport.close();
    // Clean up temp files
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = dbPath + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it("creates the database file on construction", () => {
    expect(existsSync(dbPath)).toBe(true);
  });

  it("persists records across instances", () => {
    const record = fakeRecord({ id: "persist-1" });
    transport.send(record);
    transport.close();

    const transport2 = new SQLiteTransport({ filename: dbPath });
    const results = transport2.query();
    transport2.close();

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("persist-1");
  });

  it("stores and retrieves a record with all fields", () => {
    const record = fakeRecord({
      id: "full-record",
      agent: { agentId: "a1", name: "TestBot", shepherdId: "human-1", tier: "premium" },
      requestSignature: "abc123",
      metadata: { version: "v2", tags: ["important"] },
    });
    transport.send(record);

    const results = transport.query();
    expect(results).toHaveLength(1);

    const r = results[0];
    expect(r.id).toBe("full-record");
    expect(r.serviceId).toBe("test-svc");
    expect(r.agent.agentId).toBe("a1");
    expect(r.agent.name).toBe("TestBot");
    expect(r.agent.shepherdId).toBe("human-1");
    expect(r.agent.tier).toBe("premium");
    expect(r.operation).toBe("GET /test");
    expect(r.units).toBe(1);
    expect(r.unitType).toBe("request");
    expect(r.pricingModel).toBe("per-call");
    expect(r.method).toBe("GET");
    expect(r.path).toBe("/test");
    expect(r.statusCode).toBe(200);
    expect(r.durationMs).toBe(42);
    expect(r.requestSignature).toBe("abc123");
    expect(r.metadata).toEqual({ version: "v2", tags: ["important"] });
  });

  it("handles records without optional fields", () => {
    const record = fakeRecord({ id: "minimal" });
    transport.send(record);

    const r = transport.query()[0];
    expect(r.requestSignature).toBeUndefined();
    expect(r.metadata).toBeUndefined();
    expect(r.agent.name).toBeUndefined();
    expect(r.agent.shepherdId).toBeUndefined();
    expect(r.agent.tier).toBeUndefined();
  });

  it("upserts on duplicate id", () => {
    transport.send(fakeRecord({ id: "dup", units: 1 }));
    transport.send(fakeRecord({ id: "dup", units: 5 }));

    expect(transport.count()).toBe(1);
    expect(transport.query()[0].units).toBe(5);
  });

  it("uses custom table name", () => {
    transport.close();
    const customTransport = new SQLiteTransport({
      filename: dbPath,
      tableName: "custom_usage",
    });
    customTransport.send(fakeRecord());
    expect(customTransport.count()).toBe(1);
    customTransport.close();
  });
});

describe("SQLiteTransport.query", () => {
  let dbPath: string;
  let transport: SQLiteTransport;

  beforeEach(() => {
    dbPath = tempDb();
    transport = new SQLiteTransport({ filename: dbPath });
  });

  afterEach(() => {
    transport.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = dbPath + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it("returns all records when no filter", () => {
    transport.send(fakeRecord());
    transport.send(fakeRecord());

    expect(transport.query()).toHaveLength(2);
  });

  it("filters by agentId", () => {
    transport.send(fakeRecord({ agent: { agentId: "a1" } }));
    transport.send(fakeRecord({ agent: { agentId: "a2" } }));
    transport.send(fakeRecord({ agent: { agentId: "a1" } }));

    expect(transport.query({ agentId: "a1" })).toHaveLength(2);
    expect(transport.query({ agentId: "a2" })).toHaveLength(1);
    expect(transport.query({ agentId: "a3" })).toHaveLength(0);
  });

  it("filters by operation", () => {
    transport.send(fakeRecord({ operation: "GET /widgets" }));
    transport.send(fakeRecord({ operation: "POST /widgets" }));

    expect(transport.query({ operation: "GET /widgets" })).toHaveLength(1);
  });

  it("filters by serviceId", () => {
    transport.send(fakeRecord({ serviceId: "svc-a" }));
    transport.send(fakeRecord({ serviceId: "svc-b" }));

    expect(transport.query({ serviceId: "svc-a" })).toHaveLength(1);
  });

  it("filters by pricingModel", () => {
    transport.send(fakeRecord({ pricingModel: "per-call" }));
    transport.send(fakeRecord({ pricingModel: "per-unit" }));

    expect(transport.query({ pricingModel: "per-unit" })).toHaveLength(1);
  });

  it("filters by time range (string)", () => {
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
    transport.send(fakeRecord({ timestamp: "2026-02-14T00:00:00.000Z" }));
    transport.send(fakeRecord({ timestamp: "2026-02-15T12:00:00.000Z" }));

    const results = transport.query({
      from: new Date("2026-02-15T00:00:00.000Z"),
    });
    expect(results).toHaveLength(1);
  });

  it("applies limit", () => {
    for (let i = 0; i < 10; i++) {
      transport.send(fakeRecord());
    }

    expect(transport.query({ limit: 3 })).toHaveLength(3);
  });

  it("applies offset", () => {
    for (let i = 0; i < 5; i++) {
      transport.send(
        fakeRecord({
          id: `rec-${i}`,
          timestamp: `2026-02-15T0${i}:00:00.000Z`,
        })
      );
    }

    const results = transport.query({ offset: 2, limit: 2 });
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("rec-2");
    expect(results[1].id).toBe("rec-3");
  });

  it("combines multiple filters", () => {
    transport.send(fakeRecord({ agent: { agentId: "a1" }, operation: "GET /x" }));
    transport.send(fakeRecord({ agent: { agentId: "a1" }, operation: "POST /x" }));
    transport.send(fakeRecord({ agent: { agentId: "a2" }, operation: "GET /x" }));

    const results = transport.query({ agentId: "a1", operation: "GET /x" });
    expect(results).toHaveLength(1);
  });

  it("orders by timestamp ascending", () => {
    transport.send(fakeRecord({ id: "c", timestamp: "2026-02-16T00:00:00.000Z" }));
    transport.send(fakeRecord({ id: "a", timestamp: "2026-02-14T00:00:00.000Z" }));
    transport.send(fakeRecord({ id: "b", timestamp: "2026-02-15T00:00:00.000Z" }));

    const results = transport.query();
    expect(results[0].id).toBe("a");
    expect(results[1].id).toBe("b");
    expect(results[2].id).toBe("c");
  });
});

describe("SQLiteTransport.count", () => {
  let dbPath: string;
  let transport: SQLiteTransport;

  beforeEach(() => {
    dbPath = tempDb();
    transport = new SQLiteTransport({ filename: dbPath });
  });

  afterEach(() => {
    transport.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = dbPath + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it("returns total count when no filter", () => {
    transport.send(fakeRecord());
    transport.send(fakeRecord());

    expect(transport.count()).toBe(2);
  });

  it("returns filtered count", () => {
    transport.send(fakeRecord({ agent: { agentId: "a1" } }));
    transport.send(fakeRecord({ agent: { agentId: "a2" } }));
    transport.send(fakeRecord({ agent: { agentId: "a1" } }));

    expect(transport.count({ agentId: "a1" })).toBe(2);
  });
});

describe("SQLiteTransport.summary", () => {
  let dbPath: string;
  let transport: SQLiteTransport;

  beforeEach(() => {
    dbPath = tempDb();
    transport = new SQLiteTransport({ filename: dbPath });
  });

  afterEach(() => {
    transport.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = dbPath + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it("returns full summary", () => {
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
    transport.send(fakeRecord({ agent: { agentId: "a1" }, units: 5 }));
    transport.send(fakeRecord({ agent: { agentId: "a2" }, units: 3 }));

    const s = transport.summary({ agentId: "a1" });

    expect(s.totalRecords).toBe(1);
    expect(s.totalUnits).toBe(5);
    expect(s.uniqueAgents).toBe(1);
  });

  it("returns empty summary when no records match", () => {
    transport.send(fakeRecord({ agent: { agentId: "a1" } }));

    const s = transport.summary({ agentId: "nonexistent" });

    expect(s.totalRecords).toBe(0);
    expect(s.totalUnits).toBe(0);
    expect(s.uniqueAgents).toBe(0);
    expect(Object.keys(s.byOperation)).toHaveLength(0);
    expect(Object.keys(s.byAgent)).toHaveLength(0);
  });
});
