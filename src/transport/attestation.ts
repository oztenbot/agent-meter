import { createHash, createHmac } from "node:crypto";
import type {
  Attestation,
  AttestationTransportOptions,
  Transport,
  UsageRecord,
} from "../types.js";
import { generateId, timestamp } from "../utils.js";

function hashRecord(record: UsageRecord, secret: string): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(record))
    .digest("hex");
}

function hashPair(left: string, right: string): string {
  return createHash("sha256").update(left + right).digest("hex");
}

export function buildMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) throw new Error("Cannot build Merkle root from empty leaves");
  if (leaves.length === 1) return leaves[0];

  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left; // duplicate last leaf if odd count
      next.push(hashPair(left, right));
    }
    level = next;
  }
  return level[0];
}

export function buildAttestation(
  records: UsageRecord[],
  serviceId: string,
  secret: string,
): Attestation {
  if (records.length === 0) throw new Error("Cannot attest empty batch");

  const batchId = generateId();
  const ts = timestamp();
  const leaves = records.map((r) => hashRecord(r, secret));
  const merkleRoot = buildMerkleRoot(leaves);
  const sigPayload = `${batchId}:${ts}:${merkleRoot}`;
  const signature = createHmac("sha256", secret).update(sigPayload).digest("hex");

  return {
    batchId,
    timestamp: ts,
    serviceId,
    recordCount: records.length,
    merkleRoot,
    signature,
    records,
  };
}

export function verifyAttestation(attestation: Attestation, secret: string): boolean {
  // 1. Verify record count matches
  if (attestation.records.length !== attestation.recordCount) return false;

  // 2. Rebuild Merkle root from records
  const leaves = attestation.records.map((r) => hashRecord(r, secret));
  let computedRoot: string;
  try {
    computedRoot = buildMerkleRoot(leaves);
  } catch {
    return false;
  }
  if (computedRoot !== attestation.merkleRoot) return false;

  // 3. Verify signature over (batchId:timestamp:merkleRoot)
  const sigPayload = `${attestation.batchId}:${attestation.timestamp}:${attestation.merkleRoot}`;
  const expectedSig = createHmac("sha256", secret).update(sigPayload).digest("hex");
  return expectedSig === attestation.signature;
}

export class AttestationTransport implements Transport {
  private buffer: UsageRecord[] = [];
  private readonly serviceId: string;
  private readonly secret: string;
  private readonly batchSize: number;
  private readonly onAttestation: (a: Attestation) => void | Promise<void>;
  private readonly delegate?: Transport;

  constructor(options: AttestationTransportOptions) {
    this.serviceId = options.serviceId;
    this.secret = options.secret;
    this.batchSize = options.batchSize ?? 10;
    this.onAttestation = options.onAttestation;
    this.delegate = options.delegate;
  }

  send(record: UsageRecord): void {
    this.buffer.push(record);
    this.delegate?.send(record);
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    const attestation = buildAttestation(batch, this.serviceId, this.secret);
    await this.onAttestation(attestation);
    await this.delegate?.flush?.();
  }
}
