import { describe, it, expect } from "vitest";
import {
  breakEvenCalls,
  cheaperThan,
  feeFloorGap,
  formatSubcent,
  parseSubcent,
  settleStandalone,
  sumSubcents,
} from "../src/subcent.js";

describe("parseSubcent", () => {
  it("parses a sub-cent call price exactly", () => {
    expect(parseSubcent(0.0005)).toBe(500n);
  });

  it("parses a micro-payment price", () => {
    expect(parseSubcent(0.000001)).toBe(1n);
  });

  it("parses a whole-dollar price", () => {
    expect(parseSubcent(1.25)).toBe(1_250_000n);
  });

  it("parses a numeric string", () => {
    expect(parseSubcent("0.002")).toBe(2_000n);
  });

  it("parses zero", () => {
    expect(parseSubcent(0)).toBe(0n);
  });

  it("rejects a negative price", () => {
    expect(() => parseSubcent(-0.5)).toThrow(RangeError);
  });

  it("rejects a non-finite price", () => {
    expect(() => parseSubcent(Number.NaN)).toThrow(RangeError);
    expect(() => parseSubcent(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("formatSubcent", () => {
  it("formats a sub-cent amount back to a decimal string", () => {
    expect(formatSubcent(500n)).toBe("0.0005");
  });

  it("formats a whole-dollar amount", () => {
    expect(formatSubcent(1_250_000n)).toBe("1.25");
  });

  it("round-trips parse -> format for a sub-cent price", () => {
    expect(formatSubcent(parseSubcent(0.00003))).toBe("0.00003");
  });

  it("rejects a negative value", () => {
    expect(() => formatSubcent(-1n)).toThrow(RangeError);
  });
});

describe("sumSubcents", () => {
  it("sums sub-cent prices losslessly", () => {
    // Three $0.0005 calls: exactly $0.0015, never a float remainder.
    expect(sumSubcents([500n, 500n, 500n])).toBe(1_500n);
  });

  it("sums an empty list to zero", () => {
    expect(sumSubcents([])).toBe(0n);
  });

  it("sums a large run without drift", () => {
    const calls = Array.from({ length: 100_000 }, () => 1n);
    expect(sumSubcents(calls)).toBe(100_000n);
  });
});

describe("cheaperThan", () => {
  it("is true when a costs less than b", () => {
    expect(cheaperThan(500n, 2_000n)).toBe(true);
  });

  it("is false when a costs the same as b", () => {
    expect(cheaperThan(500n, 500n)).toBe(false);
  });

  it("is false when a costs more than b", () => {
    expect(cheaperThan(2_000n, 500n)).toBe(false);
  });
});

describe("settleStandalone", () => {
  it("settles a call alone when it meets the floor", () => {
    // $0.30 floor, $0.50 call.
    expect(settleStandalone(500_000n, 300_000n)).toBe(true);
  });

  it("refuses a call alone that is below the floor", () => {
    // $0.30 floor, $0.0005 call.
    expect(settleStandalone(500n, 300_000n)).toBe(false);
  });

  it("settles any price alone with no floor (no minimum fee)", () => {
    expect(settleStandalone(1n, 0n)).toBe(true);
    expect(settleStandalone(500n, 0n)).toBe(true);
  });

  it("rejects a non-positive per-call price", () => {
    expect(() => settleStandalone(0n, 0n)).toThrow(RangeError);
    expect(() => settleStandalone(-1n, 0n)).toThrow(RangeError);
  });

  it("rejects a negative floor", () => {
    expect(() => settleStandalone(500n, -1n)).toThrow(RangeError);
  });
});

describe("breakEvenCalls", () => {
  it("counts calls needed to cross the floor (ceil division)", () => {
    // $0.0005 x 600 = $0.30 exactly.
    expect(breakEvenCalls(500n, 300_000n)).toBe(600n);
  });

  it("rounds up a partial batch", () => {
    // $0.07 x 5 = $0.35 > $0.30, but 4 x $0.07 = $0.28 < $0.30.
    expect(breakEvenCalls(70_000n, 300_000n)).toBe(5n);
  });

  it("is one when a single call clears the floor", () => {
    expect(breakEvenCalls(500_000n, 300_000n)).toBe(1n);
  });

  it("is zero when there is no floor", () => {
    expect(breakEvenCalls(500n, 0n)).toBe(0n);
  });

  it("rejects a non-positive per-call price", () => {
    expect(() => breakEvenCalls(0n, 300_000n)).toThrow(RangeError);
  });

  it("rejects a negative floor", () => {
    expect(() => breakEvenCalls(500n, -1n)).toThrow(RangeError);
  });
});

describe("feeFloorGap", () => {
  it("is the ceil ratio of floor to per-call price", () => {
    expect(feeFloorGap(500n, 300_000n)).toBe(600n);
  });

  it("is one when the call clears the floor", () => {
    expect(feeFloorGap(500_000n, 300_000n)).toBe(1n);
  });

  it("is zero when there is no floor", () => {
    expect(feeFloorGap(500n, 0n)).toBe(0n);
  });

  it("rejects a non-positive per-call price", () => {
    expect(() => feeFloorGap(0n, 300_000n)).toThrow(RangeError);
  });
});