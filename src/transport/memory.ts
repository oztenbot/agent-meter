import type {
  QueryableTransport,
  QueryFilter,
  UsageRecord,
  UsageSummary,
} from "../types.js";

function matchesFilter(record: UsageRecord, filter: QueryFilter): boolean {
  if (filter.agentId && record.agent.agentId !== filter.agentId) return false;
  if (filter.operation && record.operation !== filter.operation) return false;
  if (filter.serviceId && record.serviceId !== filter.serviceId) return false;
  if (filter.pricingModel && record.pricingModel !== filter.pricingModel)
    return false;

  if (filter.from) {
    const from =
      typeof filter.from === "string"
        ? filter.from
        : filter.from.toISOString();
    if (record.timestamp < from) return false;
  }

  if (filter.to) {
    const to =
      typeof filter.to === "string" ? filter.to : filter.to.toISOString();
    if (record.timestamp >= to) return false;
  }

  return true;
}

function buildSummary(records: UsageRecord[]): UsageSummary {
  const byOperation: Record<string, { count: number; units: number }> = {};
  const byAgent: Record<string, { count: number; units: number }> = {};
  const agents = new Set<string>();

  let totalUnits = 0;

  for (const r of records) {
    totalUnits += r.units;
    agents.add(r.agent.agentId);

    const op = byOperation[r.operation] ?? { count: 0, units: 0 };
    op.count++;
    op.units += r.units;
    byOperation[r.operation] = op;

    const ag = byAgent[r.agent.agentId] ?? { count: 0, units: 0 };
    ag.count++;
    ag.units += r.units;
    byAgent[r.agent.agentId] = ag;
  }

  return {
    totalRecords: records.length,
    totalUnits,
    uniqueAgents: agents.size,
    byOperation,
    byAgent,
  };
}

export class MemoryTransport implements QueryableTransport {
  public records: UsageRecord[] = [];

  send(record: UsageRecord): void {
    this.records.push(record);
  }

  flush(): void {
    this.records = [];
  }

  query(filter?: QueryFilter): UsageRecord[] {
    if (!filter) return [...this.records];

    let results = this.records.filter((r) => matchesFilter(r, filter));

    if (filter.offset) {
      results = results.slice(filter.offset);
    }
    if (filter.limit) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  count(filter?: QueryFilter): number {
    if (!filter) return this.records.length;
    return this.records.filter((r) => matchesFilter(r, filter)).length;
  }

  summary(filter?: QueryFilter): UsageSummary {
    const records = filter
      ? this.records.filter((r) => matchesFilter(r, filter))
      : this.records;
    return buildSummary(records);
  }
}
