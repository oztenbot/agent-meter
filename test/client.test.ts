import { describe, it, expect } from "vitest";
import { AgentClient } from "../src/client.js";
import { MemoryTransport } from "../src/transport/memory.js";
import { verifySignature } from "../src/signing.js";

const agent = { agentId: "bot-42", name: "test-bot" };

describe("AgentClient", () => {
  describe("budget checking", () => {
    it("allows calls when no budget configured", () => {
      const client = new AgentClient({ agent });
      const result = client.checkBudget("svc-a", 999);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(Infinity);
    });

    it("enforces per-service budgets", () => {
      const client = new AgentClient({
        agent,
        budget: {
          perService: { "svc-a": { maxUnits: 10, windowMs: 60_000 } },
        },
      });

      // Use up budget via recordUsage
      client.recordUsage({
        serviceId: "svc-a",
        operation: "call",
        units: 8,
        unitType: "request",
        pricingModel: "per-call",
        method: "GET",
        path: "/api",
        statusCode: 200,
        durationMs: 50,
      });

      const result = client.checkBudget("svc-a", 5);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(2);
    });

    it("fires onBudgetExceeded callback", () => {
      const exceeded: Array<{ serviceId: string; current: number; max: number }> = [];
      const client = new AgentClient({
        agent,
        budget: {
          perService: { "svc-a": { maxUnits: 5, windowMs: 60_000 } },
        },
        onBudgetExceeded: (serviceId, current, max) => {
          exceeded.push({ serviceId, current, max });
        },
      });

      client.recordUsage({
        serviceId: "svc-a",
        operation: "call",
        units: 5,
        unitType: "request",
        pricingModel: "per-call",
        method: "GET",
        path: "/",
        statusCode: 200,
        durationMs: 10,
      });

      client.checkBudget("svc-a", 1);
      expect(exceeded).toHaveLength(1);
      expect(exceeded[0]).toEqual({ serviceId: "svc-a", current: 5, max: 5 });
    });
  });

  describe("recordUsage", () => {
    it("records usage to transport with agent identity", () => {
      const transport = new MemoryTransport();
      const client = new AgentClient({ agent, transport });

      client.recordUsage({
        serviceId: "svc-a",
        operation: "GET /widgets",
        units: 3,
        unitType: "request",
        pricingModel: "per-call",
        method: "GET",
        path: "/widgets",
        statusCode: 200,
        durationMs: 120,
      });

      expect(transport.records).toHaveLength(1);
      const record = transport.records[0];
      expect(record.agent.agentId).toBe("bot-42");
      expect(record.agent.name).toBe("test-bot");
      expect(record.serviceId).toBe("svc-a");
      expect(record.units).toBe(3);
      expect(record.id).toHaveLength(32);
      expect(record.timestamp).toBeTruthy();
    });

    it("updates budget tracker on record", () => {
      const transport = new MemoryTransport();
      const client = new AgentClient({
        agent,
        transport,
        budget: {
          perService: { "svc-a": { maxUnits: 10, windowMs: 60_000 } },
        },
      });

      client.recordUsage({
        serviceId: "svc-a",
        operation: "call",
        units: 7,
        unitType: "request",
        pricingModel: "per-call",
        method: "GET",
        path: "/",
        statusCode: 200,
        durationMs: 10,
      });

      const check = client.checkBudget("svc-a", 1);
      expect(check.allowed).toBe(true);
      expect(check.remaining).toBe(2); // 10 - 7 - 1 = 2
    });
  });

  describe("summary", () => {
    it("returns usage summary from queryable transport", () => {
      const transport = new MemoryTransport();
      const client = new AgentClient({ agent, transport });

      client.recordUsage({
        serviceId: "svc-a",
        operation: "GET /a",
        units: 5,
        unitType: "request",
        pricingModel: "per-call",
        method: "GET",
        path: "/a",
        statusCode: 200,
        durationMs: 10,
      });

      client.recordUsage({
        serviceId: "svc-b",
        operation: "POST /b",
        units: 3,
        unitType: "token",
        pricingModel: "per-unit",
        method: "POST",
        path: "/b",
        statusCode: 201,
        durationMs: 20,
      });

      const summary = client.summary();
      expect(summary).toEqual({
        totalRecords: 2,
        totalUnits: 8,
        uniqueAgents: 1,
        byOperation: {
          "GET /a": { count: 1, units: 5 },
          "POST /b": { count: 1, units: 3 },
        },
        byAgent: {
          "bot-42": { count: 2, units: 8 },
        },
      });
    });

    it("throws if transport is not queryable", () => {
      const nonQueryable = { send: () => {} };
      const client = new AgentClient({ agent, transport: nonQueryable });

      expect(() => client.summary()).toThrow("Transport does not support queries");
    });
  });

  describe("signRequest", () => {
    it("returns agent identity headers without signing secret", () => {
      const client = new AgentClient({ agent });
      const headers = client.signRequest('{"foo":"bar"}');

      expect(headers["x-agent-id"]).toBe("bot-42");
      expect(headers["x-agent-name"]).toBe("test-bot");
      expect(headers["x-agent-signature"]).toBeUndefined();
    });

    it("includes HMAC signature when signing secret is set", () => {
      const secret = "test-secret-key";
      const client = new AgentClient({ agent, signingSecret: secret });
      const body = '{"data":"value"}';
      const headers = client.signRequest(body);

      expect(headers["x-agent-id"]).toBe("bot-42");
      expect(headers["x-agent-signature"]).toBeTruthy();
      expect(headers["x-agent-signature"]).toHaveLength(64); // SHA-256 hex

      // Verify the signature is valid
      expect(
        verifySignature(body, headers["x-agent-signature"], secret),
      ).toBe(true);
    });

    it("omits name header when agent has no name", () => {
      const client = new AgentClient({
        agent: { agentId: "anon-bot" },
      });
      const headers = client.signRequest("body");

      expect(headers["x-agent-id"]).toBe("anon-bot");
      expect(headers["x-agent-name"]).toBeUndefined();
    });
  });

  describe("flush", () => {
    it("flushes the transport", async () => {
      const transport = new MemoryTransport();
      const client = new AgentClient({ agent, transport });

      client.recordUsage({
        serviceId: "svc-a",
        operation: "call",
        units: 1,
        unitType: "request",
        pricingModel: "per-call",
        method: "GET",
        path: "/",
        statusCode: 200,
        durationMs: 10,
      });

      expect(transport.records).toHaveLength(1);
      await client.flush();
      expect(transport.records).toHaveLength(0);
    });
  });

  describe("getTransport", () => {
    it("returns the underlying transport", () => {
      const transport = new MemoryTransport();
      const client = new AgentClient({ agent, transport });
      expect(client.getTransport()).toBe(transport);
    });

    it("creates default MemoryTransport if none provided", () => {
      const client = new AgentClient({ agent });
      expect(client.getTransport()).toBeDefined();
    });
  });
});
