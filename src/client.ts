import type {
  AgentIdentity,
  QueryFilter,
  QueryableTransport,
  Transport,
  UsageRecord,
  UsageSummary,
} from "./types.js";
import type { BudgetCheck, BudgetConfig } from "./budget.js";
import { BudgetTracker } from "./budget.js";
import { MemoryTransport } from "./transport/memory.js";
import { signPayload } from "./signing.js";
import { generateId, timestamp } from "./utils.js";

export type { BudgetConfig, BudgetCheck } from "./budget.js";

export interface AgentClientConfig {
  agent: AgentIdentity;
  /** HMAC key for request signing. */
  signingSecret?: string;
  /** Optional budget enforcement. */
  budget?: BudgetConfig;
  /** Where to log client-side records. */
  transport?: Transport;
  /** Called when a budget check fails. */
  onBudgetExceeded?: (serviceId: string, current: number, max: number) => void;
}

export class AgentClient {
  private readonly agent: AgentIdentity;
  private readonly transport: Transport;
  private readonly budgetTracker: BudgetTracker | undefined;
  private readonly signingSecret: string | undefined;
  private readonly onBudgetExceeded:
    | ((serviceId: string, current: number, max: number) => void)
    | undefined;

  constructor(config: AgentClientConfig) {
    this.agent = config.agent;
    this.transport = config.transport ?? new MemoryTransport();
    this.signingSecret = config.signingSecret;
    this.onBudgetExceeded = config.onBudgetExceeded;

    if (config.budget) {
      this.budgetTracker = new BudgetTracker(config.budget);
    }
  }

  /** Check if a call is within budget. */
  checkBudget(serviceId: string, units = 1): BudgetCheck {
    if (!this.budgetTracker) {
      return {
        allowed: true,
        remaining: Infinity,
        current: 0,
        max: Infinity,
        windowResetsAt: Infinity,
      };
    }
    const result = this.budgetTracker.check(serviceId, units);
    if (!result.allowed && this.onBudgetExceeded) {
      this.onBudgetExceeded(serviceId, result.current, result.max);
    }
    return result;
  }

  /** Record a completed call (agent-side logging). */
  recordUsage(
    record: Omit<UsageRecord, "id" | "timestamp" | "agent">,
  ): void {
    const full: UsageRecord = {
      id: generateId(),
      timestamp: timestamp(),
      agent: this.agent,
      ...record,
    };

    void this.transport.send(full);

    if (this.budgetTracker) {
      this.budgetTracker.record(record.serviceId, record.units);
    }
  }

  /** Get agent's own usage summary, optionally filtered. */
  summary(filter?: QueryFilter): UsageSummary | Promise<UsageSummary> {
    const transport = this.transport as QueryableTransport;
    if (typeof transport.summary !== "function") {
      throw new Error(
        "Transport does not support queries. Use a QueryableTransport (e.g. MemoryTransport).",
      );
    }
    return transport.summary({ ...filter, agentId: this.agent.agentId });
  }

  /** Sign an outgoing request body (returns headers to attach). */
  signRequest(body: string): Record<string, string> {
    const headers: Record<string, string> = {
      "x-agent-id": this.agent.agentId,
    };
    if (this.agent.name) {
      headers["x-agent-name"] = this.agent.name;
    }
    if (this.signingSecret) {
      headers["x-agent-signature"] = signPayload(body, this.signingSecret);
    }
    return headers;
  }

  /** Flush local transport. */
  async flush(): Promise<void> {
    await this.transport.flush?.();
  }

  /** Get the underlying transport. */
  getTransport(): Transport {
    return this.transport;
  }
}
