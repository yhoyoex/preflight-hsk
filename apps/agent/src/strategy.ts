// Deterministic trigger + sizing, ported from research/arb_sim.py (float math, same constants).
// The reference price itself is core `med5` (port of Market.ref(mode="med5")).

export const FEE = 0.003;
export const BUFFER_BPS = 40;
export const MAX_TRADE_FRAC = 0.5;
export const MIN_EDGE_GAS_MULT = 2;
export const THRESHOLD_BPS = 100;
const GAS_UNITS = 200_000;
/** arb_sim's backtest gas price; only a default — the live agent passes eth_gasPrice. */
export const DEFAULT_GAS_PRICE_WEI = 501e9;
/** Max L1 data fee seen in research receipts (OP-stack; not exposed by eth_gasPrice). */
const L1_FEE_WEI = 3.2e13;
const DEC0 = 18;
const DEC1 = 6;
const SCALE = 10 ** (DEC0 - DEC1);
const Q96 = 2 ** 96;

/** USDT per WHSK from a float sqrtPrice (sqrtPriceX96 / 2^96). */
export const priceOf = (sp: number): number => sp * sp * SCALE;
export const spOf = (price: number): number => Math.sqrt(price / SCALE);
export const spFromX96 = (sqrtPriceX96: bigint): number => Number(sqrtPriceX96) / Q96;

export function gasUsd(hskPrice: number, gasPriceWei: number = DEFAULT_GAS_PRICE_WEI): number {
  return ((GAS_UNITS * gasPriceWei + L1_FEE_WEI) / 1e18) * hskPrice;
}

/** Signed DEX-vs-reference gap in bps; a signal when |gap| > threshold (sell WHSK when the DEX is rich). */
export function signal(dexPrice: number, ref: number, thresholdBps = THRESHOLD_BPS): { gapBps: number; sell: boolean } | null {
  const gapBps = ((dexPrice - ref) / ref) * 1e4;
  return Math.abs(gapBps) > thresholdBps ? { gapBps, sell: gapBps > 0 } : null;
}

export interface Sized {
  /** sqrtPrice after the trade (float). */
  target: number;
  /** tokenIn units (WHSK when selling, USDT when buying), fee included. */
  amountIn: number;
  /** tokenOut units. */
  amountOut: number;
}

/** arb_sim.py size_trade: move the DEX to ref × (1 ± buffer), capped by inventory and maxUsd. */
export function sizeTrade(
  sp: number,
  L: number,
  ref: number,
  sell: boolean,
  whsk: number,
  usdt: number,
  maxUsd: number,
): Sized | null {
  const buf = BUFFER_BPS / 1e4;
  if (sell) {
    let tgt = spOf(ref * (1 + buf));
    if (tgt >= sp) return null;
    let net0 = L * (1 / tgt - 1 / sp);
    const cap = Math.min(whsk, maxUsd / ref) * 10 ** DEC0 * (1 - FEE);
    if (net0 > cap) {
      net0 = cap;
      tgt = 1 / (1 / sp + net0 / L);
    }
    return { target: tgt, amountIn: net0 / (1 - FEE) / 10 ** DEC0, amountOut: (L * (sp - tgt)) / 10 ** DEC1 };
  }
  let tgt = spOf(ref * (1 - buf));
  if (tgt <= sp) return null;
  let net1 = L * (tgt - sp);
  const cap = Math.min(usdt, maxUsd) * 10 ** DEC1 * (1 - FEE);
  if (net1 > cap) {
    net1 = cap;
    tgt = sp + net1 / L;
  }
  return { target: tgt, amountIn: net1 / (1 - FEE) / 10 ** DEC1, amountOut: (L * (1 / sp - 1 / tgt)) / 10 ** DEC0 };
}

export interface Decision {
  sell: boolean;
  gapBps: number;
  dexPrice: number;
  /** Deterministic size (upper bound for the LLM) and its bounds in tokenIn units. */
  maxAmountIn: number;
  minAmountIn: number;
  expectedOut: number;
  edgeUsd: number;
  gasUsd: number;
}

export type Hold = { hold: true; why: "no-signal" | "no-size" | "edge-below-gas" | "dust"; gapBps: number; dexPrice: number };

/** One arb_sim decision step at the current pool state (sp, L) and med5 reference. */
export function decide(input: {
  sp: number;
  L: number;
  ref: number;
  whsk: number;
  usdt: number;
  capitalUsd: number;
  thresholdBps?: number;
  /** Current eth_gasPrice (wei); default: arb_sim's backtest constant. */
  gasPriceWei?: number;
}): Decision | Hold {
  const dexPrice = priceOf(input.sp);
  const s = signal(dexPrice, input.ref, input.thresholdBps);
  const gap = ((dexPrice - input.ref) / input.ref) * 1e4;
  if (!s) return { hold: true, why: "no-signal", gapBps: gap, dexPrice };
  const maxUsd = input.capitalUsd * MAX_TRADE_FRAC;
  const sized = sizeTrade(input.sp, input.L, input.ref, s.sell, input.whsk, input.usdt, maxUsd);
  if (!sized) return { hold: true, why: "no-size", gapBps: gap, dexPrice };
  const edgeUsd = s.sell ? sized.amountOut - sized.amountIn * input.ref : sized.amountOut * input.ref - sized.amountIn;
  const g = gasUsd(input.ref, input.gasPriceWei);
  if (edgeUsd < MIN_EDGE_GAS_MULT * g) return { hold: true, why: "edge-below-gas", gapBps: gap, dexPrice };
  const notionalUsd = sized.amountIn * (s.sell ? input.ref : 1);
  if (notionalUsd < 1) return { hold: true, why: "dust", gapBps: gap, dexPrice };
  return {
    sell: s.sell,
    gapBps: s.gapBps,
    dexPrice,
    maxAmountIn: sized.amountIn,
    minAmountIn: s.sell ? 1 / input.ref : 1, // $1 notional, arb_sim's minimum
    expectedOut: sized.amountOut,
    edgeUsd,
    gasUsd: g,
  };
}
