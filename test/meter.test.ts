import { describe, it, expect } from "vitest";
import { AgentMeter } from "../src/meter.js";
import { MemoryTransport } from "../src/transport/memory.js";

function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    method: "GET",
    path: "/api/widgets",
    headers: { "x-agent-id": "agent-123" },
    ...overrides,
  };
}

function mockRes(statusCode = 200) {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    statusCode,
    on(event: string, fn: () => void) {
      (listeners[event] ??= []).push(fn);
    },
    emit(event: string) {
      listeners[event]?.forEach((fn) => fn());
    },
  };
}

describe("AgentMeter", () => {
  it("records a usage event on response finish", () => {
    const transport = new MemoryTransport();
    const meter = new AgentMeter({ serviceId: "test-svc", transport });

    const req = mockReq();
    const res = mockRes();
    meter.record(req, res);
    res.emit("finish");

    expect(transport.records).toHaveLength(1);
    const record = transport.records[0];
    expect(record.serviceId).toBe("test-svc");
    expect(record.agent.agentId).toBe("agent-123");
    expect(record.method).toBe("GET");
    expect(record.path).toBe("/api/widgets");
    expect(record.statusCode).toBe(200);
    expect(record.pricingModel).toBe("per-call");
    expect(record.units).toBe(1);
    expect(record.unitType).toBe("request");
    expect(record.id).toHaveLength(32);
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("skips requests without agent identity", () => {
    const transport = new MemoryTransport();
    const meter = new AgentMeter({ serviceId: "test-svc", transport });

    const req = mockReq({ headers: {} });
    const res = mockRes();
    meter.record(req, res);
    res.emit("finish");

    expect(transport.records).toHaveLength(0);
  });

  it("skips error responses by default", () => {
    const transport = new MemoryTransport();
    const meter = new AgentMeter({ serviceId: "test-svc", transport });

    const req = mockReq();
    const res = mockRes(500);
    meter.record(req, res);
    res.emit("finish");

    expect(transport.records).toHaveLength(0);
  });

  it("meters error responses when meterErrors is true", () => {
    const transport = new MemoryTransport();
    const meter = new AgentMeter({
      serviceId: "test-svc",
      transport,
      meterErrors: true,
    });

    const req = mockReq();
    const res = mockRes(500);
    meter.record(req, res);
    res.emit("finish");

    expect(transport.records).toHaveLength(1);
  });

  it("uses custom identifyAgent function", () => {
    const transport = new MemoryTransport();
    const meter = new AgentMeter({
      serviceId: "test-svc",
      transport,
      identifyAgent: (req: unknown) => {
        const r = req as { headers: Record<string, string> };
        return { agentId: r.headers["authorization"], name: "custom-agent" };
      },
    });

    const req = mockReq({ headers: { authorization: "bot-456" } });
    const res = mockRes();
    meter.record(req, res);
    res.emit("finish");

    expect(transport.records[0].agent.agentId).toBe("bot-456");
    expect(transport.records[0].agent.name).toBe("custom-agent");
  });

  it("applies route options", () => {
    const transport = new MemoryTransport();
    const meter = new AgentMeter({ serviceId: "test-svc", transport });

    const req = mockReq();
    const res = mockRes();
    meter.record(req, res, {
      operation: "list-widgets",
      units: 5,
      unitType: "token",
      pricing: "per-unit",
      metadata: { version: "v2" },
    });
    res.emit("finish");

    const record = transport.records[0];
    expect(record.operation).toBe("list-widgets");
    expect(record.units).toBe(5);
    expect(record.unitType).toBe("token");
    expect(record.pricingModel).toBe("per-unit");
    expect(record.metadata).toEqual({ version: "v2" });
  });

  it("supports units as a function", () => {
    const transport = new MemoryTransport();
    const meter = new AgentMeter({ serviceId: "test-svc", transport });

    const req = mockReq({ body: { items: [1, 2, 3] } });
    const res = mockRes();
    meter.record(req, res, {
      units: (r: unknown) => (r as { body: { items: number[] } }).body.items.length,
    });
    res.emit("finish");

    expect(transport.records[0].units).toBe(3);
  });

  it("skips when route skip is true", () => {
    const transport = new MemoryTransport();
    const meter = new AgentMeter({ serviceId: "test-svc", transport });

    const req = mockReq();
    const res = mockRes();
    meter.record(req, res, { skip: true });
    res.emit("finish");

    expect(transport.records).toHaveLength(0);
  });

  it("skips when route skip function returns true", () => {
    const transport = new MemoryTransport();
    const meter = new AgentMeter({ serviceId: "test-svc", transport });

    const req = mockReq({ path: "/health" });
    const res = mockRes();
    meter.record(req, res, {
      skip: (r: unknown) => (r as { path: string }).path === "/health",
    });
    res.emit("finish");

    expect(transport.records).toHaveLength(0);
  });

  it("applies beforeEmit hook", () => {
    const transport = new MemoryTransport();
    const meter = new AgentMeter({
      serviceId: "test-svc",
      transport,
      beforeEmit: (record) => ({ ...record, metadata: { enriched: true } }),
    });

    const req = mockReq();
    const res = mockRes();
    meter.record(req, res);
    res.emit("finish");

    expect(transport.records[0].metadata).toEqual({ enriched: true });
  });

  it("drops record when beforeEmit returns undefined", () => {
    const transport = new MemoryTransport();
    const meter = new AgentMeter({
      serviceId: "test-svc",
      transport,
      beforeEmit: () => undefined,
    });

    const req = mockReq();
    const res = mockRes();
    meter.record(req, res);
    res.emit("finish");

    expect(transport.records).toHaveLength(0);
  });

  it("express() returns working middleware", () => {
    const transport = new MemoryTransport();
    const meter = new AgentMeter({ serviceId: "test-svc", transport });
    const middleware = meter.express();

    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    res.emit("finish");

    expect(nextCalled).toBe(true);
    expect(transport.records).toHaveLength(1);
  });

  it("uses defaultPricing from config", () => {
    const transport = new MemoryTransport();
    const meter = new AgentMeter({
      serviceId: "test-svc",
      transport,
      defaultPricing: "per-minute",
    });

    const req = mockReq();
    const res = mockRes();
    meter.record(req, res);
    res.emit("finish");

    expect(transport.records[0].pricingModel).toBe("per-minute");
  });
});
