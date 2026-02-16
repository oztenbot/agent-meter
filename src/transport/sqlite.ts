import type {
  QueryableTransport,
  QueryFilter,
  UsageRecord,
  UsageSummary,
} from "../types.js";

// Re-export for convenience when using the sqlite subpath
export type { QueryableTransport, QueryFilter, UsageRecord, UsageSummary };

export interface SQLiteTransportOptions {
  filename: string;
  tableName?: string;
}

interface DatabaseBinding {
  pragma(sql: string): void;
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): void;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

const COLUMNS = [
  "id",
  "timestamp",
  "service_id",
  "agent_id",
  "agent_name",
  "shepherd_id",
  "agent_tier",
  "operation",
  "units",
  "unit_type",
  "pricing_model",
  "method",
  "path",
  "status_code",
  "duration_ms",
  "request_signature",
  "metadata",
] as const;

function toRow(record: UsageRecord): unknown[] {
  return [
    record.id,
    record.timestamp,
    record.serviceId,
    record.agent.agentId,
    record.agent.name ?? null,
    record.agent.shepherdId ?? null,
    record.agent.tier ?? null,
    record.operation,
    record.units,
    record.unitType,
    record.pricingModel,
    record.method,
    record.path,
    record.statusCode,
    record.durationMs,
    record.requestSignature ?? null,
    record.metadata ? JSON.stringify(record.metadata) : null,
  ];
}

function fromRow(row: Record<string, unknown>): UsageRecord {
  return {
    id: row.id as string,
    timestamp: row.timestamp as string,
    serviceId: row.service_id as string,
    agent: {
      agentId: row.agent_id as string,
      ...(row.agent_name ? { name: row.agent_name as string } : {}),
      ...(row.shepherd_id ? { shepherdId: row.shepherd_id as string } : {}),
      ...(row.agent_tier ? { tier: row.agent_tier as string } : {}),
    },
    operation: row.operation as string,
    units: row.units as number,
    unitType: row.unit_type as string,
    pricingModel: row.pricing_model as UsageRecord["pricingModel"],
    method: row.method as string,
    path: row.path as string,
    statusCode: row.status_code as number,
    durationMs: row.duration_ms as number,
    ...(row.request_signature
      ? { requestSignature: row.request_signature as string }
      : {}),
    ...(row.metadata
      ? { metadata: JSON.parse(row.metadata as string) }
      : {}),
  };
}

interface WhereClause {
  conditions: string[];
  params: unknown[];
}

function buildWhere(filter: QueryFilter | undefined): WhereClause {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!filter) return { conditions, params };

  if (filter.agentId) {
    conditions.push("agent_id = ?");
    params.push(filter.agentId);
  }
  if (filter.operation) {
    conditions.push("operation = ?");
    params.push(filter.operation);
  }
  if (filter.serviceId) {
    conditions.push("service_id = ?");
    params.push(filter.serviceId);
  }
  if (filter.pricingModel) {
    conditions.push("pricing_model = ?");
    params.push(filter.pricingModel);
  }
  if (filter.from) {
    const from =
      typeof filter.from === "string"
        ? filter.from
        : filter.from.toISOString();
    conditions.push("timestamp >= ?");
    params.push(from);
  }
  if (filter.to) {
    const to =
      typeof filter.to === "string" ? filter.to : filter.to.toISOString();
    conditions.push("timestamp < ?");
    params.push(to);
  }

  return { conditions, params };
}

export class SQLiteTransport implements QueryableTransport {
  private db: DatabaseBinding;
  private readonly table: string;
  private readonly insertStmt: ReturnType<DatabaseBinding["prepare"]>;

  constructor(options: SQLiteTransportOptions) {
    this.table = options.tableName ?? "usage_records";

    // Dynamic import of better-sqlite3
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    this.db = new Database(options.filename) as DatabaseBinding;

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        service_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT,
        shepherd_id TEXT,
        agent_tier TEXT,
        operation TEXT NOT NULL,
        units REAL NOT NULL,
        unit_type TEXT NOT NULL,
        pricing_model TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        duration_ms REAL NOT NULL,
        request_signature TEXT,
        metadata TEXT
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.table}_agent_id ON ${this.table}(agent_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.table}_timestamp ON ${this.table}(timestamp)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.table}_operation ON ${this.table}(operation)
    `);

    const placeholders = COLUMNS.map(() => "?").join(", ");
    this.insertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO ${this.table} (${COLUMNS.join(", ")}) VALUES (${placeholders})`
    );
  }

  send(record: UsageRecord): void {
    this.insertStmt.run(...toRow(record));
  }

  flush(): void {
    // No-op for SQLite — records are already persisted on send
  }

  query(filter?: QueryFilter): UsageRecord[] {
    const { conditions, params } = buildWhere(filter);

    let sql = `SELECT * FROM ${this.table}`;
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY timestamp ASC";

    if (filter?.limit) {
      sql += ` LIMIT ?`;
      params.push(filter.limit);
    }
    if (filter?.offset) {
      sql += ` OFFSET ?`;
      params.push(filter.offset);
    }

    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => fromRow(row as Record<string, unknown>));
  }

  count(filter?: QueryFilter): number {
    const { conditions, params } = buildWhere(filter);

    let sql = `SELECT COUNT(*) as cnt FROM ${this.table}`;
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }

    const row = this.db.prepare(sql).get(...params) as { cnt: number };
    return row.cnt;
  }

  summary(filter?: QueryFilter): UsageSummary {
    const { conditions, params } = buildWhere(filter);
    const where =
      conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

    // Overall totals
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) as total_records, COALESCE(SUM(units), 0) as total_units, COUNT(DISTINCT agent_id) as unique_agents FROM ${this.table}${where}`
      )
      .get(...params) as {
      total_records: number;
      total_units: number;
      unique_agents: number;
    };

    // By operation
    const opRows = this.db
      .prepare(
        `SELECT operation, COUNT(*) as cnt, SUM(units) as total_units FROM ${this.table}${where} GROUP BY operation`
      )
      .all(...params) as { operation: string; cnt: number; total_units: number }[];

    const byOperation: Record<string, { count: number; units: number }> = {};
    for (const row of opRows) {
      byOperation[row.operation] = { count: row.cnt, units: row.total_units };
    }

    // By agent
    const agentRows = this.db
      .prepare(
        `SELECT agent_id, COUNT(*) as cnt, SUM(units) as total_units FROM ${this.table}${where} GROUP BY agent_id`
      )
      .all(...params) as { agent_id: string; cnt: number; total_units: number }[];

    const byAgent: Record<string, { count: number; units: number }> = {};
    for (const row of agentRows) {
      byAgent[row.agent_id] = { count: row.cnt, units: row.total_units };
    }

    return {
      totalRecords: totals.total_records,
      totalUnits: totals.total_units,
      uniqueAgents: totals.unique_agents,
      byOperation,
      byAgent,
    };
  }

  close(): void {
    this.db.close();
  }
}
