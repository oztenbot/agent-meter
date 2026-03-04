import { describe, it, expect, vi, afterEach } from "vitest";
import { BudgetTracker } from "../src/budget.js";

describe("BudgetTracker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("per-service limits", () => {
    it("allows calls within budget", () => {
      const tracker = new BudgetTracker({
        perService: { "svc-a": { maxUnits: 100, windowMs: 60_000 } },
      });

      const result = tracker.check("svc-a", 10);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(90);
      expect(result.max).toBe(100);
    });

    it("blocks calls exceeding budget", () => {
      const tracker = new BudgetTracker({
        perService: { "svc-a": { maxUnits: 10, windowMs: 60_000 } },
      });

      tracker.record("svc-a", 8);
      const result = tracker.check("svc-a", 5);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(2);
      expect(result.current).toBe(8);
      expect(result.max).toBe(10);
    });

    it("blocks calls that exactly exceed budget", () => {
      const tracker = new BudgetTracker({
        perService: { "svc-a": { maxUnits: 10, windowMs: 60_000 } },
      });

      tracker.record("svc-a", 10);
      const result = tracker.check("svc-a", 1);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("allows calls that exactly fit budget", () => {
      const tracker = new BudgetTracker({
        perService: { "svc-a": { maxUnits: 10, windowMs: 60_000 } },
      });

      tracker.record("svc-a", 5);
      const result = tracker.check("svc-a", 5);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it("tracks services independently", () => {
      const tracker = new BudgetTracker({
        perService: {
          "svc-a": { maxUnits: 10, windowMs: 60_000 },
          "svc-b": { maxUnits: 20, windowMs: 60_000 },
        },
      });

      tracker.record("svc-a", 10);

      const resultA = tracker.check("svc-a", 1);
      expect(resultA.allowed).toBe(false);

      const resultB = tracker.check("svc-b", 15);
      expect(resultB.allowed).toBe(true);
      expect(resultB.remaining).toBe(5);
    });

    it("allows unconfigured services without limit", () => {
      const tracker = new BudgetTracker({
        perService: { "svc-a": { maxUnits: 10, windowMs: 60_000 } },
      });

      const result = tracker.check("svc-unknown", 1000);
      expect(result.allowed).toBe(true);
    });
  });

  describe("global limits", () => {
    it("enforces global cap across services", () => {
      const tracker = new BudgetTracker({
        global: { maxUnits: 50, windowMs: 60_000 },
      });

      tracker.record("svc-a", 30);
      tracker.record("svc-b", 15);

      const result = tracker.check("svc-c", 10);
      expect(result.allowed).toBe(false);
      expect(result.current).toBe(45);
      expect(result.max).toBe(50);
    });

    it("allows calls within global budget", () => {
      const tracker = new BudgetTracker({
        global: { maxUnits: 100, windowMs: 60_000 },
      });

      tracker.record("svc-a", 40);
      const result = tracker.check("svc-b", 30);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(30);
    });
  });

  describe("combined per-service + global", () => {
    it("blocks on per-service even if global allows", () => {
      const tracker = new BudgetTracker({
        perService: { "svc-a": { maxUnits: 10, windowMs: 60_000 } },
        global: { maxUnits: 1000, windowMs: 60_000 },
      });

      tracker.record("svc-a", 10);
      const result = tracker.check("svc-a", 1);
      expect(result.allowed).toBe(false);
      expect(result.max).toBe(10); // per-service limit, not global
    });

    it("blocks on global even if per-service allows", () => {
      const tracker = new BudgetTracker({
        perService: { "svc-a": { maxUnits: 100, windowMs: 60_000 } },
        global: { maxUnits: 20, windowMs: 60_000 },
      });

      tracker.record("svc-a", 20);
      const result = tracker.check("svc-a", 1);
      expect(result.allowed).toBe(false);
      expect(result.max).toBe(20); // global limit
    });

    it("returns most constrained remaining when allowed", () => {
      const tracker = new BudgetTracker({
        perService: { "svc-a": { maxUnits: 15, windowMs: 60_000 } },
        global: { maxUnits: 100, windowMs: 60_000 },
      });

      tracker.record("svc-a", 10);
      const result = tracker.check("svc-a", 1);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4); // per-service is more constrained
    });
  });

  describe("window reset", () => {
    it("resets per-service counter after window expires", () => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);

      const tracker = new BudgetTracker({
        perService: { "svc-a": { maxUnits: 10, windowMs: 1000 } },
      });

      tracker.record("svc-a", 10);
      expect(tracker.check("svc-a", 1).allowed).toBe(false);

      // Advance past window
      vi.spyOn(Date, "now").mockReturnValue(now + 1001);
      expect(tracker.check("svc-a", 1).allowed).toBe(true);
    });

    it("resets global counter after window expires", () => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);

      const tracker = new BudgetTracker({
        global: { maxUnits: 10, windowMs: 1000 },
      });

      tracker.record("svc-a", 10);
      expect(tracker.check("svc-a", 1).allowed).toBe(false);

      vi.spyOn(Date, "now").mockReturnValue(now + 1001);
      expect(tracker.check("svc-a", 1).allowed).toBe(true);
    });
  });

  describe("reset()", () => {
    it("resets a specific service", () => {
      const tracker = new BudgetTracker({
        perService: {
          "svc-a": { maxUnits: 10, windowMs: 60_000 },
          "svc-b": { maxUnits: 10, windowMs: 60_000 },
        },
      });

      tracker.record("svc-a", 10);
      tracker.record("svc-b", 10);

      tracker.reset("svc-a");

      expect(tracker.check("svc-a", 1).allowed).toBe(true);
      expect(tracker.check("svc-b", 1).allowed).toBe(false);
    });

    it("resets everything when called without args", () => {
      const tracker = new BudgetTracker({
        perService: { "svc-a": { maxUnits: 10, windowMs: 60_000 } },
        global: { maxUnits: 20, windowMs: 60_000 },
      });

      tracker.record("svc-a", 10);
      tracker.reset();

      expect(tracker.check("svc-a", 10).allowed).toBe(true);
    });
  });
});
