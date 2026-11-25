// Integer port of Uniswap V3 core math (TickMath, FullMath, SqrtPriceMath, SwapMath) on bigint.
// Mirrors Solidity rounding exactly so simulated sqrtPriceX96 values match on-chain results.

export const Q96 = 1n << 96n;
export const MAX_UINT160 = (1n << 160n) - 1n;
export const MAX_UINT256 = (1n << 256n) - 1n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const FEE_DENOM = 1_000_000n;

export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("mulDiv: division by zero");
  return (a * b) / denominator;
}

export function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  const product = a * b;
  const result = product / denominator;
  return product % denominator === 0n ? result : result + 1n;
}

export function divRoundingUp(a: bigint, b: bigint): bigint {
  return a / b + (a % b === 0n ? 0n : 1n);
}

const TICK_MAGIC: readonly [number, bigint][] = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new RangeError(`tick out of range: ${tick}`);
  }
  const absTick = Math.abs(tick);
  let ratio = absTick & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, magic] of TICK_MAGIC) {
    if (absTick & bit) ratio = (ratio * magic) >> 128n;
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Greatest tick such that getSqrtRatioAtTick(tick) <= sqrtPriceX96 (binary search, same result as TickMath). */
export function getTickAtSqrtRatio(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new RangeError(`sqrtPriceX96 out of range: ${sqrtPriceX96}`);
  }
  let lo = MIN_TICK;
  let hi = MAX_TICK;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (getSqrtRatioAtTick(mid) <= sqrtPriceX96) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function getNextSqrtPriceFromAmount0RoundingUp(sqrtP: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (amount === 0n) return sqrtP;
  const numerator1 = liquidity << 96n;
  const product = amount * sqrtP;
  if (add) {
    if (product <= MAX_UINT256) {
      const denominator = numerator1 + product;
      if (denominator <= MAX_UINT256 && denominator >= numerator1) {
        return mulDivRoundingUp(numerator1, sqrtP, denominator);
      }
    }
    return divRoundingUp(numerator1, numerator1 / sqrtP + amount);
  }
  if (product > MAX_UINT256 || numerator1 <= product) throw new RangeError("amount0 exceeds reserves");
  return mulDivRoundingUp(numerator1, sqrtP, numerator1 - product);
}

function getNextSqrtPriceFromAmount1RoundingDown(sqrtP: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (add) {
    const quotient = amount <= MAX_UINT160 ? (amount << 96n) / liquidity : mulDiv(amount, Q96, liquidity);
    return sqrtP + quotient;
  }
  const quotient =
    amount <= MAX_UINT160 ? divRoundingUp(amount << 96n, liquidity) : mulDivRoundingUp(amount, Q96, liquidity);
  if (sqrtP <= quotient) throw new RangeError("amount1 exceeds reserves");
  return sqrtP - quotient;
}

export function getNextSqrtPriceFromInput(sqrtP: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (sqrtP <= 0n || liquidity <= 0n) throw new RangeError("sqrtPrice and liquidity must be positive");
  return zeroForOne
    ? getNextSqrtPriceFromAmount0RoundingUp(sqrtP, liquidity, amountIn, true)
    : getNextSqrtPriceFromAmount1RoundingDown(sqrtP, liquidity, amountIn, true);
}

export function getAmount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  const numerator1 = liquidity << 96n;
  const numerator2 = hi - lo;
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, hi), lo)
    : mulDiv(numerator1, numerator2, hi) / lo;
}

export function getAmount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  return roundUp ? mulDivRoundingUp(liquidity, hi - lo, Q96) : mulDiv(liquidity, hi - lo, Q96);
}

export interface SwapStep {
  sqrtPriceNextX96: bigint;
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
}

export function getNextSqrtPriceFromOutput(
  sqrtP: bigint,
  liquidity: bigint,
  amountOut: bigint,
  zeroForOne: boolean,
): bigint {
  if (sqrtP <= 0n || liquidity <= 0n) throw new RangeError("sqrtPrice and liquidity must be positive");
  return zeroForOne
    ? getNextSqrtPriceFromAmount1RoundingDown(sqrtP, liquidity, amountOut, false)
    : getNextSqrtPriceFromAmount0RoundingUp(sqrtP, liquidity, amountOut, false);
}

/** SwapMath.computeSwapStep. amountRemaining > 0 = exact input, < 0 = exact output (Solidity convention). */
export function computeSwapStep(
  sqrtCurrent: bigint,
  sqrtTarget: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feePips: bigint,
): SwapStep {
  const zeroForOne = sqrtCurrent >= sqrtTarget;
  const exactIn = amountRemaining >= 0n;
  let amountIn = 0n;
  let amountOut = 0n;
  let sqrtNext: bigint;
  if (exactIn) {
    const amountRemainingLessFee = mulDiv(amountRemaining, FEE_DENOM - feePips, FEE_DENOM);
    amountIn = zeroForOne
      ? getAmount0Delta(sqrtTarget, sqrtCurrent, liquidity, true)
      : getAmount1Delta(sqrtCurrent, sqrtTarget, liquidity, true);
    sqrtNext =
      amountRemainingLessFee >= amountIn
        ? sqrtTarget
        : getNextSqrtPriceFromInput(sqrtCurrent, liquidity, amountRemainingLessFee, zeroForOne);
  } else {
    amountOut = zeroForOne
      ? getAmount1Delta(sqrtTarget, sqrtCurrent, liquidity, false)
      : getAmount0Delta(sqrtCurrent, sqrtTarget, liquidity, false);
    sqrtNext =
      -amountRemaining >= amountOut
        ? sqrtTarget
        : getNextSqrtPriceFromOutput(sqrtCurrent, liquidity, -amountRemaining, zeroForOne);
  }
  const max = sqrtTarget === sqrtNext;
  if (zeroForOne) {
    if (!(max && exactIn)) amountIn = getAmount0Delta(sqrtNext, sqrtCurrent, liquidity, true);
    if (!(max && !exactIn)) amountOut = getAmount1Delta(sqrtNext, sqrtCurrent, liquidity, false);
  } else {
    if (!(max && exactIn)) amountIn = getAmount1Delta(sqrtCurrent, sqrtNext, liquidity, true);
    if (!(max && !exactIn)) amountOut = getAmount0Delta(sqrtCurrent, sqrtNext, liquidity, false);
  }
  if (!exactIn && amountOut > -amountRemaining) amountOut = -amountRemaining;
  const feeAmount =
    exactIn && sqrtNext !== sqrtTarget
      ? amountRemaining - amountIn
      : mulDivRoundingUp(amountIn, feePips, FEE_DENOM - feePips);
  return { sqrtPriceNextX96: sqrtNext, amountIn, amountOut, feeAmount };
}

/** SwapMath.computeSwapStep for exact-input swaps (amountRemaining > 0). */
export function computeSwapStepExactIn(
  sqrtCurrent: bigint,
  sqrtTarget: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feePips: bigint,
): SwapStep {
  if (amountRemaining <= 0n) throw new RangeError("exact-in amount must be positive");
  return computeSwapStep(sqrtCurrent, sqrtTarget, liquidity, amountRemaining, feePips);
}
