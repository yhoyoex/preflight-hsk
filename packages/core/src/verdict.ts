// Preflight verdict: where/whether to execute, mirroring the on-chain checks of ExecutionGuard + GuardedRouter.
import { sqrtX96ToPriceE18 } from "./cex.ts";
import { simulateSwap, spotOut, type PoolState, type SwapResult } from "./pool.ts";
import { Q96 } from "./v3math.ts";

export interface Policy {
  maxImpactBps: number;
  maxDevBps: number;
  maxAge: number;
}

/** ExecutionGuard.DEFAULT_* */
export const DEFAULT_POLICY: Readonly<Policy> = { maxImpactBps: 100, maxDevBps: 200, maxAge: 120 };

export type VerdictKind = "DEX" | "CEX" | "TUNDA" | "KECILKAN" | "NO_REFERENCE" | "OUT_OF_RANGE";

export interface VerdictConfig {
  /**
   * Impact (bps, excl. LP fee) above which a large order should go to CEX/OTC. This is the output shortfall vs spot
   * (`impactBps`), the same metric as REPORT.md's split-order table "biaya dampak" (:99-104: ≥$4,238 → ≥100 bps;
   * core simulation at the fixture state: $4,251). It is NOT REPORT's per-swap "dampak harga" (:11), which is the pool
   * price move (≈2× impactBps for the same order). The CEX verdict additionally needs cexMinNotionalUsd.
   */
  cexImpactBps: number;
  /** Minimum notional for the CEX/OTC suggestion (REPORT.md: for ≥$10k the value is another venue). */
  cexMinNotionalUsd: number;
  /** Adverse DEX-vs-reference gap (bps) that suggests waiting (REPORT.md: |gap| > 50 bps 39% of minutes). */
  delayDevBps: number;
}

export const DEFAULT_VERDICT_CONFIG: Readonly<VerdictConfig> = {
  cexImpactBps: 100,
  cexMinNotionalUsd: 10_000,
  delayDevBps: 50,
};

const BPS = 10_000n;
const E18 = 10n ** 18n;

/** PriceMath.deviationBps: |price(a)/price(ref) - 1| in bps, rounded down (bit-exact port). */
export function deviationBps(sqrtA: bigint, sqrtRef: bigint): number {
  const ratioX96 = (sqrtA * Q96) / sqrtRef;
  const priceRatioX96 = (ratioX96 * ratioX96) / Q96;
  const diff = priceRatioX96 > Q96 ? priceRatioX96 - Q96 : Q96 - priceRatioX96;
  return Number((diff * BPS) / Q96);
}

/** Signed variant: positive when price(a) is above price(ref). */
export function signedDeviationBps(sqrtA: bigint, sqrtRef: bigint): number {
  const d = deviationBps(sqrtA, sqrtRef);
  return sqrtA >= sqrtRef ? d : -d;
}

/**
 * GuardedRouter fair floor: spotOut at the quoted fair price, reduced by maxDevBps + maxImpactBps.
 * The router enforces max(amountOutMin, this) so a sandwich cannot push execution below it.
 */
export function fairFloorOut(
  zeroForOne: boolean,
  fairSqrtPriceX96: bigint,
  amountIn: bigint,
  feePips: number,
  policy: Policy,
): bigint {
  const slack = BigInt(policy.maxDevBps + policy.maxImpactBps);
  if (slack >= BPS) return 0n;
  return (spotOut(zeroForOne, fairSqrtPriceX96, amountIn, feePips) * (BPS - slack)) / BPS;
}

export type RouterCheck = "STATUS" | "IMPACT" | "POST_SWAP_DEV" | "FAIR_FLOOR";

/** Size-dependent checks GuardedRouter would apply if the pool stayed at `state` until execution. */
export function failedRouterChecks(
  state: PoolState,
  sim: SwapResult,
  zeroForOne: boolean,
  amountIn: bigint,
  fairSqrtPriceX96: bigint,
  policy: Policy,
): RouterCheck[] {
  if (sim.status !== "OK") return ["STATUS"];
  const failed: RouterCheck[] = [];
  if (sim.impactBpsCeil > policy.maxImpactBps) failed.push("IMPACT");
  if (deviationBps(sim.sqrtPriceAfterX96, fairSqrtPriceX96) > policy.maxDevBps) failed.push("POST_SWAP_DEV");
  if (sim.amountOut < fairFloorOut(zeroForOne, fairSqrtPriceX96, amountIn, state.feePips, policy)) {
    failed.push("FAIR_FLOOR");
  }
  return failed;
}

/** Largest amountIn (≤ upper) passing every size-dependent router check; 0 if none (binary search). */
export function suggestMaxAmountIn(
  state: PoolState,
  zeroForOne: boolean,
  upper: bigint,
  fairSqrtPriceX96: bigint,
  policy: Policy,
): bigint {
  const ok = (a: bigint) =>
    failedRouterChecks(state, simulateSwap(state, zeroForOne, a), zeroForOne, a, fairSqrtPriceX96, policy)
      .length === 0;
  let lo = 0n;
  let hi = upper;
  if (hi <= 0n) return 0n;
  if (ok(hi)) return hi;
  const tolerance = upper / 100_000n;
  while (hi - lo > (tolerance > 1n ? tolerance : 1n)) {
    const mid = (lo + hi) / 2n;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface VerdictInput {
  state: PoolState;
  zeroForOne: boolean;
  amountIn: bigint;
  /** Reference (CEX med5) as sqrtPriceX96 and USDT/WHSK 1e18; null when stale. */
  fair: { sqrtPriceX96: bigint; priceE18: bigint } | null;
  policy?: Policy;
  config?: Partial<VerdictConfig>;
  sim?: SwapResult;
}

export interface VerdictMetrics {
  status: SwapResult["status"];
  amountIn: bigint;
  amountOut: bigint;
  /** Impact excl. LP fee, integer bps rounded up like PriceMath (null when not computable). */
  impactBps: number | null;
  /** Signed DEX spot vs reference (positive: DEX above reference), PriceMath rounding; null without reference. */
  devBps: number | null;
  /** Deviation that hurts this trade direction (0 if favourable); null without reference. */
  adverseDevBps: number | null;
  /** |price after swap / fair - 1| (router post-swap check). */
  postSwapDevBps: number | null;
  feeBps: number;
  /** feeBps + impactBps + adverseDevBps (null when impact unknown). */
  totalCostBps: number | null;
  notionalUsd: number;
  /** Router fair floor for the requested size. */
  minAmountOut: bigint;
  /** Largest size passing the router's size-dependent checks; null when the requested size already passes. */
  suggestedMaxAmountIn: bigint | null;
  /** Reference used for the router checks above ("dex-spot" only as an unattested estimate when CEX is stale). */
  fairSource: "cex" | "dex-spot";
  /** CEX fair price; null when the reference is stale. DEX spot is never reported (or signed) as fair. */
  fairSqrtPriceX96: bigint | null;
}

export interface Verdict {
  verdict: VerdictKind;
  /** Whether GuardedRouter is predicted to accept this size now (pool unchanged until execution). */
  executable: boolean;
  reason: string;
  reasons: string[];
  failedChecks: RouterCheck[];
  metrics: VerdictMetrics;
}

function usdNotional(zeroForOne: boolean, amountIn: bigint, priceE18: bigint): number {
  // zeroForOne: WHSK (18 dec) in; else USDT (6 dec) in.
  const usdE6 = zeroForOne ? (amountIn * priceE18) / E18 / 10n ** 12n : amountIn;
  return Number(usdE6) / 1e6;
}

export function evaluate(input: VerdictInput): Verdict {
  const { state, zeroForOne, amountIn } = input;
  const policy = input.policy ?? DEFAULT_POLICY;
  const cfg = { ...DEFAULT_VERDICT_CONFIG, ...input.config };
  const sim = input.sim ?? simulateSwap(state, zeroForOne, amountIn);
  const feeBps = state.feePips / 100;
  const fairSqrt = input.fair?.sqrtPriceX96 ?? state.sqrtPriceX96;
  const notionalUsd = usdNotional(zeroForOne, amountIn, input.fair?.priceE18 ?? sqrtX96ToPriceE18(state.sqrtPriceX96));

  const ok = sim.status === "OK";
  const impactBps = ok && Number.isFinite(sim.impactBpsCeil) ? sim.impactBpsCeil : null;
  const devBps = input.fair ? signedDeviationBps(state.sqrtPriceX96, fairSqrt) : null;
  const adverseDevBps = devBps === null ? null : Math.max(0, zeroForOne ? -devBps : devBps);
  const postSwapDevBps = ok ? deviationBps(sim.sqrtPriceAfterX96, fairSqrt) : null;
  const failedChecks = failedRouterChecks(state, sim, zeroForOne, amountIn, fairSqrt, policy);
  // Direction-agnostic on purpose, like ExecutionGuard's spot check: a gap beyond maxDevBps is TUNDA even when it
  // favours this trade (fail-safe: a CEX feed that far off is as likely wrong as the pool). With the agent's 100 bps
  // trigger only gaps in (100, maxDevBps] can be signed.
  const spotDevFails = devBps !== null && Math.abs(devBps) > policy.maxDevBps;
  const suggestedMaxAmountIn =
    ok && failedChecks.length > 0 ? suggestMaxAmountIn(state, zeroForOne, amountIn, fairSqrt, policy) : null;

  const metrics: VerdictMetrics = {
    status: sim.status,
    amountIn,
    amountOut: sim.amountOut,
    impactBps,
    devBps,
    adverseDevBps,
    postSwapDevBps,
    feeBps,
    totalCostBps: impactBps === null ? null : feeBps + impactBps + (adverseDevBps ?? 0),
    notionalUsd,
    minAmountOut: fairFloorOut(zeroForOne, fairSqrt, amountIn, state.feePips, policy),
    suggestedMaxAmountIn,
    fairSource: input.fair ? "cex" : "dex-spot",
    fairSqrtPriceX96: input.fair ? input.fair.sqrtPriceX96 : null,
  };

  const reasons: string[] = [];
  const done = (verdict: VerdictKind, executable: boolean): Verdict => ({
    verdict,
    executable,
    reason: reasons[0] ?? "",
    reasons,
    failedChecks,
    metrics,
  });

  if (!ok || impactBps === null) {
    reasons.push(
      sim.status === "PRICE_LIMIT"
        ? "Pool liquidity runs out before the order is fully filled; impact cannot be computed — do not execute on the DEX."
        : "Order crosses beyond the scanned tick range (±4 words); impact cannot be confirmed — reject or reduce the size.",
    );
    return done("OUT_OF_RANGE", false);
  }
  if (input.fair === null) reasons.push("CEX price is stale (no trade in the last 5 minutes); using DEX spot as the reference.");
  const sizeText = suggestedMaxAmountIn !== null ? ` Max size within policy: ${suggestedMaxAmountIn}.` : "";

  if (impactBps > cfg.cexImpactBps && notionalUsd >= cfg.cexMinNotionalUsd) {
    reasons.unshift(
      `Impact ${impactBps} bps (+${feeBps} bps fee) for ~$${Math.round(notionalUsd)}; the pool is too thin — use a CEX/OTC.${sizeText}`,
    );
    return done("CEX", false);
  }
  const delayText = `DEX price deviates ${devBps} bps from CEX (${adverseDevBps} bps against this trade); wait until the gap narrows.`;
  // Spot already beyond maxDevBps: the guard rejects any size, so shrinking does not help.
  if (spotDevFails) {
    reasons.unshift(`${delayText} Exceeds maxDevBps ${policy.maxDevBps} — the guard will reject it.`);
    return done("TUNDA", false);
  }
  if (failedChecks.length > 0) {
    reasons.unshift(
      `Order breaks on-chain limits (${failedChecks.join(", ")}; impact ${impactBps} bps vs max ${policy.maxImpactBps}).${sizeText}`,
    );
    return done("KECILKAN", false);
  }
  if (input.fair === null) return done("NO_REFERENCE", true);
  if ((adverseDevBps ?? 0) > cfg.delayDevBps) {
    reasons.unshift(delayText);
    return done("TUNDA", true);
  }
  reasons.unshift(`Execute on the DEX: impact ${impactBps} bps + fee ${feeBps} bps, CEX gap ${devBps} bps.`);
  return done("DEX", true);
}

/**
 * Security re-audit A: a quote may only be attested when the verdict is an executable DEX verdict AND a fresh
 * CEX fair price exists. Returns the fair sqrtPrice to sign, or null when nothing may be signed.
 */
export function attestableFair(v: Verdict): bigint | null {
  if (v.verdict !== "DEX" || !v.executable || v.metrics.impactBps === null) return null;
  return v.metrics.fairSource === "cex" ? v.metrics.fairSqrtPriceX96 : null;
}
