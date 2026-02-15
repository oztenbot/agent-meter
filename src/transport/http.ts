import type { Transport, UsageRecord } from "../types.js";

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  batchSize?: number;
  flushIntervalMs?: number;
}

export class HttpTransport implements Transport {
  private buffer: UsageRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly batchSize: number;

  constructor(options: HttpTransportOptions) {
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.batchSize = options.batchSize ?? 10;

    if (options.flushIntervalMs) {
      this.timer = setInterval(() => {
        void this.flush();
      }, options.flushIntervalMs);
      this.timer.unref();
    }
  }

  send(record: UsageRecord): void {
    this.buffer.push(record);
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({ records: batch }),
    });
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
