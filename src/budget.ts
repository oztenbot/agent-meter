export interface BudgetConfig {
  /** Max spend per service per window. */
  perService?: Record<string, { maxUnits: number; windowMs: number }>;
  /** Global max across all services. */
  global?: { maxUnits: number; windowMs: number };
}

export interface BudgetCheck {
  allowed: boolean;
  remaining: number;
  current: number;
  max: number;
  windowResetsAt: number; // epoch ms
}

interface WindowCounter {
  units: number;
  windowStart: number;
  windowMs: number;
  maxUnits: number;
}

export class BudgetTracker {
  private counters = new Map<string, WindowCounter>();
  private globalCounter: WindowCounter | undefined;

  constructor(private config: BudgetConfig) {
    if (config.global) {
      this.globalCounter = {
        units: 0,
        windowStart: Date.now(),
        windowMs: config.global.windowMs,
        maxUnits: config.global.maxUnits,
      };
    }
  }

  check(serviceId: string, units: number): BudgetCheck {
    const now = Date.now();

    // Check per-service limit first
    const serviceConfig = this.config.perService?.[serviceId];
    if (serviceConfig) {
      const counter = this.getOrCreateCounter(serviceId, serviceConfig, now);
      this.maybeResetWindow(counter, now);
      const afterUnits = counter.units + units;
      if (afterUnits > counter.maxUnits) {
        return {
          allowed: false,
          remaining: Math.max(0, counter.maxUnits - counter.units),
          current: counter.units,
          max: counter.maxUnits,
          windowResetsAt: counter.windowStart + counter.windowMs,
        };
      }
    }

    // Check global limit
    if (this.globalCounter) {
      this.maybeResetWindow(this.globalCounter, now);
      const afterUnits = this.globalCounter.units + units;
      if (afterUnits > this.globalCounter.maxUnits) {
        return {
          allowed: false,
          remaining: Math.max(0, this.globalCounter.maxUnits - this.globalCounter.units),
          current: this.globalCounter.units,
          max: this.globalCounter.maxUnits,
          windowResetsAt: this.globalCounter.windowStart + this.globalCounter.windowMs,
        };
      }
    }

    // Allowed — return remaining based on most constrained limit
    const serviceCounter = serviceConfig
      ? this.getOrCreateCounter(serviceId, serviceConfig, now)
      : undefined;

    let remaining = Infinity;
    let current = 0;
    let max = Infinity;
    let windowResetsAt = Infinity;

    if (serviceCounter) {
      remaining = Math.max(0, serviceCounter.maxUnits - serviceCounter.units - units);
      current = serviceCounter.units;
      max = serviceCounter.maxUnits;
      windowResetsAt = serviceCounter.windowStart + serviceCounter.windowMs;
    }

    if (this.globalCounter) {
      const globalRemaining = Math.max(
        0,
        this.globalCounter.maxUnits - this.globalCounter.units - units,
      );
      if (globalRemaining < remaining) {
        remaining = globalRemaining;
        current = this.globalCounter.units;
        max = this.globalCounter.maxUnits;
        windowResetsAt = this.globalCounter.windowStart + this.globalCounter.windowMs;
      }
    }

    return {
      allowed: true,
      remaining,
      current,
      max,
      windowResetsAt,
    };
  }

  record(serviceId: string, units: number): void {
    const now = Date.now();

    const serviceConfig = this.config.perService?.[serviceId];
    if (serviceConfig) {
      const counter = this.getOrCreateCounter(serviceId, serviceConfig, now);
      this.maybeResetWindow(counter, now);
      counter.units += units;
    }

    if (this.globalCounter) {
      this.maybeResetWindow(this.globalCounter, now);
      this.globalCounter.units += units;
    }
  }

  reset(serviceId?: string): void {
    if (serviceId) {
      this.counters.delete(serviceId);
    } else {
      this.counters.clear();
      if (this.globalCounter) {
        this.globalCounter.units = 0;
        this.globalCounter.windowStart = Date.now();
      }
    }
  }

  private getOrCreateCounter(
    serviceId: string,
    config: { maxUnits: number; windowMs: number },
    now: number,
  ): WindowCounter {
    let counter = this.counters.get(serviceId);
    if (!counter) {
      counter = {
        units: 0,
        windowStart: now,
        windowMs: config.windowMs,
        maxUnits: config.maxUnits,
      };
      this.counters.set(serviceId, counter);
    }
    return counter;
  }

  private maybeResetWindow(counter: WindowCounter, now: number): void {
    if (now >= counter.windowStart + counter.windowMs) {
      counter.units = 0;
      counter.windowStart = now;
    }
  }
}
