import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpTransport } from "../../src/transport/http.js";
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

describe("HttpTransport", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a batch when buffer reaches batchSize", async () => {
    const calls: unknown[] = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse((init as { body: string }).body));
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const transport = new HttpTransport({
      url: "https://example.com/ingest",
      batchSize: 2,
    });

    transport.send(fakeRecord({ id: "a" }));
    // Shouldn't flush yet — only 1 record
    expect(calls).toHaveLength(0);

    transport.send(fakeRecord({ id: "b" }));
    // Wait for async flush
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const batch = calls[0] as { records: UsageRecord[] };
    expect(batch.records).toHaveLength(2);
    expect(batch.records[0].id).toBe("a");
    expect(batch.records[1].id).toBe("b");

    transport.destroy();
  });

  it("sends custom headers", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedHeaders = (init as { headers: Record<string, string> }).headers;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const transport = new HttpTransport({
      url: "https://example.com/ingest",
      headers: { Authorization: "Bearer token123" },
      batchSize: 1,
    });

    transport.send(fakeRecord());
    await vi.waitFor(() => expect(capturedHeaders.Authorization).toBe("Bearer token123"));
    expect(capturedHeaders["Content-Type"]).toBe("application/json");

    transport.destroy();
  });

  it("retries on fetch failure", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new Error("Network error");
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const transport = new HttpTransport({
      url: "https://example.com/ingest",
      batchSize: 1,
      maxRetries: 3,
    });

    transport.send(fakeRecord());
    await vi.waitFor(() => expect(attempts).toBe(3), { timeout: 5000 });

    transport.destroy();
  });

  it("retries on non-OK HTTP response", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      if (attempts < 2) return new Response(null, { status: 502, statusText: "Bad Gateway" });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const transport = new HttpTransport({
      url: "https://example.com/ingest",
      batchSize: 1,
      maxRetries: 3,
    });

    transport.send(fakeRecord());
    await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 5000 });

    transport.destroy();
  });

  it("calls onError after all retries exhausted", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Permanent failure");
    }) as typeof fetch;

    let errorCalled = false;
    let capturedError: Error | undefined;
    let capturedBatch: UsageRecord[] | undefined;

    const transport = new HttpTransport({
      url: "https://example.com/ingest",
      batchSize: 1,
      maxRetries: 2,
      onError: (err, batch) => {
        errorCalled = true;
        capturedError = err;
        capturedBatch = batch;
      },
    });

    transport.send(fakeRecord({ id: "failed-rec" }));
    await vi.waitFor(() => expect(errorCalled).toBe(true), { timeout: 5000 });

    expect(capturedError?.message).toBe("Permanent failure");
    expect(capturedBatch).toHaveLength(1);
    expect(capturedBatch![0].id).toBe("failed-rec");

    transport.destroy();
  });

  it("does not call onError on success", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const onError = vi.fn();

    const transport = new HttpTransport({
      url: "https://example.com/ingest",
      batchSize: 1,
      onError,
    });

    transport.send(fakeRecord());
    // Give it time to flush
    await new Promise((r) => setTimeout(r, 100));

    expect(onError).not.toHaveBeenCalled();

    transport.destroy();
  });

  it("flush is a no-op when buffer is empty", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const transport = new HttpTransport({
      url: "https://example.com/ingest",
    });

    await transport.flush();
    expect(globalThis.fetch).not.toHaveBeenCalled();

    transport.destroy();
  });

  it("manual flush sends partial batch", async () => {
    const calls: unknown[] = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse((init as { body: string }).body));
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const transport = new HttpTransport({
      url: "https://example.com/ingest",
      batchSize: 100, // High batch size — won't auto-flush
    });

    transport.send(fakeRecord({ id: "partial" }));
    expect(calls).toHaveLength(0);

    await transport.flush();
    expect(calls).toHaveLength(1);

    const batch = calls[0] as { records: UsageRecord[] };
    expect(batch.records).toHaveLength(1);
    expect(batch.records[0].id).toBe("partial");

    transport.destroy();
  });
});
