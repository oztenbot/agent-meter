import type { Transport, UsageRecord } from "../types.js";

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  batchSize?: number;
  flushIntervalMs?: number;
  maxRetries?: number;
  onError?: (error: Error, batch: UsageRecord[]) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpTransport implements Transport {
  private buffer: UsageRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly onError?: (error: Error, batch: UsageRecord[]) => void;

  constructor(options: HttpTransportOptions) {
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.batchSize = options.batchSize ?? 10;
    this.maxRetries = options.maxRetries ?? 3;
    this.onError = options.onError;

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
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await fetch(this.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.headers,
          },
          body: JSON.stringify({ records: batch }),
        });

        if (response.ok) return;

        lastError = new Error(
          `HTTP ${response.status}: ${response.statusText}`
        );
      } catch (err) {
        lastError =
          err instanceof Error ? err : new Error(String(err));
      }

      // Exponential backoff: 100ms, 400ms, 900ms...
      if (attempt < this.maxRetries - 1) {
        await sleep(100 * (attempt + 1) ** 2);
      }
    }

    if (lastError && this.onError) {
      this.onError(lastError, batch);
    }
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
