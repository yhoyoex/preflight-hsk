import { describe, expect, it } from "vitest";
import {
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  Q96,
  computeSwapStepExactIn,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
} from "../src/v3math.ts";

describe("TickMath", () => {
  it("matches the Solidity reference points", () => {
    expect(getSqrtRatioAtTick(0)).toBe(Q96);
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(MIN_SQRT_RATIO);
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(MAX_SQRT_RATIO);
  });

  it("inverts getSqrtRatioAtTick", () => {
    for (const t of [-301482, -301441, -60, -1, 0, 1, 60, 200000]) {
      const r = getSqrtRatioAtTick(t);
      expect(getTickAtSqrtRatio(r)).toBe(t);
      expect(getTickAtSqrtRatio(r + 1n)).toBe(t);
      expect(getTickAtSqrtRatio(r - 1n)).toBe(t - 1);
    }
  });

  it("rejects out-of-range input", () => {
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow(RangeError);
    expect(() => getTickAtSqrtRatio(MIN_SQRT_RATIO - 1n)).toThrow(RangeError);
  });
});

describe("SwapMath.computeSwapStep (exact in)", () => {
  it("charges fee on the full remaining amount when the target is not reached", () => {
    const sqrt = getSqrtRatioAtTick(-301482);
    const step = computeSwapStepExactIn(sqrt, getSqrtRatioAtTick(-301440), 10n ** 18n, 1_000_000n, 3000n);
    expect(step.amountIn + step.feeAmount).toBe(1_000_000n);
    expect(step.feeAmount).toBeGreaterThanOrEqual(3000n);
    expect(step.sqrtPriceNextX96).toBeGreaterThan(sqrt);
  });

  it("stops exactly at the target when input is large enough", () => {
    const sqrt = getSqrtRatioAtTick(-301482);
    const target = getSqrtRatioAtTick(-301440);
    const step = computeSwapStepExactIn(sqrt, target, 10n ** 18n, 10n ** 30n, 3000n);
    expect(step.sqrtPriceNextX96).toBe(target);
  });
});
