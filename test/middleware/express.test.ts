import { describe, it, expect } from "vitest";
import { agentMeter } from "../../src/middleware/express.js";
import { MemoryTransport } from "../../src/transport/memory.js";

function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    path: "/api/generate",
    headers: { "x-agent-id": "express-agent" },
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

describe("agentMeter express middleware", () => {
  it("creates middleware from config", () => {
    const transport = new MemoryTransport();
    const middleware = agentMeter({ serviceId: "express-svc", transport });

    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    res.emit("finish");

    expect(nextCalled).toBe(true);
    expect(transport.records).toHaveLength(1);
    expect(transport.records[0].serviceId).toBe("express-svc");
    expect(transport.records[0].agent.agentId).toBe("express-agent");
  });

  it("passes route options through", () => {
    const transport = new MemoryTransport();
    const middleware = agentMeter(
      { serviceId: "express-svc", transport },
      { operation: "generate-text", pricing: "per-unit", units: 100, unitType: "token" },
    );

    const req = mockReq();
    const res = mockRes();
    middleware(req, res, () => {});
    res.emit("finish");

    const record = transport.records[0];
    expect(record.operation).toBe("generate-text");
    expect(record.pricingModel).toBe("per-unit");
    expect(record.units).toBe(100);
    expect(record.unitType).toBe("token");
  });
});
