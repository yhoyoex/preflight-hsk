// Cost-vs-size curve for /api/curve: pool simulation + CEX reference, never signed (no attestor key needed).
import {
  createFairPriceSource,
  DEFAULT_POLICY,
  evaluate,
  fetchPoolState,
  sqrtX96ToPriceE18,
  type FairPrice,
  type PoolState,
  type VerdictKind,
} from "@preflight/core";
import { createPublicClient, http, type PublicClient } from "viem";

/** Order sizes in USD notional; WHSK sizes are converted at the reference price. */
export const CURVE_SIZES_USD = [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 20_000] as const;

export interface CurvePoint {
  usd: number;
  /** Raw units of tokenIn (USDT 6 dec, WHSK 18 dec). */
  amountIn: bigint;
  verdict: VerdictKind;
  feeBps: number;
  impactBps: number | null;
  adverseDevBps: number | null;
  totalCostBps: number | null;
}

export interface CurveResponse {
  zeroForOne: boolean;
  reference: "cex" | "dex-spot";
  policy: { maxImpactBps: number; maxDevBps: number };
  points: CurvePoint[];
}

export interface CurveDeps {
  loadPoolState: () => Promise<PoolState>;
  fairPrice: () => Promise<FairPrice | null>;
}

export function buildCurve(state: PoolState, fair: FairPrice | null, zeroForOne: boolean): CurveResponse {
  const priceE18 = fair?.priceE18 ?? sqrtX96ToPriceE18(state.sqrtPriceX96);
  const points = CURVE_SIZES_USD.map((usd): CurvePoint => {
    const usdE6 = BigInt(usd) * 1_000_000n;
    const amountIn = zeroForOne ? (usdE6 * 10n ** 30n) / priceE18 : usdE6;
    const v = evaluate({ state, zeroForOne, amountIn, fair, policy: DEFAULT_POLICY });
    return {
      usd,
      amountIn,
      verdict: v.verdict,
      feeBps: v.metrics.feeBps,
      impactBps: v.metrics.impactBps,
      adverseDevBps: v.metrics.adverseDevBps,
      totalCostBps: v.metrics.totalCostBps,
    };
  });
  return {
    zeroForOne,
    reference: fair ? "cex" : "dex-spot",
    policy: { maxImpactBps: DEFAULT_POLICY.maxImpactBps, maxDevBps: DEFAULT_POLICY.maxDevBps },
    points,
  };
}

let deps: CurveDeps | undefined;

function defaultDeps(): CurveDeps {
  if (deps) return deps;
  const client = createPublicClient({
    transport: http(process.env.HSK_RPC_URL?.trim() || "https://mainnet.hsk.xyz", { timeout: 15_000 }),
  }) as PublicClient;
  let cache: { at: number; state: Promise<PoolState> } | undefined;
  deps = {
    loadPoolState: () => {
      const t = Date.now();
      if (!cache || t - cache.at >= 5_000) {
        const entry = { at: t, state: fetchPoolState(client, { tries: 3, initialDelayMs: 300 }) };
        cache = entry;
        entry.state.catch(() => {
          if (cache === entry) cache = undefined;
        });
      }
      return cache.state;
    },
    fairPrice: createFairPriceSource(),
  };
  return deps;
}

export async function costCurve(zeroForOne: boolean, d: CurveDeps = defaultDeps()): Promise<CurveResponse> {
  const [state, fair] = await Promise.all([d.loadPoolState(), d.fairPrice().catch(() => null)]);
  return buildCurve(state, fair, zeroForOne);
}
