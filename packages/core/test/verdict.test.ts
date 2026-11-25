import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sqrtBigInt, sqrtX96ToPriceE18 } from "../src/cex.ts";
import { parsePoolStateJson, simulateSwap } from "../src/pool.ts";
import {
  attestableFair,
  DEFAULT_POLICY,
  deviationBps,
  evaluate,
  failedRouterChecks,
  signedDeviationBps,
} from "../src/verdict.ts";

const state = parsePoolStateJson(
  readFileSync(fileURLToPath(new URL("../fixtures/pool_state.json", import.meta.url)), "utf8"),
);
const USDT = (n: number) => BigInt(n) * 10n ** 6n;

/** sqrtPrice whose price is shifted by `bps` (signed). */
function shift(sqrt: bigint, bps: number): bigint {
  return (sqrt * sqrtBigInt(BigInt(10_000 + bps) * 10n ** 32n)) / 10n ** 18n;
}
const fairAt = (bps: number) => {
  const s = shift(state.sqrtPriceX96, bps);
  return { sqrtPriceX96: s, priceE18: sqrtX96ToPriceE18(s) };
};

describe("deviationBps (PriceMath port)", () => {
  it("is signed and symmetric in magnitude", () => {
    const up = shift(state.sqrtPriceX96, 80);
    expect(deviationBps(up, state.sqrtPriceX96)).toBe(79); // floor, like Solidity
    expect(signedDeviationBps(up, state.sqrtPriceX96)).toBeGreaterThan(0);
    expect(signedDeviationBps(state.sqrtPriceX96, up)).toBeLessThan(0);
  });
});

describe("evaluate", () => {
  it("50 USDT at fair = spot → DEX", () => {
    const v = evaluate({ state, zeroForOne: false, amountIn: USDT(50), fair: fairAt(0) });
    expect(v.verdict).toBe("DEX");
    expect(v.executable).toBe(true);
    expect(v.metrics.impactBps).toBe(2); // 1.2 bps rounded up like PriceMath
    expect(v.metrics.feeBps).toBe(30);
    expect(v.metrics.totalCostBps).toBe(32);
    expect(v.metrics.devBps).toBe(0);
    expect(v.metrics.suggestedMaxAmountIn).toBeNull();
    expect(v.metrics.amountOut).toBeGreaterThanOrEqual(v.metrics.minAmountOut);
  });

  it("20k USDT → CEX with a size that passes every router check", () => {
    const v = evaluate({ state, zeroForOne: false, amountIn: USDT(20_000), fair: fairAt(0) });
    expect(v.verdict).toBe("CEX");
    expect(v.executable).toBe(false);
    expect(v.metrics.impactBps).toBeGreaterThan(400);
    expect(v.reason).not.toMatch(/pecah|split/i);
    const max = v.metrics.suggestedMaxAmountIn!;
    expect(max).toBeGreaterThan(USDT(1_000));
    expect(max).toBeLessThan(USDT(4_300));
    const ok = simulateSwap(state, false, max);
    expect(failedRouterChecks(state, ok, false, max, state.sqrtPriceX96, DEFAULT_POLICY)).toEqual([]);
    const tooBig = max + USDT(50);
    expect(
      failedRouterChecks(state, simulateSwap(state, false, tooBig), false, tooBig, state.sqrtPriceX96, DEFAULT_POLICY),
    ).not.toEqual([]);
  });

  it("mid-size above the agent's policy → KECILKAN", () => {
    const policy = { maxImpactBps: 30, maxDevBps: 200, maxAge: 120 };
    const v = evaluate({ state, zeroForOne: false, amountIn: USDT(3_000), fair: fairAt(0), policy });
    expect(v.verdict).toBe("KECILKAN");
    expect(v.failedChecks).toContain("IMPACT");
    const max = v.metrics.suggestedMaxAmountIn!;
    expect(simulateSwap(state, false, max).impactBpsCeil).toBeLessThanOrEqual(30);
    expect(Number(max) / 1e6).toBeGreaterThan(1_200); // REPORT: ≈$1,262 → 30 bps
  });

  it("stale CEX → NO_REFERENCE, impact still computed against DEX spot", () => {
    const v = evaluate({ state, zeroForOne: false, amountIn: USDT(50), fair: null });
    expect(v.verdict).toBe("NO_REFERENCE");
    expect(v.metrics.impactBps).toBe(2);
    expect(v.metrics.fairSource).toBe("dex-spot");
    // Re-audit A: DEX spot is never reported as the fair price, and nothing is attestable.
    expect(v.metrics.fairSqrtPriceX96).toBeNull();
    expect(attestableFair(v)).toBeNull();
  });

  it("attestableFair: only executable DEX verdicts with a CEX reference", () => {
    const fair = fairAt(0);
    const dex = evaluate({ state, zeroForOne: false, amountIn: USDT(50), fair });
    expect(dex.verdict).toBe("DEX");
    expect(attestableFair(dex)).toBe(fair.sqrtPriceX96);
    const cex = evaluate({ state, zeroForOne: false, amountIn: USDT(20_000), fair });
    expect(cex.verdict).not.toBe("DEX");
    expect(attestableFair(cex)).toBeNull();
    const tunda = evaluate({ state, zeroForOne: false, amountIn: USDT(50), fair: fairAt(-80) });
    expect(tunda.verdict).toBe("TUNDA");
    expect(attestableFair(tunda)).toBeNull();
  });

  it("DEX above CEX → TUNDA for buyers, fine for sellers", () => {
    const fair = fairAt(-80); // CEX 0.8% below DEX
    const buy = evaluate({ state, zeroForOne: false, amountIn: USDT(50), fair });
    expect(buy.verdict).toBe("TUNDA");
    expect(buy.metrics.adverseDevBps).toBeGreaterThan(50);
    const sell = evaluate({ state, zeroForOne: true, amountIn: 600n * 10n ** 18n, fair });
    expect(sell.verdict).toBe("DEX");
    expect(sell.metrics.adverseDevBps).toBe(0);
  });

  it("spot beyond maxDevBps → TUNDA and not executable (guard would revert)", () => {
    const v = evaluate({ state, zeroForOne: true, amountIn: 600n * 10n ** 18n, fair: fairAt(-300) });
    expect(v.verdict).toBe("TUNDA");
    expect(v.executable).toBe(false);
  });

  it("OUT_OF_RANGE and PRICE_LIMIT are rejected (review #8)", () => {
    const v = evaluate({ state, zeroForOne: false, amountIn: 10n ** 14n, fair: fairAt(0) });
    expect(v.verdict).toBe("OUT_OF_RANGE");
    expect(v.executable).toBe(false);
    expect(v.metrics.impactBps).toBeNull();
    expect(v.metrics.totalCostBps).toBeNull();
  });
});
