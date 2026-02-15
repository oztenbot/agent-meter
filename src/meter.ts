import type {
  AgentIdentity,
  MeterConfig,
  RouteOptions,
  Transport,
  UsageRecord,
} from "./types.js";
import { MemoryTransport } from "./transport/memory.js";
import { verifySignature } from "./signing.js";
import { generateId, timestamp } from "./utils.js";

export interface IncomingRequest {
  method?: string;
  path?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface OutgoingResponse {
  statusCode?: number;
  on?(event: string, listener: () => void): void;
}

function defaultIdentifyAgent(req: IncomingRequest): AgentIdentity | undefined {
  const header = req.headers?.["x-agent-id"];
  const agentId = Array.isArray(header) ? header[0] : header;
  if (!agentId) return undefined;

  const name = req.headers?.["x-agent-name"];

  return {
    agentId,
    name: Array.isArray(name) ? name[0] : name,
  };
}

export class AgentMeter {
  private readonly config: MeterConfig;
  private readonly transport: Transport;

  constructor(config: MeterConfig) {
    this.config = config;
    this.transport = config.transport ?? new MemoryTransport();
  }

  record(
    req: IncomingRequest,
    res: OutgoingResponse,
    options?: RouteOptions,
  ): void {
    const start = Date.now();

    const finish = () => {
      const durationMs = Date.now() - start;

      if (options?.skip === true) return;
      if (typeof options?.skip === "function" && options.skip(req)) return;

      const statusCode = res.statusCode ?? 0;
      if (!this.config.meterErrors && statusCode >= 400) return;

      const identify = this.config.identifyAgent ?? defaultIdentifyAgent;
      const agent = identify(req);
      if (!agent) return;

      const signatureHeader = req.headers?.["x-agent-signature"];
      const requestSignature = Array.isArray(signatureHeader)
        ? signatureHeader[0]
        : signatureHeader;

      if (this.config.signingSecret && requestSignature) {
        const body =
          typeof req.body === "string"
            ? req.body
            : JSON.stringify(req.body ?? "");
        if (!verifySignature(body, requestSignature, this.config.signingSecret)) {
          return;
        }
      }

      const units =
        typeof options?.units === "function"
          ? options.units(req)
          : (options?.units ?? 1);

      let usageRecord: UsageRecord | undefined = {
        id: generateId(),
        timestamp: timestamp(),
        serviceId: this.config.serviceId,
        agent,
        operation: options?.operation ?? `${req.method} ${req.path ?? req.url}`,
        units,
        unitType: options?.unitType ?? "request",
        pricingModel:
          options?.pricing ?? this.config.defaultPricing ?? "per-call",
        method: req.method ?? "UNKNOWN",
        path: req.path ?? req.url ?? "/",
        statusCode,
        durationMs,
        requestSignature,
        metadata: options?.metadata,
      };

      if (this.config.beforeEmit) {
        usageRecord = this.config.beforeEmit(usageRecord);
        if (!usageRecord) return;
      }

      void this.transport.send(usageRecord);
    };

    if (res.on) {
      res.on("finish", finish);
    } else {
      finish();
    }
  }

  express(options?: RouteOptions) {
    return (req: IncomingRequest, res: OutgoingResponse, next: () => void) => {
      this.record(req, res, options);
      next();
    };
  }

  getTransport(): Transport {
    return this.transport;
  }

  async flush(): Promise<void> {
    await this.transport.flush?.();
  }
}
