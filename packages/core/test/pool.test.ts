import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeSwapLog,
  parsePoolStateJson,
  simulateSwap,
  simulateSwapExactOut,
  withRetry,
  type PoolState,
  type RawLog,
  type SwapEvent,
} from "../src/pool.ts";
import { Q96 } from "../src/v3math.ts";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
const state = parsePoolStateJson(fixture("pool_state.json"));

/** USDT per WHSK at the fixture spot price (float only for test sizing). */
const spotPrice = (Number(state.sqrtPriceX96) / Number(Q96)) ** 2 * 1e12;

function whskFor(usd: number): bigint {
  return BigInt(Math.round((usd / spotPrice) * 1e6)) * 10n ** 12n;
}

describe("parsePoolStateJson", () => {
  it("keeps full precision for big integers", () => {
    expect(state.sqrtPriceX96).toBe(22523105442617287490681n);
    expect(state.liquidity).toBe(1475813786831558685n);
    expect(state.tick).toBe(-301482);
    expect(state.ticks.size).toBe(6);
    expect(state.scannedWords).toEqual([-24, -16]);
  });
});

describe("simulateSwap vs REPORT.md (fixture tick map)", () => {
  // REPORT.md: cost excluding LP fee — $10k at once ≈233 bps, ≈30 bps threshold at $1,262 (both sides).
  it.each([
    ["sell WHSK", true, 10_000, 233],
    ["buy WHSK", false, 10_000, 233],
    ["sell WHSK", true, 1_262, 30],
    ["buy WHSK", false, 1_262, 30],
    ["sell WHSK", true, 50_000, 1065],
  ])("%s $%d ≈ %d bps", (_label, zeroForOne, usd, expected) => {
    const amountIn = zeroForOne ? whskFor(usd) : BigInt(usd) * 10n ** 6n;
    const r = simulateSwap(state, zeroForOne, amountIn);
    expect(r.status).toBe("OK");
    expect(r.amountIn).toBe(amountIn);
    console.info(`[report] ${_label} $${usd}: impact ${r.impactBps} bps (REPORT ${expected}), move ${r.priceMoveBps} bps`);
    // REPORT feeds the gross amount as if net of fee; we deduct 0.3% first, so allow ~1% relative + 1 bps.
    expect(Math.abs(r.impactBps - expected)).toBeLessThanOrEqual(expected * 0.01 + 1);
  });

  it("is monotonic and integer-consistent", () => {
    const small = simulateSwap(state, false, 50n * 10n ** 6n);
    const big = simulateSwap(state, false, 20_000n * 10n ** 6n);
    // $50 vs ≈$419.5k virtual USDT reserve: cost ≈ 50/419.5k ≈ 1.2 bps, price move ≈ 2x
    expect(small.impactBps).toBeGreaterThan(1);
    expect(small.impactBps).toBeLessThan(1.5);
    expect(small.priceMoveBps).toBeCloseTo(small.impactBps * 2, 0);
    expect(big.impactBps).toBeGreaterThan(small.impactBps);
    expect(big.sqrtPriceAfterX96).toBeGreaterThan(state.sqrtPriceX96);
    expect(big.feeAmount).toBeGreaterThanOrEqual((20_000n * 10n ** 6n * 3n) / 1000n);
    expect(big.priceAfterX96).toBe((big.sqrtPriceAfterX96 * big.sqrtPriceAfterX96) / Q96);
  });

  it("returns OUT_OF_RANGE beyond the scanned tick-bitmap words", () => {
    const r = simulateSwap(state, false, 10n ** 14n); // $100M of USDT walks past word -16 (tick > -230401)
    expect(r.status).toBe("OUT_OF_RANGE");
    // Review #8: a partial simulation must never report a small impact.
    expect(r.impactBps).toBe(Number.POSITIVE_INFINITY);
    expect(r.impactBpsCeil).toBe(Number.POSITIVE_INFINITY);
    const narrow: PoolState = { ...state, scannedWords: [-19, -19] };
    expect(simulateSwap(narrow, true, whskFor(1_000)).status).toBe("OUT_OF_RANGE");
  });

  it("treats dust as unknown impact (PriceMath: ideal == 0 → max)", () => {
    const r = simulateSwap(state, false, 1n);
    expect(r.impactBpsCeil).toBe(Number.POSITIVE_INFINITY);
  });

  it("impactBpsCeil rounds up like PriceMath.impactBps", () => {
    const r = simulateSwap(state, false, 1_262n * 10n ** 6n);
    expect(r.impactBpsCeil).toBe(Math.ceil(r.impactBps));
    expect(Number.isInteger(r.impactBpsCeil)).toBe(true);
  });
});

describe("replay of on-chain swap logs", () => {
  const logs = JSON.parse(fixture("swap_logs.json")) as RawLog[];
  const seen = new Set<string>();
  const events: SwapEvent[] = [];
  for (const lg of logs) {
    const key = `${lg.transactionHash}:${lg.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(decodeSwapLog(lg));
  }
  events.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));

  it("reproduces sqrtPriceX96 after each swap from the previous swap's state", () => {
    let exactIn = 0;
    let exactOut = 0;
    let compared = 0;
    let crossing = 0;
    let crossingMatched = 0;
    let maxRelErrExactIn = 0;
    const matches = (s: PoolState, zeroForOne: boolean, amountIn: bigint, amountOut: bigint, after: bigint) => {
      const a = simulateSwap(s, zeroForOne, amountIn);
      if (a.status === "OK" && a.sqrtPriceAfterX96 === after && a.amountOut === amountOut) return true;
      const b = simulateSwapExactOut(s, zeroForOne, amountOut);
      return b.status === "OK" && b.sqrtPriceAfterX96 === after && b.amountIn === amountIn;
    };
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1]!;
      const cur = events[i]!;
      const zeroForOne = cur.amount0 > 0n;
      const amountIn = zeroForOne ? cur.amount0 : cur.amount1;
      const amountOut = -(zeroForOne ? cur.amount1 : cur.amount0);
      // Liquidity during the swap equals the post-swap liquidity unless a tick was crossed.
      const s: PoolState = { ...state, sqrtPriceX96: prev.sqrtPriceX96, tick: prev.tick, liquidity: cur.liquidity };
      const r = simulateSwap(s, zeroForOne, amountIn);
      if (r.ticksCrossed > 0 || r.status !== "OK") {
        // Tick-crossing swap: start from the previous swap's active liquidity and walk the cached tick map.
        crossing++;
        const sPrev: PoolState = { ...s, liquidity: prev.liquidity };
        if (matches(sPrev, zeroForOne, amountIn, amountOut, cur.sqrtPriceX96)) crossingMatched++;
        continue;
      }
      compared++;
      const diff = r.sqrtPriceAfterX96 - cur.sqrtPriceX96;
      const rel = Number(((diff < 0n ? -diff : diff) * 10n ** 18n) / cur.sqrtPriceX96) / 1e18;
      maxRelErrExactIn = Math.max(maxRelErrExactIn, rel);
      if (diff === 0n && r.amountOut === amountOut) {
        exactIn++;
        continue;
      }
      // The log does not say whether the swap was exact-in or exact-out; try the latter.
      const o = simulateSwapExactOut(s, zeroForOne, amountOut);
      if (o.sqrtPriceAfterX96 === cur.sqrtPriceX96 && o.amountIn === amountIn) exactOut++;
    }
    const matched = exactIn + exactOut;
    const pct = (matched / compared) * 100;
    console.info(
      `[replay] swaps=${events.length} compared(no crossing)=${compared} exactMatch=${matched} (${pct.toFixed(2)}%): ` +
        `pure exact-in ${exactIn} (${((exactIn / compared) * 100).toFixed(2)}%), ` +
        `needed exact-out fallback ${exactOut} (${((exactOut / compared) * 100).toFixed(2)}%); ` +
        `tick-crossing ${crossingMatched}/${crossing} matched; ` +
        `maxRelErr(sqrtPrice, exact-in model)=${maxRelErrExactIn.toExponential(3)}`,
    );
    expect(compared).toBeGreaterThan(2000);
    expect(pct).toBeGreaterThanOrEqual(99);
    expect(exactIn).toBeGreaterThan(1500);
    expect(maxRelErrExactIn).toBeLessThan(1e-9);
  });
});

describe("withRetry", () => {
  it("retries 429 with doubling delay, then succeeds", async () => {
    const delays: number[] = [];
    let calls = 0;
    const v = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error("rate limited"), { status: 429 });
        return 7;
      },
      { initialDelayMs: 10, sleep: async (ms) => void delays.push(ms) },
    );
    expect(v).toBe(7);
    expect(delays).toEqual([10, 20]);
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw Object.assign(new Error("bad request"), { status: 400 });
      }),
    ).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });
});
