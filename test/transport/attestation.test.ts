import { describe, it, expect, vi } from "vitest";
import {
  AttestationTransport,
  buildMerkleRoot,
  buildAttestation,
  verifyAttestation,
} from "../../src/transport/attestation.js";
import { MemoryTransport } from "../../src/transport/memory.js";
import type { UsageRecord } from "../../src/types.js";

const SECRET = "test-secret-key";

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: "rec-1",
    timestamp: "2026-02-23T00:00:00.000Z",
    serviceId: "svc-test",
    agent: { agentId: "agent-abc", name: "TestAgent" },
    operation: "GET /data",
    units: 1,
    unitType: "request",
    pricingModel: "per-call",
    method: "GET",
    path: "/data",
    statusCode: 200,
    durationMs: 42,
    ...overrides,
  };
}

// ─── buildMerkleRoot ──────────────────────────────────────────────────────────

describe("buildMerkleRoot", () => {
  it("returns single leaf unchanged", () => {
    const leaf = "a".repeat(64);
    expect(buildMerkleRoot([leaf])).toBe(leaf);
  });

  it("is deterministic — same inputs produce same root", () => {
    const leaves = ["aaa", "bbb", "ccc"];
    expect(buildMerkleRoot(leaves)).toBe(buildMerkleRoot(leaves));
  });

  it("produces different roots for different leaf orderings", () => {
    const a = buildMerkleRoot(["aaa", "bbb"]);
    const b = buildMerkleRoot(["bbb", "aaa"]);
    expect(a).not.toBe(b);
  });

  it("handles odd number of leaves (duplicates last)", () => {
    // Should not throw
    expect(() => buildMerkleRoot(["a", "b", "c"])).not.toThrow();
  });

  it("throws on empty leaves", () => {
    expect(() => buildMerkleRoot([])).toThrow("empty leaves");
  });
});

// ─── buildAttestation ────────────────────────────────────────────────────────

describe("buildAttestation", () => {
  it("builds attestation with correct shape", () => {
    const records = [makeRecord()];
    const att = buildAttestation(records, "svc-test", SECRET);

    expect(att.serviceId).toBe("svc-test");
    expect(att.recordCount).toBe(1);
    expect(att.records).toEqual(records);
    expect(att.merkleRoot).toHaveLength(64); // hex sha256
    expect(att.signature).toHaveLength(64);
    expect(att.batchId).toHaveLength(32);
    expect(att.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("throws on empty records", () => {
    expect(() => buildAttestation([], "svc", SECRET)).toThrow("empty batch");
  });

  it("produces unique batchIds across calls", () => {
    const records = [makeRecord()];
    const a = buildAttestation(records, "svc", SECRET);
    const b = buildAttestation(records, "svc", SECRET);
    expect(a.batchId).not.toBe(b.batchId);
  });
});

// ─── verifyAttestation ───────────────────────────────────────────────────────

describe("verifyAttestation", () => {
  it("verifies a valid attestation", () => {
    const records = [makeRecord({ id: "r1" }), makeRecord({ id: "r2" })];
    const att = buildAttestation(records, "svc-test", SECRET);
    expect(verifyAttestation(att, SECRET)).toBe(true);
  });

  it("rejects wrong secret", () => {
    const att = buildAttestation([makeRecord()], "svc", SECRET);
    expect(verifyAttestation(att, "wrong-secret")).toBe(false);
  });

  it("rejects tampered record", () => {
    const att = buildAttestation([makeRecord()], "svc", SECRET);
    const tampered = {
      ...att,
      records: [{ ...att.records[0], units: 9999 }],
    };
    expect(verifyAttestation(tampered, SECRET)).toBe(false);
  });

  it("rejects tampered merkleRoot", () => {
    const att = buildAttestation([makeRecord()], "svc", SECRET);
    const tampered = { ...att, merkleRoot: "0".repeat(64) };
    expect(verifyAttestation(tampered, SECRET)).toBe(false);
  });

  it("rejects tampered signature", () => {
    const att = buildAttestation([makeRecord()], "svc", SECRET);
    const tampered = { ...att, signature: "0".repeat(64) };
    expect(verifyAttestation(tampered, SECRET)).toBe(false);
  });

  it("rejects mismatched recordCount", () => {
    const att = buildAttestation([makeRecord()], "svc", SECRET);
    const tampered = { ...att, recordCount: 99 };
    expect(verifyAttestation(tampered, SECRET)).toBe(false);
  });

  it("verifies multi-record batch", () => {
    const records = Array.from({ length: 7 }, (_, i) =>
      makeRecord({ id: `r${i}`, units: i + 1 }),
    );
    const att = buildAttestation(records, "svc", SECRET);
    expect(verifyAttestation(att, SECRET)).toBe(true);
  });
});

// ─── AttestationTransport ────────────────────────────────────────────────────

describe("AttestationTransport", () => {
  it("flushes and calls onAttestation with collected records", async () => {
    const received: ReturnType<typeof buildAttestation>[] = [];
    const transport = new AttestationTransport({
      serviceId: "svc-test",
      secret: SECRET,
      onAttestation: (a) => { received.push(a); },
    });

    transport.send(makeRecord({ id: "r1" }));
    transport.send(makeRecord({ id: "r2" }));
    await transport.flush();

    expect(received).toHaveLength(1);
    expect(received[0].recordCount).toBe(2);
    expect(verifyAttestation(received[0], SECRET)).toBe(true);
  });

  it("auto-flushes when batchSize is reached", async () => {
    const received: ReturnType<typeof buildAttestation>[] = [];
    const transport = new AttestationTransport({
      serviceId: "svc",
      secret: SECRET,
      batchSize: 3,
      onAttestation: (a) => { received.push(a); },
    });

    transport.send(makeRecord({ id: "r1" }));
    transport.send(makeRecord({ id: "r2" }));
    transport.send(makeRecord({ id: "r3" })); // triggers auto-flush

    // give the microtask queue a tick
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0].recordCount).toBe(3);
  });

  it("does nothing on flush when buffer is empty", async () => {
    const onAttestation = vi.fn();
    const transport = new AttestationTransport({
      serviceId: "svc",
      secret: SECRET,
      onAttestation,
    });

    await transport.flush();
    expect(onAttestation).not.toHaveBeenCalled();
  });

  it("clears buffer after flush so records are not double-attested", async () => {
    const received: ReturnType<typeof buildAttestation>[] = [];
    const transport = new AttestationTransport({
      serviceId: "svc",
      secret: SECRET,
      onAttestation: (a) => { received.push(a); },
    });

    transport.send(makeRecord({ id: "r1" }));
    await transport.flush();
    await transport.flush(); // second flush should be no-op

    expect(received).toHaveLength(1);
  });

  it("forwards records to delegate transport", async () => {
    const delegate = new MemoryTransport();
    const transport = new AttestationTransport({
      serviceId: "svc",
      secret: SECRET,
      onAttestation: () => {},
      delegate,
    });

    const r1 = makeRecord({ id: "r1" });
    const r2 = makeRecord({ id: "r2" });
    transport.send(r1);
    transport.send(r2);

    expect(delegate.records).toHaveLength(2);
    expect(delegate.records[0].id).toBe("r1");
  });

  it("produces verifiable attestations for a full batch", async () => {
    const attestations: ReturnType<typeof buildAttestation>[] = [];
    const transport = new AttestationTransport({
      serviceId: "svc",
      secret: SECRET,
      batchSize: 5,
      onAttestation: (a) => { attestations.push(a); },
    });

    for (let i = 0; i < 5; i++) {
      transport.send(makeRecord({ id: `r${i}`, units: i + 1 }));
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(attestations).toHaveLength(1);
    expect(verifyAttestation(attestations[0], SECRET)).toBe(true);
  });
});
