export interface AgentIdentity {
  agentId: string;
  name?: string;
  shepherdId?: string;
  tier?: string;
}

export type PricingModel =
  | "per-call"
  | "per-unit"
  | "per-minute"
  | "tiered"
  | "custom";

export interface UsageRecord {
  id: string;
  timestamp: string;
  serviceId: string;
  agent: AgentIdentity;
  operation: string;
  units: number;
  unitType: string;
  pricingModel: PricingModel;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestSignature?: string;
  metadata?: Record<string, unknown>;
}

export interface Transport {
  send(record: UsageRecord): void | Promise<void>;
  flush?(): void | Promise<void>;
}

export interface RouteOptions {
  operation?: string;
  units?: number | ((req: unknown) => number);
  unitType?: string;
  pricing?: PricingModel;
  metadata?: Record<string, unknown>;
  skip?: boolean | ((req: unknown) => boolean);
}

export interface MeterConfig {
  serviceId: string;
  transport?: Transport;
  defaultPricing?: PricingModel;
  identifyAgent?: (req: unknown) => AgentIdentity | undefined;
  signingSecret?: string;
  beforeEmit?: (record: UsageRecord) => UsageRecord | undefined;
  meterErrors?: boolean;
}
