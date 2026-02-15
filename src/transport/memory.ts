import type { Transport, UsageRecord } from "../types.js";

export class MemoryTransport implements Transport {
  public records: UsageRecord[] = [];

  send(record: UsageRecord): void {
    this.records.push(record);
  }

  flush(): void {
    this.records = [];
  }
}
