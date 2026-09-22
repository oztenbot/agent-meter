/**
 * Sub-cent price helpers for per-call pricing.
 *
 * Calls in the agent economy are priced in fractions of a cent — $0.0005,
 * $0.002, $0.03. Representing those as a JavaScript `number` is fine for one
 * call but loses precision the moment you sum a run or settle a bill, and a
 * six-decimal ledger unit (like a stablecoin's raw unit) rounds a sub-cent
 * price to zero. Keeping a per-call price as an integer count of micro-dollars
 * (1e-6 USD) makes it exact across any number of calls and lets a billing
 * layer later settle the lossless total. All arithmetic here is integer-only
 * and dependency-free, matching the SDK's zero-dependency rule.
 */

const MICRO_PER_DOLLAR = 1_000_000n;

/**
 * Parse a dollar amount (number or numeric string) into an exact count of
 * micro-dollars (1e-6 USD). A call priced at 0.0005 USD becomes `500n`.
 *
 * Throws a RangeError for a non-finite or negative amount.
 */
export function parseSubcent(usd: number | string): bigint {
  if (typeof usd === "string") {
    usd = Number(usd);
  }
  if (!Number.isFinite(usd) || usd < 0) {
    throw new RangeError(
      `sub-cent price must be a finite, non-negative number; got ${usd}`,
    );
  }
  // Round to the nearest micro-dollar; Math.round absorbs float error (e.g.
  // 0.3 * 1e6 === 300000.00000000006) while staying exact at the 1e-6 grid.
  return BigInt(Math.round(usd * Number(MICRO_PER_DOLLAR)));
}

/**
 * Format a micro-dollar integer back to a plain decimal string, e.g. `500n`
 * -> `"0.0005"`. The inverse of {@link parseSubcent}. Trailing zeros in the
 * fractional part are trimmed, so a whole-dollar amount formats as `"1.25"`.
 */
export function formatSubcent(value: bigint): string {
  if (value < 0n) {
    throw new RangeError(`cannot format a negative sub-cent value: ${value}`);
  }
  const dollars = value / MICRO_PER_DOLLAR;
  const micro = value % MICRO_PER_DOLLAR;
  const fraction = micro.toString().padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? `${dollars}` : `${dollars}.${fraction}`;
}

/**
 * Lossless total of many per-call prices. Summing sub-cent prices as floats
 * drifts; summing as micro-dollar integers does not.
 */
export function sumSubcents(values: readonly bigint[]): bigint {
  return values.reduce((acc, value) => acc + value, 0n);
}

/** True when `a` costs less than `b`. Intended for budgeting decisions. */
export function cheaperThan(a: bigint, b: bigint): boolean {
  return a < b;
}

/**
 * True when a single call's price alone clears the rail's minimum-collection
 * floor. A card rail that will not charge a card below $0.30 cannot settle a
 * $0.0005 call by itself; enough volume must accumulate first (see
 * {@link breakEvenCalls}). A rail with no floor (`floor === 0n`, the
 * "no minimum fee" case, e.g. a feeless net) settles every price standalone.
 */
export function settleStandalone(perCall: bigint, floor: bigint): boolean {
  if (perCall < 1n) {
    throw new RangeError(`per-call price must be positive; got ${perCall}`);
  }
  if (floor < 0n) {
    throw new RangeError(`collection floor must be non-negative; got ${floor}`);
  }
  return floor === 0n || perCall >= floor;
}

/**
 * How many calls at `perCall` must accumulate before the batch reaches the
 * rail's minimum-collection floor. Ceil division, exact in integers. Returns
 * `0n` when the floor is zero (no minimum fee).
 */
export function breakEvenCalls(perCall: bigint, floor: bigint): bigint {
  if (perCall < 1n) {
    throw new RangeError(`per-call price must be positive; got ${perCall}`);
  }
  if (floor < 0n) {
    throw new RangeError(`collection floor must be non-negative; got ${floor}`);
  }
  if (floor === 0n) {
    return 0n;
  }
  return (floor + perCall - 1n) / perCall;
}

/**
 * The exact integer multiple by which a per-call price falls short of the
 * rail's minimum-collection floor: how many same-priced calls batch into one
 * collectible charge. `0n` when there is no floor, `1n` when a single call
 * clears it. The inverse lens on {@link breakEvenCalls}.
 */
export function feeFloorGap(perCall: bigint, floor: bigint): bigint {
  if (perCall < 1n) {
    throw new RangeError(`per-call price must be positive; got ${perCall}`);
  }
  if (floor < 0n) {
    throw new RangeError(`collection floor must be non-negative; got ${floor}`);
  }
  if (floor === 0n) {
    return 0n;
  }
  return (floor + perCall - 1n) / perCall;
}
